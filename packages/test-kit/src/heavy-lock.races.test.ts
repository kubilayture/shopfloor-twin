// Races of the heavy lock's queue and staging (#350) that need a step of another process between
// two file-system calls of one: `node:fs` is wrapped so a test can run that step at an exact point.
// Every test works under a temporary directory, never the real ~/.cache/shopfloor-twin.
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HeavyLockTimeoutError,
  acquireHeavyLock,
  queuePath,
  readHolder,
  readQueue,
  readTicket,
  removeOldDrafts,
  removeOldStaging,
  removeTicket,
  retakeTicket,
  takeTicket,
  tryTakeLock,
  type HeavyLockHolder,
  type QueueTicket,
} from './heavy-lock.ts';

type Op = 'readFileSync' | 'renameSync' | 'writeFileSync' | 'rmSync';
/** One step to run before or after the next call of `op` whose arguments `when` accepts. */
interface Hook {
  readonly op: Op;
  readonly at: 'before' | 'after';
  readonly when: (args: readonly unknown[]) => boolean;
  readonly run: (args: readonly unknown[]) => void;
}

const hooks = vi.hoisted(() => ({ armed: [] as Hook[] }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  const fire = (op: Op, at: 'before' | 'after', args: unknown[]) => {
    const index = hooks.armed.findIndex(
      (hook) => hook.op === op && hook.at === at && hook.when(args),
    );
    if (index < 0) return;
    const [hook] = hooks.armed.splice(index, 1); // each hook fires once
    hook?.run(args);
  };
  const wrap =
    <F extends (...args: never[]) => unknown>(op: Op, f: F) =>
    (...args: Parameters<F>): ReturnType<F> => {
      fire(op, 'before', args);
      const result = f(...args) as ReturnType<F>;
      fire(op, 'after', args);
      return result;
    };
  const wrapped = {
    ...real,
    readFileSync: wrap('readFileSync', real.readFileSync),
    renameSync: wrap('renameSync', real.renameSync),
    writeFileSync: wrap('writeFileSync', real.writeFileSync),
    rmSync: wrap('rmSync', real.rmSync),
  };
  return { ...wrapped, default: wrapped };
});

let dir: string;
let lockPath: string;
const queue = () => queuePath(lockPath);
const logs: string[] = [];
const log = (message: string) => {
  logs.push(message);
};
const ticket = (pid: number, token: string): QueueTicket => ({
  pid,
  command: `wait-${String(pid)}`,
  since: '2026-10-29T08:00:00.000Z',
  token,
});
const holder = (pid: number, token: string): HeavyLockHolder => ({
  pid,
  command: `cmd-${String(pid)}`,
  startedAt: '2026-10-29T08:00:00.000Z',
  token,
});
const backdate = (path: string, ms: number) => {
  const at = new Date(Date.now() - ms);
  fs.utimesSync(path, at, at);
};
const leftovers = () => fs.readdirSync(queue()).filter((name) => !name.startsWith('ticket-'));

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'heavy-lock-races-'));
  lockPath = join(dir, 'cache', 'heavy.lock');
  logs.length = 0;
  hooks.armed.length = 0;
});
afterEach(() => {
  const unfired = hooks.armed.length;
  hooks.armed.length = 0;
  fs.rmSync(dir, { recursive: true, force: true });
  expect(unfired, 'every armed step ran at its point').toBe(0);
});

describe('removeTicket races (#350)', () => {
  it('never removes a ticket its owner made again right after the remover first looked at it', () => {
    const owner = ticket(process.pid, 'owner');
    const name = takeTicket(queue(), owner);
    const seen = readTicket(queue(), name);
    const path = join(queue(), name);
    // Right after the remover's first look at `name` (whatever call that is), another waiter
    // removes the ticket if it is still there and its owner makes it again.
    for (const op of ['readFileSync', 'renameSync'] as const) {
      hooks.armed.push({
        op,
        at: 'after',
        when: (args) => args[0] === path,
        run: () => {
          hooks.armed.length = 0;
          if (fs.existsSync(path)) fs.unlinkSync(path);
          expect(retakeTicket(queue(), name, owner)).toBe(true);
        },
      });
    }
    expect(removeTicket(queue(), name, 'owner', seen?.nonce)).toBe(true); // the one judged
    const now = readTicket(queue(), name);
    expect(now?.token).toBe('owner'); // the owner's new ticket stays
    expect(now?.nonce).not.toBe(seen?.nonce);
    expect(leftovers()).toEqual([]);
  });

  it('drops the ticket it moved aside when its name was taken meanwhile, without failing', () => {
    const owner = ticket(process.pid, 'owner');
    const name = takeTicket(queue(), owner);
    const path = join(queue(), name);
    hooks.armed.push({
      op: 'renameSync',
      at: 'after',
      when: (args) => args[0] === path,
      run: () => {
        expect(retakeTicket(queue(), name, owner)).toBe(true); // the name is taken again
      },
    });
    const fresh = () => readTicket(queue(), name)?.nonce;
    // Judged under an older nonce: not the one seen, so put back, but the name is taken.
    expect(removeTicket(queue(), name, 'owner', 'an-older-nonce')).toBe(false);
    expect(fresh()).toMatch(/^[0-9a-f]{16}$/);
    expect(leftovers()).toEqual([]);
  });

  it('gives up without failing when the ticket moved aside is gone before it is put back', () => {
    const name = takeTicket(queue(), ticket(process.pid, 'owner'));
    const path = join(queue(), name);
    hooks.armed.push({
      op: 'renameSync',
      at: 'after',
      when: (args) => args[0] === path,
      run: (args) => {
        fs.unlinkSync(String(args[1])); // removed by someone else
      },
    });
    expect(removeTicket(queue(), name, 'owner', 'an-older-nonce')).toBe(false);
    expect(readQueue(queue())).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('is not undone by another waiter sweeping old drafts while the stale ticket is aside', () => {
    const name = takeTicket(queue(), ticket(process.pid, 'owner'));
    const path = join(queue(), name);
    backdate(path, 120_000); // judged stale: over a minute without a heartbeat
    const seen = readTicket(queue(), name);
    hooks.armed.push({
      op: 'renameSync',
      at: 'after',
      when: (args) => args[0] === path,
      run: () => {
        removeOldDrafts(queue()); // another waiter's poll
      },
    });
    expect(removeTicket(queue(), name, 'owner', seen?.nonce)).toBe(true);
    expect(fs.readdirSync(queue())).toEqual([]);
  });

  it('keeps its own ticket and place when a remover put it back while it was taking it again', async () => {
    tryTakeLock(lockPath, holder(process.pid, 't-holder'));
    const waiting = acquireHeavyLock({
      lockPath,
      command: 'x',
      env: {},
      timeoutMs: 200,
      pollMs: 5,
      log,
    });
    const caught = waiting.catch((error: unknown) => error);
    while (!logs.some((line) => line.includes('place 1 of 1'))) {
      await new Promise((done) => setTimeout(done, 2));
    }
    const own = join(queue(), 'ticket-000000000001');
    // Its next look at its ticket finds nothing (another waiter has it aside); by its re-take
    // the ticket is back under its name.
    hooks.armed.push({
      op: 'readFileSync',
      at: 'before',
      when: (args) => args[0] === own,
      run: () => {
        throw Object.assign(new Error('ENOENT: aside'), { code: 'ENOENT' });
      },
    });
    while (hooks.armed.length > 0) await new Promise((done) => setTimeout(done, 2));
    await new Promise((done) => setTimeout(done, 30));
    expect(readQueue(queue()).map((entry) => entry.name)).toEqual(['ticket-000000000001']);
    expect(logs.filter((line) => line.includes('queued again'))).toEqual([]);
    expect(await caught).toBeInstanceOf(HeavyLockTimeoutError);
  });
});

describe('the staging sweep against a stopped tryTakeLock (#350)', () => {
  const later = () => Date.now() + 61_000; // the owner stood still for over a minute

  it('makes the stopped owner say false, not fail, when its staging directory went before its write', () => {
    hooks.armed.push({
      op: 'writeFileSync',
      at: 'before',
      when: (args) => String(args[0]).startsWith(`${lockPath}.`),
      run: () => {
        removeOldStaging(lockPath, later());
      },
    });
    expect(tryTakeLock(lockPath, holder(process.pid, 't-a'))).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(join(dir, 'cache'))).toEqual([]);
  });

  it('makes the stopped owner say false, not fail, when its staging directory went before its rename', () => {
    hooks.armed.push({
      op: 'renameSync',
      at: 'before',
      when: (args) => args[1] === lockPath,
      run: () => {
        removeOldStaging(lockPath, later());
      },
    });
    expect(tryTakeLock(lockPath, holder(process.pid, 't-a'))).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(join(dir, 'cache'))).toEqual([]);
  });

  it('never lets the owner move a half-deleted staging directory into place as the lock', () => {
    fs.mkdirSync(join(dir, 'cache'), { recursive: true });
    const staging = `${lockPath}.123.abcdef012345.tmp`;
    fs.mkdirSync(staging);
    fs.writeFileSync(join(staging, 'holder.json'), JSON.stringify(holder(process.pid, 't-a')));
    backdate(staging, 61_000);
    let ownerRename: unknown = 'not run';
    // The sweep's delete has removed holder.json and not yet the directory when the stopped
    // owner resumes and renames its staging directory onto the lock.
    hooks.armed.push({
      op: 'rmSync',
      at: 'before',
      when: (args) => fs.existsSync(join(String(args[0]), 'holder.json')),
      run: (args) => {
        fs.unlinkSync(join(String(args[0]), 'holder.json'));
        try {
          fs.renameSync(staging, lockPath);
          ownerRename = 'renamed';
        } catch (error) {
          ownerRename = (error as NodeJS.ErrnoException).code;
        }
      },
    });
    removeOldStaging(lockPath);
    expect(ownerRename).toBe('ENOENT');
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(join(dir, 'cache'))).toEqual([]);
  });

  it('says false when the lock it renamed into place names another token', () => {
    hooks.armed.push({
      op: 'renameSync',
      at: 'after',
      when: (args) => args[1] === lockPath,
      run: () => {
        fs.writeFileSync(join(lockPath, 'holder.json'), JSON.stringify(holder(1, 't-other')));
      },
    });
    expect(tryTakeLock(lockPath, holder(process.pid, 't-a'))).toBe(false);
    expect(readHolder(lockPath)?.token).toBe('t-other');
  });
});
