import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HEAVY_LOCK_TIMEOUT_MS,
  HEAVY_LOCK_ENV,
  HEAVY_LOCK_PATH,
  HEAD_POLL_MS,
  HeavyLockTimeoutError,
  TICKET_STALE_MS,
  MIN_DOCKER_FREE_BYTES,
  MIN_HOST_FREE_BYTES,
  acquireHeavyLock,
  bootTime,
  breakStaleLock,
  compareStarts,
  differentBoot,
  diskProbeImage,
  dockerProbeProblem,
  fakeProbe,
  holderLiveness,
  diskProblems,
  lockTimeoutMs,
  parseDfAvailableBytes,
  parseProcessStart,
  processLiveness,
  processStartTime,
  queuePath,
  queuePlace,
  readGroups,
  readHolder,
  readQueue,
  readTicket,
  recordGroup,
  releaseLock,
  removeOldDrafts,
  removeTicket,
  retakeTicket,
  takeTicket,
  ticketLiveness,
  ticketName,
  touchTicket,
  tryTakeLock,
  type HeavyLockHolder,
  type LockProbe,
  type QueueEntry,
  type QueueTicket,
} from './heavy-lock.ts';

// Every test works on a lock of its own under a temporary directory: the real lock at
// ~/.cache/shopfloor-twin/heavy.lock is held by the gate or `verify` that runs these tests.
let dir: string;
let lockPath: string;
const logs: string[] = [];
const log = (message: string) => {
  logs.push(message);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'heavy-lock-test-'));
  lockPath = join(dir, 'cache', 'heavy.lock');
  logs.length = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const holder = (pid: number, token = `t-${String(pid)}`): HeavyLockHolder => ({
  pid,
  command: `cmd-${String(pid)}`,
  startedAt: '2026-10-18T10:00:00.000Z',
  token,
});
const errno = (code: string) => Object.assign(new Error(code), { code });
/** Every process alive (no real processes involved). */
const allAlive: LockProbe = fakeProbe({}, { pid: () => 'alive' });
/** Every process and group dead. */
const allDead: LockProbe = fakeProbe();

describe('processLiveness (#228): stale only on ESRCH', () => {
  it('is alive when kill(pid, 0) succeeds', () => {
    expect(processLiveness(42, () => true)).toBe('alive');
  });
  it('is dead on ESRCH', () => {
    expect(
      processLiveness(42, () => {
        throw errno('ESRCH');
      }),
    ).toBe('dead');
  });
  it('is alive on EPERM (another user holds it) and on any other error', () => {
    for (const code of ['EPERM', 'EINVAL', 'EIO']) {
      expect(
        processLiveness(42, () => {
          throw errno(code);
        }),
      ).toBe('alive');
    }
  });
  it('sees this process alive and an exited child dead', async () => {
    expect(processLiveness(process.pid)).toBe('alive');
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid;
    await new Promise((done) => child.on('exit', done));
    expect(pid).toBeDefined();
    expect(processLiveness(pid ?? 0)).toBe('dead');
  });
});

describe('the lock directory (#228)', () => {
  it('lives at the fixed path under the home directory, not the temporary directory', () => {
    expect(HEAVY_LOCK_PATH).toBe(
      join(userInfo().homedir, '.cache', 'shopfloor-twin', 'heavy.lock'),
    );
    expect(HEAVY_LOCK_PATH.startsWith(tmpdir())).toBe(false);
  });

  it('is taken once, with its holder readable, and refused while taken', () => {
    expect(tryTakeLock(lockPath, holder(10))).toBe(true);
    expect(readHolder(lockPath)).toEqual(holder(10));
    expect(tryTakeLock(lockPath, holder(11))).toBe(false);
    expect(readHolder(lockPath)).toEqual(holder(10));
  });

  it('leaves no staging directory behind', () => {
    tryTakeLock(lockPath, holder(10));
    tryTakeLock(lockPath, holder(11));
    expect(readdirSync(join(dir, 'cache'))).toEqual(['heavy.lock']);
    expect(readdirSync(lockPath)).toEqual(['holder.json']);
  });

  it('is released only by its own token', () => {
    tryTakeLock(lockPath, holder(10));
    expect(releaseLock(lockPath, 't-other')).toBe(false);
    expect(readHolder(lockPath)?.token).toBe('t-10');
    expect(releaseLock(lockPath, 't-10')).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(releaseLock(lockPath, 't-10')).toBe(false);
  });

  it('reads no holder from a corrupt or incomplete holder file', () => {
    tryTakeLock(lockPath, holder(10));
    writeFileSync(join(lockPath, 'holder.json'), '{"pid": "x"');
    expect(readHolder(lockPath)).toBeUndefined();
    writeFileSync(join(lockPath, 'holder.json'), JSON.stringify({ pid: 3, command: 'c' }));
    expect(readHolder(lockPath)).toBeUndefined();
  });
});

describe('acquireHeavyLock (#228)', () => {
  it('takes a free lock, records pid, command, start, boot and process start, and releases it', async () => {
    const lock = await acquireHeavyLock({
      lockPath,
      command: 'pnpm gate',
      env: {},
      log,
      probe: fakeProbe({}, { boot: () => '1791650654', processStart: () => 'Sun Oct 18' }),
      now: () => Date.parse('2026-10-18T09:00:00Z'),
    });
    expect(lock.inherited).toBe(false);
    expect(readHolder(lockPath)).toEqual({
      pid: process.pid,
      command: 'pnpm gate',
      startedAt: '2026-10-18T09:00:00.000Z',
      token: lock.holder.token,
      boot: '1791650654',
      processStart: 'Sun Oct 18',
    });
    expect(lock.env).toEqual({ [HEAVY_LOCK_ENV]: lock.holder.token });
    lock.release();
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("lets a holder's child inherit the lock through SHOPFLOOR_HEAVY_LOCK without waiting", async () => {
    const parent = await acquireHeavyLock({ lockPath, command: 'pnpm gate', env: {}, log });
    const child = await acquireHeavyLock({
      lockPath,
      command: 'pnpm verify',
      env: { ...parent.env },
      timeoutMs: 0,
      log,
    });
    expect(child.inherited).toBe(true);
    expect(child.holder.token).toBe(parent.holder.token);
    child.release();
    expect(readHolder(lockPath)?.token).toBe(parent.holder.token);
    parent.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('takes the lock afresh when SHOPFLOOR_HEAVY_LOCK names no current lock', async () => {
    const lock = await acquireHeavyLock({
      lockPath,
      command: 'pnpm verify',
      env: { [HEAVY_LOCK_ENV]: 'gone-token' },
      log,
    });
    expect(lock.inherited).toBe(false);
    expect(logs.some((line) => line.includes('names no current lock'))).toBe(true);
    lock.release();
  });

  it('does not inherit a lock held under another token', async () => {
    tryTakeLock(lockPath, holder(77));
    await expect(
      acquireHeavyLock({
        lockPath,
        command: 'pnpm verify',
        env: { [HEAVY_LOCK_ENV]: 't-other' },
        timeoutMs: 30,
        pollMs: 5,
        probe: allAlive,
        log,
      }),
    ).rejects.toBeInstanceOf(HeavyLockTimeoutError);
  });

  it('waits for a live holder, prints it once, and takes the lock when it is released', async () => {
    tryTakeLock(lockPath, holder(77));
    setTimeout(() => releaseLock(lockPath, 't-77'), 60);
    const lock = await acquireHeavyLock({
      lockPath,
      command: 'pnpm test:e2e',
      env: {},
      pollMs: 5,
      probe: allAlive,
      log,
    });
    expect(lock.inherited).toBe(false);
    const waits = logs.filter((line) => line.includes('waiting for cmd-77 (pid 77, since'));
    expect(waits).toHaveLength(1);
    lock.release();
  });

  it('fails after the timeout, naming the holder', async () => {
    tryTakeLock(lockPath, holder(77));
    const error: unknown = await acquireHeavyLock({
      lockPath,
      command: 'pnpm test:e2e',
      env: {},
      timeoutMs: 40,
      pollMs: 5,
      probe: allAlive,
      log,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HeavyLockTimeoutError);
    expect((error as Error).message).toContain('cmd-77 (pid 77');
    expect(readHolder(lockPath)?.token).toBe('t-77');
  });

  it('reads the timeout from HEAVY_LOCK_TIMEOUT_MS', async () => {
    tryTakeLock(lockPath, holder(77));
    const error: unknown = await acquireHeavyLock({
      lockPath,
      command: 'x',
      env: { HEAVY_LOCK_TIMEOUT_MS: '25' },
      pollMs: 5,
      probe: allAlive,
      log,
    }).catch((e: unknown) => e);
    expect((error as HeavyLockTimeoutError).timeoutMs).toBe(25);
  });

  it('breaks the lock of a dead holder (ESRCH) and takes it', async () => {
    tryTakeLock(lockPath, holder(66));
    const lock = await acquireHeavyLock({
      lockPath,
      command: 'pnpm gate',
      env: {},
      timeoutMs: 1_000,
      pollMs: 5,
      probe: allDead,
      log,
    });
    expect(readHolder(lockPath)?.token).toBe(lock.holder.token);
    expect(logs.some((line) => line.includes('stale lock of cmd-66'))).toBe(true);
    lock.release();
  });

  it('never breaks the lock of a holder that answers EPERM', async () => {
    tryTakeLock(lockPath, holder(55));
    const eperm = fakeProbe(
      {},
      {
        pid: (pid) =>
          processLiveness(pid, () => {
            throw errno('EPERM');
          }),
      },
    );
    await expect(
      acquireHeavyLock({
        lockPath,
        command: 'pnpm gate',
        env: {},
        timeoutMs: 30,
        pollMs: 5,
        probe: eperm,
        log,
      }),
    ).rejects.toBeInstanceOf(HeavyLockTimeoutError);
    expect(readHolder(lockPath)?.token).toBe('t-55');
  });

  it('breaks a real dead process’s lock: an exited child’s PID', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid ?? 0;
    await new Promise((done) => child.on('exit', done));
    tryTakeLock(lockPath, holder(pid));
    const lock = await acquireHeavyLock({ lockPath, command: 'x', env: {}, timeoutMs: 1_000, log });
    expect(lock.inherited).toBe(false);
    lock.release();
  });

  it('gives the lock to one of several waiters at a time', async () => {
    let inside = 0;
    let most = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map(async (n) => {
        const lock = await acquireHeavyLock({
          lockPath,
          command: `w${String(n)}`,
          env: {},
          pollMs: 3,
          timeoutMs: 10_000,
          log,
        });
        inside += 1;
        most = Math.max(most, inside);
        order.push(n);
        await sleep(15);
        inside -= 1;
        lock.release();
      }),
    );
    expect(most).toBe(1);
    expect(order.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('serializes separate processes', async () => {
    const module = resolve(import.meta.dirname, 'heavy-lock.ts');
    const trail = join(dir, 'trail.txt');
    writeFileSync(trail, '');
    const script = `
      import { appendFileSync } from 'node:fs';
      import { acquireHeavyLock } from ${JSON.stringify(module)};
      const lock = await acquireHeavyLock({ lockPath: process.argv[1], command: 'p', env: {}, pollMs: 5, log: () => {} });
      appendFileSync(process.argv[2], 'in ' + process.pid + '\\n');
      await new Promise((r) => setTimeout(r, 40));
      appendFileSync(process.argv[2], 'out ' + process.pid + '\\n');
      lock.release();
    `;
    const codes = await Promise.all(
      [1, 2, 3, 4].map(
        () =>
          new Promise<number | null>((done) => {
            const child = spawn(
              process.execPath,
              ['--input-type=module', '-e', script, lockPath, trail],
              { stdio: 'inherit' },
            );
            child.on('exit', done);
          }),
      ),
    );
    expect(codes).toEqual([0, 0, 0, 0]);
    const lines = readFileSync(trail, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(8);
    for (let i = 0; i < lines.length; i += 2) {
      const pid = lines[i]?.split(' ')[1];
      expect(lines[i]).toBe(`in ${pid ?? ''}`);
      expect(lines[i + 1]).toBe(`out ${pid ?? ''}`);
    }
  }, 30_000);
});

describe('breakStaleLock (#228)', () => {
  it('leaves a lock that a new holder took after the stale one was read', () => {
    const stale = holder(66);
    tryTakeLock(lockPath, holder(67));
    expect(breakStaleLock(lockPath, stale, () => true, allDead.pid)).toBe(false);
    expect(readHolder(lockPath)?.token).toBe('t-67');
  });

  it('does nothing while another process holds the guard', () => {
    tryTakeLock(lockPath, holder(66));
    writeFileSync(`${lockPath}.break`, '12345');
    expect(breakStaleLock(lockPath, holder(66), () => true, allAlive.pid)).toBe(false);
    expect(readHolder(lockPath)?.token).toBe('t-66');
    expect(existsSync(`${lockPath}.break`)).toBe(true);
  });

  it('removes a guard left by a dead process, then breaks on the next attempt', () => {
    tryTakeLock(lockPath, holder(66));
    writeFileSync(`${lockPath}.break`, '12345');
    expect(breakStaleLock(lockPath, holder(66), () => true, allDead.pid)).toBe(false);
    expect(existsSync(`${lockPath}.break`)).toBe(false);
    expect(breakStaleLock(lockPath, holder(66), () => true, allDead.pid)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.break`)).toBe(false);
  });
});

describe('review of PR #248 (#228)', () => {
  it('returns false, not a crash, when the guard vanishes between the link and the read', () => {
    tryTakeLock(lockPath, holder(66));
    // A dangling symlink: the link fails with EEXIST, the read with ENOENT, deterministically.
    symlinkSync(join(dir, 'gone'), `${lockPath}.break`);
    expect(breakStaleLock(lockPath, holder(66), () => true, allDead.pid)).toBe(false);
    expect(readHolder(lockPath)?.token).toBe('t-66');
  });

  it('tolerates the guard being removed under it after a successful break', () => {
    tryTakeLock(lockPath, holder(66));
    const stillStale = () => {
      rmSync(`${lockPath}.break`, { force: true }); // another breaker's cleanup, say
      return true;
    };
    expect(breakStaleLock(lockPath, holder(66), stillStale, allDead.pid)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('polls (no busy spin) and honours the timeout while a live process holds the guard', async () => {
    tryTakeLock(lockPath, holder(66));
    writeFileSync(`${lockPath}.break`, String(process.pid));
    let calls = 0;
    const probe = fakeProbe(
      {},
      {
        pid: (pid) => {
          calls += 1;
          return pid === process.pid ? 'alive' : 'dead';
        },
      },
    );
    const started = Date.now();
    const error: unknown = await acquireHeavyLock({
      lockPath,
      command: 'x',
      env: {},
      timeoutMs: 150,
      pollMs: 25,
      probe,
      log,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HeavyLockTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
    // About 150 / 25 polls, two probe calls each; a spin makes thousands.
    expect(calls).toBeLessThan(40);
    expect(logs.filter((line) => line.includes('stale lock of cmd-66'))).toHaveLength(1);
    expect(readHolder(lockPath)?.token).toBe('t-66');
  });

  it('survives many processes breaking the same stale lock at once', async () => {
    const exited = spawn(process.execPath, ['-e', '']);
    const deadPid = exited.pid ?? 0;
    await new Promise((done) => exited.on('exit', done));
    tryTakeLock(lockPath, holder(deadPid));
    const module = resolve(import.meta.dirname, 'heavy-lock.ts');
    const trail = join(dir, 'trail.txt');
    writeFileSync(trail, '');
    const script = `
      import { appendFileSync } from 'node:fs';
      import { acquireHeavyLock } from ${JSON.stringify(module)};
      const lock = await acquireHeavyLock({ lockPath: process.argv[1], command: 'p', env: {}, pollMs: 5, timeoutMs: 60000, log: () => {} });
      appendFileSync(process.argv[2], 'in ' + process.pid + '\\n');
      await new Promise((r) => setTimeout(r, 5));
      appendFileSync(process.argv[2], 'out ' + process.pid + '\\n');
      lock.release();
    `;
    const codes = await Promise.all(
      Array.from(
        { length: 16 },
        () =>
          new Promise<number | null>((done) => {
            const child = spawn(
              process.execPath,
              ['--input-type=module', '-e', script, lockPath, trail],
              { stdio: 'inherit' },
            );
            child.on('exit', done);
          }),
      ),
    );
    expect(codes).toEqual(Array.from({ length: 16 }, () => 0));
    const lines = readFileSync(trail, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(32);
    for (let i = 0; i < lines.length; i += 2) {
      const pid = lines[i]?.split(' ')[1];
      expect(lines[i]).toBe(`in ${pid ?? ''}`);
      expect(lines[i + 1]).toBe(`out ${pid ?? ''}`);
    }
  }, 60_000);

  it('records process groups only under the holding token', () => {
    tryTakeLock(lockPath, holder(66));
    expect(recordGroup(lockPath, 't-other', 4242)).toBe(false);
    expect(recordGroup(lockPath, 't-66', 4242)).toBe(true);
    expect(recordGroup(lockPath, 't-66', 1)).toBe(false);
    expect(readGroups(lockPath)).toEqual([{ pgid: 4242, leaderStart: undefined }]);
  });

  it('keeps a lock alive while a recorded group runs after its holder died', async () => {
    tryTakeLock(lockPath, holder(66));
    recordGroup(lockPath, 't-66', 4242);
    expect(holderLiveness(lockPath, holder(66), fakeProbe({ groups: [4242] }))).toBe('alive');
    expect(holderLiveness(lockPath, holder(66), fakeProbe())).toBe('dead');
    await expect(
      acquireHeavyLock({
        lockPath,
        command: 'x',
        env: {},
        timeoutMs: 30,
        pollMs: 5,
        probe: fakeProbe({ groups: [4242] }),
        log,
      }),
    ).rejects.toBeInstanceOf(HeavyLockTimeoutError);
  });

  it('keeps the lock while a real detached group runs, and breaks it once the group is gone', async () => {
    const exited = spawn(process.execPath, ['-e', '']);
    const deadPid = exited.pid ?? 0;
    await new Promise((done) => exited.on('exit', done));
    const suite = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const pgid = suite.pid ?? 0;
    try {
      tryTakeLock(lockPath, holder(deadPid));
      recordGroup(lockPath, `t-${String(deadPid)}`, pgid);
      expect(holderLiveness(lockPath, holder(deadPid))).toBe('alive');
      process.kill(-pgid, 'SIGKILL');
      await new Promise((done) => suite.on('exit', done));
      expect(holderLiveness(lockPath, holder(deadPid))).toBe('dead');
      const lock = await acquireHeavyLock({
        lockPath,
        command: 'x',
        env: {},
        timeoutMs: 2_000,
        pollMs: 5,
        log,
      });
      expect(lock.inherited).toBe(false);
      lock.release();
    } finally {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        // gone already
      }
    }
  });

  it('counts an earlier boot only when start times are unknown and it is over 5 minutes off', () => {
    const old = { ...holder(66), boot: '1000' };
    tryTakeLock(lockPath, old);
    const at = (boot: string) => fakeProbe({ pids: [66] }, { boot: () => boot });
    expect(holderLiveness(lockPath, old, at('1301'))).toBe('dead');
    expect(holderLiveness(lockPath, old, at('1300'))).toBe('alive'); // a clock step, a jitter
    expect(holderLiveness(lockPath, old, at('999'))).toBe('alive');
    // A matching start time is conclusive, whatever the boot time says.
    const started = { ...old, processStart: 'Sun Oct 18 10:00:00 2026' };
    const same = fakeProbe(
      { pids: [66] },
      { boot: () => '99999', processStart: () => 'Sun Oct 18 10:00:00 2026' },
    );
    expect(holderLiveness(lockPath, started, same)).toBe('alive');
    expect(differentBoot('1000', undefined)).toBe(false);
    expect(differentBoot('x', '5000')).toBe(false);
  });

  it('counts a reused PID (another process start time) as dead', () => {
    const held = { ...holder(66), processStart: 'Sun Oct 18 10:00:00 2026' };
    tryTakeLock(lockPath, held);
    const same = fakeProbe({ pids: [66] }, { processStart: () => 'Sun Oct 18 10:00:00 2026' });
    const reused = fakeProbe({ pids: [66] }, { processStart: () => 'Sun Oct 18 11:30:00 2026' });
    expect(holderLiveness(lockPath, held, same)).toBe('alive');
    expect(holderLiveness(lockPath, held, reused)).toBe('dead');
  });

  it('waits for a lock directory without a valid holder, then breaks it after the grace', async () => {
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'holder.json'), '{"truncated');
    await expect(
      acquireHeavyLock({
        lockPath,
        command: 'x',
        env: {},
        timeoutMs: 30,
        pollMs: 5,
        noHolderGraceMs: 60_000,
        probe: allDead,
        log,
      }),
    ).rejects.toBeInstanceOf(HeavyLockTimeoutError);
    expect(logs.filter((line) => line.includes('no valid holder.json'))).toHaveLength(1);
    const lock = await acquireHeavyLock({
      lockPath,
      command: 'x',
      env: {},
      timeoutMs: 1_000,
      pollMs: 5,
      noHolderGraceMs: 0,
      probe: allDead,
      log,
    });
    expect(readHolder(lockPath)?.token).toBe(lock.holder.token);
    lock.release();
  });

  it('reads one start time whatever the locale and time zone of holder and waiter', async () => {
    const module = resolve(import.meta.dirname, 'heavy-lock.ts');
    // The holder: a Turkish-locale, Istanbul-time process that takes the lock and stays alive.
    const holderScript = `
      import { acquireHeavyLock } from ${JSON.stringify(module)};
      await acquireHeavyLock({ lockPath: process.argv[1], command: 'tr', env: {}, log: () => {} });
      process.stdout.write('held\\n');
      setTimeout(() => {}, 60000);
    `;
    const held = spawn(process.execPath, ['--input-type=module', '-e', holderScript, lockPath], {
      env: { ...process.env, LC_ALL: 'tr_TR.UTF-8', LANG: 'tr_TR.UTF-8', TZ: 'Europe/Istanbul' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      await new Promise<void>((done) =>
        held.stdout.once('data', () => {
          done();
        }),
      );
      expect(readHolder(lockPath)?.processStart).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} /);
      // Waiters in other locales and zones see it alive.
      const checkScript = `
        import { holderLiveness, readHolder } from ${JSON.stringify(module)};
        process.stdout.write(holderLiveness(process.argv[1], readHolder(process.argv[1])));
      `;
      for (const env of [
        { LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
        { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8', TZ: 'America/New_York' },
        { LC_ALL: 'tr_TR.UTF-8', LANG: 'tr_TR.UTF-8', TZ: 'Asia/Tokyo' },
      ]) {
        const answer = await new Promise<string>((done) => {
          const check = spawn(
            process.execPath,
            ['--input-type=module', '-e', checkScript, lockPath],
            {
              env: { ...process.env, ...env },
              stdio: ['ignore', 'pipe', 'inherit'],
            },
          );
          let out = '';
          check.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
          check.on('exit', () => {
            done(out);
          });
        });
        expect(answer, JSON.stringify(env)).toBe('alive');
      }
    } finally {
      held.kill('SIGKILL');
    }
  }, 30_000);

  it('treats start times it cannot compare as alive, never as a reused PID', () => {
    const turkish = { ...holder(66), processStart: 'Paz 18 Eki 20:28:25 2026' };
    tryTakeLock(lockPath, turkish);
    const probe = fakeProbe({ pids: [66] }, { processStart: () => 'Sun Oct 18 17:28:25 2026' });
    expect(compareStarts(turkish.processStart, 'Sun Oct 18 17:28:25 2026')).toBe('unknown');
    expect(holderLiveness(lockPath, turkish, probe)).toBe('alive');
  });

  it('parses C-locale UTC start times as instants, single-digit days included', () => {
    expect(parseProcessStart('Sun Oct 18 17:28:25 2026')).toBe(Date.UTC(2026, 9, 18, 17, 28, 25));
    expect(parseProcessStart('Thu Oct  8 09:05:01 2026')).toBe(Date.UTC(2026, 9, 8, 9, 5, 1));
    expect(parseProcessStart('Paz 18 Eki 20:28:25 2026')).toBeUndefined();
    expect(compareStarts('Thu Oct  8 09:05:01 2026', 'Thu Oct 8 09:05:01 2026')).toBe('same');
    expect(compareStarts('Thu Oct 8 09:05:01 2026', 'Thu Oct 8 09:05:02 2026')).toBe('different');
  });

  it('counts a recorded group as gone when its PGID now belongs to another process', () => {
    tryTakeLock(lockPath, holder(66));
    recordGroup(lockPath, 't-66', 4242, 'Sun Oct 18 10:00:00 2026');
    expect(readGroups(lockPath)).toEqual([{ pgid: 4242, leaderStart: 'Sun Oct 18 10:00:00 2026' }]);
    const leader = (start: string | undefined) =>
      fakeProbe({ pids: [4242], groups: [4242] }, { processStart: () => start });
    expect(holderLiveness(lockPath, holder(66), leader('Sun Oct 18 10:00:00 2026'))).toBe('alive');
    expect(holderLiveness(lockPath, holder(66), leader('Sun Oct 18 12:00:00 2026'))).toBe('dead');
    expect(holderLiveness(lockPath, holder(66), leader(undefined))).toBe('alive');
    // The leader exited but its group still runs: alive.
    expect(holderLiveness(lockPath, holder(66), fakeProbe({ groups: [4242] }))).toBe('alive');
  });

  it('removes a break guard older than a minute even when its writer PID is alive (reused)', () => {
    tryTakeLock(lockPath, holder(66));
    writeFileSync(`${lockPath}.break`, String(process.pid));
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(`${lockPath}.break`, old, old);
    expect(breakStaleLock(lockPath, holder(66), () => true, allAlive.pid)).toBe(false);
    expect(existsSync(`${lockPath}.break`)).toBe(false);
    expect(breakStaleLock(lockPath, holder(66), () => true, allAlive.pid)).toBe(true);
  });

  it('reads the boot time and process start times of this machine', async () => {
    expect(bootTime()).toMatch(/^\d+$/);
    expect(parseProcessStart(processStartTime(process.pid))).toBeGreaterThan(0);
    const exited = spawn(process.execPath, ['-e', '']);
    const pid = exited.pid ?? 0;
    await new Promise((done) => exited.on('exit', done));
    expect(processStartTime(pid)).toBeUndefined();
  });

  it('says why the Docker disk probe failed: image missing, Docker down, or else', () => {
    const image = 'eclipse-mosquitto:2.1.2-alpine';
    const missing = Object.assign(new Error('Command failed'), {
      stderr: `docker: Error response from daemon: No such image: ${image}`,
    });
    expect(dockerProbeProblem(image, missing)).toContain(`docker pull ${image}`);
    const down = Object.assign(new Error('Command failed'), {
      stderr:
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    });
    expect(dockerProbeProblem(image, down)).toMatch(/^Docker is not running/);
    expect(dockerProbeProblem(image, new Error('boom'))).toContain('boom');
  });
});

describe('lockTimeoutMs (#228)', () => {
  it('defaults to 3 hours', () => {
    expect(lockTimeoutMs({})).toBe(3 * 3_600_000);
    expect(lockTimeoutMs({ HEAVY_LOCK_TIMEOUT_MS: ' ' })).toBe(DEFAULT_HEAVY_LOCK_TIMEOUT_MS);
  });
  it('reads milliseconds and refuses anything else', () => {
    expect(lockTimeoutMs({ HEAVY_LOCK_TIMEOUT_MS: '60000' })).toBe(60_000);
    expect(lockTimeoutMs({ HEAVY_LOCK_TIMEOUT_MS: '0' })).toBe(0);
    expect(() => lockTimeoutMs({ HEAVY_LOCK_TIMEOUT_MS: '3h' })).toThrow(/HEAVY_LOCK_TIMEOUT_MS/);
    expect(() => lockTimeoutMs({ HEAVY_LOCK_TIMEOUT_MS: '-1' })).toThrow(/HEAVY_LOCK_TIMEOUT_MS/);
  });
});

describe('disk checks (#228)', () => {
  it("reads BusyBox's df -Pk (the probe container's)", () => {
    const out =
      'Filesystem           1024-blocks    Used Available Capacity Mounted on\n' +
      'overlay              102624184  10989352  86375672  11% /\n';
    expect(parseDfAvailableBytes(out)).toBe(86_375_672 * 1024);
  });
  it('reads GNU and macOS df -Pk, the last line, and a file-system name with spaces', () => {
    const out =
      'Filesystem     1024-blocks      Used Available Capacity Mounted on\n' +
      '/dev/disk3s1s1   239362496  13631488  45088768      24%    /\n' +
      'My Disk          1000       200      800        20%    /Volumes/My Disk\n';
    expect(parseDfAvailableBytes(out)).toBe(800 * 1024);
  });
  it('refuses output without a file-system line or an available size', () => {
    expect(() => parseDfAvailableBytes('')).toThrow(/no file system line/);
    expect(() =>
      parseDfAvailableBytes('Filesystem 1024-blocks Used Available Capacity Mounted on\n'),
    ).toThrow(/no file system line/);
    expect(() =>
      parseDfAvailableBytes('Filesystem 1024-blocks Used Available Capacity Mounted on\nx y z\n'),
    ).toThrow(/no available size/);
  });

  const GIB = 1024 ** 3;
  it('passes at exactly 25 GiB on the host and 15 GiB in Docker', () => {
    expect(MIN_HOST_FREE_BYTES).toBe(25 * GIB);
    expect(MIN_DOCKER_FREE_BYTES).toBe(15 * GIB);
    expect(diskProblems({ host: 25 * GIB, docker: 15 * GIB, hostPath: '/repo' })).toEqual([]);
  });
  it('says which disk is short', () => {
    const host = diskProblems({ host: 24.9 * GIB, docker: 40 * GIB, hostPath: '/repo' });
    expect(host).toEqual(['the host has 24.9 GiB free on /repo, below 25.0 GiB']);
    const docker = diskProblems({ host: 40 * GIB, docker: 14 * GIB, hostPath: '/repo' });
    expect(docker).toEqual([
      "Docker's data root (inside the VM) has 14.0 GiB free, below 15.0 GiB",
    ]);
    expect(diskProblems({ host: 0, docker: 0, hostPath: '/repo' })).toHaveLength(2);
  });

  it("probes with the broker's image from docker-compose.yml", () => {
    const compose = readFileSync(
      resolve(import.meta.dirname, '../../../docker-compose.yml'),
      'utf8',
    );
    expect(diskProbeImage(compose)).toMatch(/^eclipse-mosquitto:[\w.-]+$/);
    expect(() => diskProbeImage('services: {}')).toThrow(/eclipse-mosquitto/);
  });
});

describe('the queue: first come, first served (#348)', () => {
  const queue = () => queuePath(lockPath);
  const ticket = (pid: number, token = `q-${String(pid)}`): QueueTicket => ({
    pid,
    command: `wait-${String(pid)}`,
    since: '2026-10-24T08:00:00.000Z',
    token,
  });
  const backdate = (name: string, ms: number) => {
    const at = new Date(Date.now() - ms);
    utimesSync(join(queue(), name), at, at);
  };
  const deadPid = async () => {
    const exited = spawn(process.execPath, ['-e', '']);
    const pid = exited.pid ?? 0;
    await new Promise((done) => exited.on('exit', done));
    return pid;
  };
  const until = async (what: string, test: () => boolean, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(2);
    }
  };
  const tickets = () => readQueue(queue()).map((entry) => entry.name);

  it('keeps the queue beside the lock, never inside it (a release removes the lock directory)', () => {
    expect(queuePath(HEAVY_LOCK_PATH)).toBe(`${HEAVY_LOCK_PATH}.queue`);
    expect(queuePath('/x/heavy.lock')).toBe('/x/heavy.lock.queue');
  });

  it('numbers tickets one after another, zero-padded, oldest first, each complete', () => {
    expect(ticketName(7)).toBe('ticket-000000000007');
    expect(ticketName(123_456_789_012)).toBe('ticket-123456789012');
    expect(takeTicket(queue(), ticket(1))).toBe('ticket-000000000001');
    expect(takeTicket(queue(), ticket(2))).toBe('ticket-000000000002');
    expect(takeTicket(queue(), ticket(3))).toBe('ticket-000000000003');
    expect(readTicket(queue(), 'ticket-000000000002')).toEqual(ticket(2));
    // Ten sorts after nine as a number, and drafts and strangers are not tickets.
    for (let n = 4; n <= 10; n += 1) takeTicket(queue(), ticket(n));
    writeFileSync(join(queue(), 'draft-1.abc.tmp'), '{}');
    writeFileSync(join(queue(), 'ticket-12'), '{}');
    writeFileSync(join(queue(), 'notes.txt'), '');
    const entries = readQueue(queue());
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(entries.every((entry) => entry.ageMs > -1_000 && entry.ageMs < 5_000)).toBe(true);
    // The next one follows the highest, not the count, once earlier ones are gone.
    expect(removeTicket(queue(), 'ticket-000000000001', 'q-1')).toBe(true);
    expect(takeTicket(queue(), ticket(11))).toBe('ticket-000000000011');
    expect(readdirSync(queue()).filter((name) => name.startsWith('draft-'))).toEqual([
      'draft-1.abc.tmp',
    ]);
  });

  it('lists tickets by sequence whatever order they were made in', () => {
    for (const seq of [10, 2, 300, 7, 1, 45]) retakeTicket(queue(), ticketName(seq), ticket(seq));
    expect(readQueue(queue()).map((entry) => entry.seq)).toEqual([1, 2, 7, 10, 45, 300]);
  });

  it('reads no ticket from a missing, corrupt or incomplete file, and an empty queue as empty', () => {
    expect(readQueue(queue())).toEqual([]);
    mkdirSync(queue(), { recursive: true });
    expect(readTicket(queue(), 'ticket-000000000001')).toBeUndefined();
    writeFileSync(join(queue(), 'ticket-000000000001'), '{"pid": 3');
    expect(readTicket(queue(), 'ticket-000000000001')).toBeUndefined();
    const good = ticket(3);
    for (const bad of [
      { ...good, pid: 0 },
      { ...good, pid: 1.5 },
      { ...good, pid: '3' },
      { ...good, command: 1 },
      { ...good, since: undefined },
      { ...good, token: null },
    ]) {
      writeFileSync(join(queue(), 'ticket-000000000001'), JSON.stringify(bad));
      expect(readTicket(queue(), 'ticket-000000000001'), JSON.stringify(bad)).toBeUndefined();
    }
    writeFileSync(join(queue(), 'ticket-000000000001'), JSON.stringify(good));
    expect(readTicket(queue(), 'ticket-000000000001')).toEqual(good);
    expect(readQueue(queue())[0]).toMatchObject({ name: 'ticket-000000000001', seq: 1 });
  });

  it('removes a ticket only when it is still the one seen, and retakes a name only when free', () => {
    const name = takeTicket(queue(), ticket(1));
    expect(removeTicket(queue(), name, 'q-other')).toBe(false);
    expect(removeTicket(queue(), name, undefined)).toBe(false);
    expect(retakeTicket(queue(), name, ticket(2))).toBe(false);
    expect(readTicket(queue(), name)?.token).toBe('q-1');
    expect(removeTicket(queue(), name, 'q-1')).toBe(true);
    expect(removeTicket(queue(), name, 'q-1')).toBe(false);
    expect(retakeTicket(queue(), name, ticket(2))).toBe(true);
    expect(readTicket(queue(), name)?.token).toBe('q-2');
    // A file that is no valid ticket is removed by `undefined`.
    writeFileSync(join(queue(), 'ticket-000000000009'), 'junk');
    expect(removeTicket(queue(), 'ticket-000000000009', undefined)).toBe(true);
    expect(removeTicket(queue(), 'ticket-000000000008', undefined)).toBe(false);
    expect(readdirSync(queue())).toEqual([name]);
  });

  it('touches a ticket (the heartbeat), and says when it is gone', () => {
    const name = takeTicket(queue(), ticket(1));
    backdate(name, 120_000);
    expect(readQueue(queue())[0]?.ageMs).toBeGreaterThan(100_000);
    expect(touchTicket(queue(), name)).toBe(true);
    expect(readQueue(queue())[0]?.ageMs).toBeLessThan(5_000);
    expect(touchTicket(queue(), 'ticket-000000000099')).toBe(false);
  });

  it('counts a ticket dead on ESRCH, or untouched for longer than the stale time when judged', () => {
    const entry = (ageMs: number, valid = true): QueueEntry => ({
      name: 'ticket-000000000001',
      seq: 1,
      ticket: valid ? ticket(5) : undefined,
      ageMs,
    });
    const live = fakeProbe({ pids: [5] });
    expect(TICKET_STALE_MS).toBe(60_000);
    expect(HEAD_POLL_MS).toBe(200);
    expect(ticketLiveness(entry(0), live, 1_000, true)).toBe('alive');
    expect(ticketLiveness(entry(0), allDead, 1_000, true)).toBe('dead');
    expect(ticketLiveness(entry(0), allDead, 1_000, false)).toBe('dead');
    expect(ticketLiveness(entry(1_000), live, 1_000, true)).toBe('alive');
    expect(ticketLiveness(entry(1_001), live, 1_000, true)).toBe('dead');
    expect(ticketLiveness(entry(1_001), live, 1_000, false)).toBe('alive');
    // A file that is no valid ticket: only its age can tell (no PID to ask).
    expect(ticketLiveness(entry(1_000, false), allDead, 1_000, true)).toBe('alive');
    expect(ticketLiveness(entry(1_001, false), allDead, 1_000, true)).toBe('dead');
    expect(ticketLiveness(entry(1_001, false), allDead, 1_000, false)).toBe('alive');
  });

  it('gives each waiter its place, removing the dead tickets ahead and behind', () => {
    const first = takeTicket(queue(), ticket(1)); // dead
    const second = takeTicket(queue(), ticket(2)); // alive
    const own = takeTicket(queue(), ticket(3, 'mine'));
    const stale = takeTicket(queue(), ticket(4)); // alive, but no heartbeat
    takeTicket(queue(), ticket(5)); // alive
    backdate(stale, 10_000);
    backdate(own, 10_000); // our own ticket is never judged by ourselves
    const probe = fakeProbe({ pids: [2, 3, 4, 5] });
    const removed: string[] = [];
    const seen = queuePlace(queue(), own, probe, 1_000, true, (entry) => removed.push(entry.name));
    expect(seen.place).toBe(2);
    expect(seen.total).toBe(3);
    expect(seen.first?.name).toBe(second);
    expect(removed).toEqual([first, stale]);
    expect(tickets()).toEqual([second, own, 'ticket-000000000005']);
    // Without judging heartbeats an old ticket stays; at the head, nobody is ahead.
    backdate(second, 10_000);
    expect(queuePlace(queue(), own, probe, 1_000, false)).toMatchObject({ place: 2, total: 3 });
    touchTicket(queue(), own);
    expect(queuePlace(queue(), second, probe, 1_000, true)).toEqual({
      place: 1,
      total: 3,
      first: undefined,
    });
  });

  it('reports only the tickets this call removed, not one another waiter removed first', () => {
    const own = takeTicket(queue(), ticket(1, 'mine'));
    const other = takeTicket(queue(), ticket(2));
    const probe = fakeProbe(
      {},
      {
        pid: () => {
          rmSync(join(queue(), other)); // another waiter removes it first
          return 'dead';
        },
      },
    );
    const removed: string[] = [];
    expect(
      queuePlace(queue(), own, probe, 1_000, true, (entry) => removed.push(entry.name)),
    ).toMatchObject({ place: 1, total: 1 });
    expect(removed).toEqual([]);
  });

  it('fails on a link error other than a taken name', () => {
    expect(() =>
      retakeTicket(queue(), join('no-such-dir', 'ticket-000000000001'), ticket(1)),
    ).toThrow(/ENOENT/);
    expect(readdirSync(queue())).toEqual([]);
  });

  it('keeps every sequence unique when many processes take tickets at once', async () => {
    const module = resolve(import.meta.dirname, 'heavy-lock.ts');
    const script = `
      import { takeTicket } from ${JSON.stringify(module)};
      await new Promise((r) => setTimeout(r, Number(process.argv[2]) - Date.now()));
      for (let i = 0; i < 5; i += 1) {
        takeTicket(process.argv[1], { pid: process.pid, command: 'c', since: 's', token: process.pid + '-' + i });
      }
    `;
    const start = String(Date.now() + 1_500); // all start together
    const codes = await Promise.all(
      Array.from(
        { length: 12 },
        () =>
          new Promise<number | null>((done) => {
            const child = spawn(
              process.execPath,
              ['--input-type=module', '-e', script, queue(), start],
              { stdio: 'inherit' },
            );
            child.on('exit', done);
          }),
      ),
    );
    expect(codes).toEqual(Array.from({ length: 12 }, () => 0));
    const entries = readQueue(queue());
    expect(entries.map((entry) => entry.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(new Set(entries.map((entry) => entry.ticket?.token)).size).toBe(60);
    expect(readdirSync(queue()).filter((name) => !name.startsWith('ticket-'))).toEqual([]);
  }, 30_000);

  it('serves three waiters in the order they came, though the later ones poll faster', async () => {
    tryTakeLock(lockPath, holder(process.pid, 't-holder'));
    const order: string[] = [];
    const waiter = (name: string, ms: number) =>
      acquireHeavyLock({
        lockPath,
        command: name,
        env: {},
        pollMs: ms,
        headPollMs: ms,
        timeoutMs: 10_000,
        log,
      }).then(async (lock) => {
        order.push(name);
        await sleep(30);
        lock.release();
      });
    const a = waiter('a', 40);
    await until('a ticket', () => tickets().length === 1);
    const b = waiter('b', 10);
    await until('b ticket', () => tickets().length === 2);
    const c = waiter('c', 1);
    await until('c ticket', () => tickets().length === 3);
    await sleep(20);
    expect(logs.some((line) => line.includes('place 3 of 3 in the queue, behind a (pid'))).toBe(
      true,
    );
    releaseLock(lockPath, 't-holder');
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(tickets()).toEqual([]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('serves separate processes in the order they came', async () => {
    tryTakeLock(lockPath, holder(process.pid, 't-holder'));
    const module = resolve(import.meta.dirname, 'heavy-lock.ts');
    const trail = join(dir, 'trail.txt');
    writeFileSync(trail, '');
    const script = `
      import { appendFileSync } from 'node:fs';
      import { acquireHeavyLock } from ${JSON.stringify(module)};
      const ms = Number(process.argv[3]);
      const lock = await acquireHeavyLock({ lockPath: process.argv[1], command: process.argv[4], env: {}, pollMs: ms, headPollMs: ms, timeoutMs: 20000, log: () => {} });
      appendFileSync(process.argv[2], process.argv[4] + '\\n');
      await new Promise((r) => setTimeout(r, 20));
      lock.release();
    `;
    const exits: Promise<number | null>[] = [];
    for (const [name, ms] of [
      ['a', '60'],
      ['b', '15'],
      ['c', '1'],
    ] as const) {
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', script, lockPath, trail, ms, name],
        { stdio: 'inherit' },
      );
      exits.push(new Promise((done) => child.on('exit', done)));
      const count = exits.length;
      await until(`${name}'s ticket`, () => tickets().length === count, 10_000);
    }
    releaseLock(lockPath, 't-holder');
    expect(await Promise.all(exits)).toEqual([0, 0, 0]);
    expect(readFileSync(trail, 'utf8')).toBe('a\nb\nc\n');
    expect(tickets()).toEqual([]);
  }, 30_000);

  it('skips the ticket of a dead waiter and takes the free lock, saying so once', async () => {
    const pid = await deadPid();
    const dead = takeTicket(queue(), ticket(pid));
    const lock = await acquireHeavyLock({ lockPath, command: 'x', env: {}, timeoutMs: 1_000, log });
    expect(readHolder(lockPath)?.token).toBe(lock.holder.token);
    expect(existsSync(join(queue(), dead))).toBe(false);
    const removals = logs.filter((line) => line.includes('removing the queue ticket of'));
    expect(removals).toEqual([
      `heavy lock: removing the queue ticket of wait-${String(pid)} (pid ${String(pid)}, waiting since 2026-10-24T08:00:00.000Z) (no such process, or no heartbeat for 60000 ms)`,
    ]);
    lock.release();
    expect(tickets()).toEqual([]);
  });

  it('skips a live waiter whose ticket has no heartbeat, and a file that is no ticket', async () => {
    const stale = takeTicket(queue(), ticket(process.pid, 'other'));
    backdate(stale, 5_000);
    writeFileSync(join(queue(), 'ticket-000000000002'), 'junk');
    backdate('ticket-000000000002', 5_000);
    const lock = await acquireHeavyLock({
      lockPath,
      command: 'x',
      env: {},
      timeoutMs: 1_000,
      ticketStaleMs: 1_000,
      log,
    });
    expect(lock.inherited).toBe(false);
    expect(tickets()).toEqual([]);
    expect(logs.some((line) => line.includes('ticket-000000000002 (not a valid ticket)'))).toBe(
      true,
    );
    lock.release();
  });

  it('waits behind a live waiter with a heartbeat even while the lock is free, then times out', async () => {
    const ahead = takeTicket(queue(), ticket(process.pid, 'other'));
    const error: unknown = await acquireHeavyLock({
      lockPath,
      command: 'x',
      env: {},
      timeoutMs: 60,
      pollMs: 5,
      log,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HeavyLockTimeoutError);
    expect(existsSync(lockPath)).toBe(false);
    expect(logs).toContain(
      `heavy lock: waiting behind wait-${String(process.pid)} (pid ${String(process.pid)}, waiting since 2026-10-24T08:00:00.000Z), place 2 of 2 in the queue (${lockPath})`,
    );
    // The timed-out waiter's ticket is gone; the other one stays.
    expect(tickets()).toEqual([ahead]);
  });

  it('times out at the head of the queue, naming the holder and removing its ticket', async () => {
    tryTakeLock(lockPath, holder(77));
    const error: unknown = await acquireHeavyLock({
      lockPath,
      command: 'x',
      env: {},
      timeoutMs: 40,
      pollMs: 5,
      probe: allAlive,
      log,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HeavyLockTimeoutError);
    expect((error as HeavyLockTimeoutError).holder?.token).toBe('t-77');
    expect(logs).toContain(
      `heavy lock: waiting for cmd-77 (pid 77, since 2026-10-18T10:00:00.000Z) (${lockPath}), place 1 of 1 in the queue`,
    );
    expect(tickets()).toEqual([]);
  });

  it('says the holder, the place and who is first ahead, again whenever the place changes', async () => {
    tryTakeLock(lockPath, holder(process.pid, 't-holder'));
    const zeroth = takeTicket(queue(), ticket(process.pid, 'zeroth'));
    const first = takeTicket(queue(), ticket(process.pid, 'first'));
    mkdirSync(queue(), { recursive: true });
    writeFileSync(join(queue(), 'draft-1.left.tmp'), '{}');
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(queue(), 'draft-1.left.tmp'), old, old);
    const waiting = acquireHeavyLock({
      lockPath,
      command: 'x',
      env: {},
      timeoutMs: 5_000,
      pollMs: 5,
      log,
    });
    const holderText = `cmd-${String(process.pid)} (pid ${String(process.pid)}, since 2026-10-18T10:00:00.000Z)`;
    await until('the place-3 line', () => logs.some((line) => line.includes('place 3 of 3')));
    // Its ticket says who waits, since when, under which token; a left-over draft is gone.
    const own = tickets()[2] ?? '';
    expect(readTicket(queue(), own)).toEqual({
      pid: process.pid,
      command: 'x',
      since: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as string,
      token: expect.stringMatching(new RegExp(`^${String(process.pid)}-[0-9a-f]{16}$`)) as string,
    });
    expect(existsSync(join(queue(), 'draft-1.left.tmp'))).toBe(false);
    const seen = readTicket(queue(), own);
    removeTicket(queue(), zeroth, 'zeroth');
    await until('the place-2 line', () => logs.some((line) => line.includes('place 2 of 2')));
    expect(logs).toContain(
      `heavy lock: waiting for ${holderText} (${lockPath}), place 2 of 2 in the queue, behind wait-${String(process.pid)} (pid ${String(process.pid)}, waiting since 2026-10-24T08:00:00.000Z)`,
    );
    removeTicket(queue(), first, 'first');
    await until('the place-1 line', () => logs.some((line) => line.includes('place 1 of 1')));
    expect(logs).toContain(
      `heavy lock: waiting for ${holderText} (${lockPath}), place 1 of 1 in the queue`,
    );
    await sleep(30);
    expect(logs.filter((line) => line.startsWith('heavy lock: waiting'))).toHaveLength(3);
    releaseLock(lockPath, 't-holder');
    const lock = await waiting;
    expect(seen).toMatchObject({ token: lock.holder.token, since: lock.holder.startedAt });
    lock.release();
  });

  it('removes a dead holder’s lock at the head of the queue, and the next waiter takes its turn', async () => {
    const pid = await deadPid();
    tryTakeLock(lockPath, holder(pid));
    const order: string[] = [];
    const waiter = (name: string) =>
      acquireHeavyLock({ lockPath, command: name, env: {}, pollMs: 5, timeoutMs: 5_000, log }).then(
        async (lock) => {
          order.push(name);
          await sleep(20);
          lock.release();
        },
      );
    const a = waiter('a');
    const b = waiter('b');
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
    expect(logs.filter((line) => line.includes(`stale lock of cmd-${String(pid)}`))).toHaveLength(
      1,
    );
    expect(tickets()).toEqual([]);
  });

  it('wakes the next waiter at once on release: the head polls fast whatever its poll time', async () => {
    tryTakeLock(lockPath, holder(process.pid, 't-holder'));
    let tookAt = 0;
    const waiting = acquireHeavyLock({
      lockPath,
      command: 'x',
      env: {},
      pollMs: 60_000,
      headPollMs: 20,
      timeoutMs: 120_000,
      log,
    }).then((lock) => {
      tookAt = Date.now();
      return lock;
    });
    await until('the waiting line', () => logs.some((line) => line.includes('place 1 of 1')));
    await sleep(50);
    const releasedAt = Date.now();
    releaseLock(lockPath, 't-holder');
    const lock = await waiting;
    expect(tookAt - releasedAt).toBeLessThan(1_000);
    lock.release();
  });

  it('becomes the head when the waiter ahead takes the lock, and takes it right after', async () => {
    tryTakeLock(lockPath, holder(process.pid, 't-holder'));
    const times: Record<string, number> = {};
    const waiter = (name: string) =>
      acquireHeavyLock({
        lockPath,
        command: name,
        env: {},
        pollMs: 60_000,
        headPollMs: 10,
        ticketStaleMs: 400,
        timeoutMs: 120_000,
        log,
      }).then(async (lock) => {
        times[`${name}-in`] = Date.now();
        await sleep(40);
        times[`${name}-out`] = Date.now();
        lock.release();
      });
    const a = waiter('a');
    const b = waiter('b');
    await sleep(30);
    releaseLock(lockPath, 't-holder');
    await Promise.all([a, b]);
    expect(times['b-in'] ?? 0).toBeGreaterThanOrEqual(times['a-out'] ?? Infinity);
    // b polls at 60 s while behind a, but never sleeps past a quarter of the stale time (100 ms
    // here, 15 s by default), and at the head every 10 ms: it is in at once, not a minute later.
    expect((times['b-in'] ?? Infinity) - (times['a-out'] ?? 0)).toBeLessThan(1_000);
  });

  it('never sleeps past a quarter of the stale time, so its heartbeat keeps its ticket alive', async () => {
    tryTakeLock(lockPath, holder(process.pid, 't-holder'));
    const ahead = takeTicket(queue(), ticket(process.pid, 'ahead'));
    const waiting = acquireHeavyLock({
      lockPath,
      command: 'x',
      env: {},
      pollMs: 60_000,
      ticketStaleMs: 200,
      timeoutMs: 10_000,
      log,
    });
    await until('its ticket', () => tickets().length === 2);
    const own = tickets()[1] ?? '';
    // The ticket ahead has no heartbeat: it is removed within the stale time, by a waiter that
    // would otherwise sleep a minute.
    await until('the stale ticket removed', () => !tickets().includes(ahead), 2_000);
    backdate(own, 1_000);
    await until('its heartbeat', () => (readQueue(queue())[0]?.ageMs ?? Infinity) < 500, 2_000);
    releaseLock(lockPath, 't-holder');
    (await waiting).release();
  });

  it('does not judge heartbeats on a poll after it went without polling itself (the machine slept)', async () => {
    tryTakeLock(lockPath, holder(process.pid, 't-holder'));
    const ahead = takeTicket(queue(), ticket(process.pid, 'ahead'));
    let polls = 0;
    const probe = fakeProbe(
      {},
      {
        pid: () => {
          polls += 1;
          return 'alive';
        },
      },
    );
    const waiting = acquireHeavyLock({
      lockPath,
      command: 'x',
      env: {},
      pollMs: 5,
      ticketStaleMs: 200,
      timeoutMs: 10_000,
      probe,
      log,
    });
    await until('the waiting line', () => logs.some((line) => line.includes('place 2 of 2')));
    backdate(ahead, 10_000);
    const before = polls;
    const blockedUntil = Date.now() + 300; // no poll for longer than half the stale time
    while (Date.now() < blockedUntil) {
      // the whole process stands still, as in a sleep
    }
    await until('the first poll after the stall', () => polls > before);
    expect(tickets()).toContain(ahead);
    await until('the next poll removing it', () => !tickets().includes(ahead), 2_000);
    releaseLock(lockPath, 't-holder');
    (await waiting).release();
  });

  it('lets an old-version waiter (no ticket) win a release without breaking the queue', async () => {
    tryTakeLock(lockPath, holder(process.pid, 't-holder'));
    const waiting = acquireHeavyLock({
      lockPath,
      command: 'new',
      env: {},
      pollMs: 5,
      timeoutMs: 5_000,
      log,
    });
    await until('the waiting line', () => logs.some((line) => line.includes('place 1 of 1')));
    const own = tickets();
    // The old code's waiter: tryTakeLock as soon as the lock is free, in the same instant.
    releaseLock(lockPath, 't-holder');
    expect(tryTakeLock(lockPath, { ...holder(process.pid, 't-old'), command: 'old-code' })).toBe(
      true,
    );
    await until('the new holder named', () =>
      logs.some((line) => line.startsWith('heavy lock: waiting for old-code (pid')),
    );
    expect(readHolder(lockPath)?.token).toBe('t-old');
    expect(tickets()).toEqual(own);
    expect(logs).toContain(
      `heavy lock: waiting for old-code (pid ${String(process.pid)}, since 2026-10-18T10:00:00.000Z) (${lockPath}), place 1 of 1 in the queue`,
    );
    releaseLock(lockPath, 't-old');
    const lock = await waiting;
    expect(readHolder(lockPath)?.token).toBe(lock.holder.token);
    expect(tickets()).toEqual([]);
    lock.release();
  });

  it('takes its own ticket again under the same name when it was removed, keeping its place', async () => {
    tryTakeLock(lockPath, holder(process.pid, 't-holder'));
    const order: string[] = [];
    const waiter = (name: string) =>
      acquireHeavyLock({
        lockPath,
        command: name,
        env: {},
        pollMs: 5,
        timeoutMs: 5_000,
        log,
      }).then(async (lock) => {
        order.push(name);
        await sleep(20);
        lock.release();
      });
    const a = waiter('a');
    const b = waiter('b');
    await until('both tickets', () => tickets().length === 2);
    const [first] = tickets();
    const token = readTicket(queue(), first ?? '')?.token;
    rmSync(join(queue(), first ?? ''));
    await until('the ticket retaken', () => readTicket(queue(), first ?? '')?.token === token);
    expect(logs).toContain(
      `heavy lock: this waiter's queue ticket was removed; queued again as ${first ?? ''}`,
    );
    releaseLock(lockPath, 't-holder');
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
  });

  it('queues again at the end when its ticket’s name was taken by another waiter', async () => {
    tryTakeLock(lockPath, holder(process.pid, 't-holder'));
    const order: string[] = [];
    const waiter = (name: string) =>
      acquireHeavyLock({
        lockPath,
        command: name,
        env: {},
        pollMs: 5,
        timeoutMs: 5_000,
        log,
      }).then(async (lock) => {
        order.push(name);
        await sleep(20);
        lock.release();
      });
    const a = waiter('a');
    const b = waiter('b');
    await until('both tickets', () => tickets().length === 2);
    const [first] = tickets();
    rmSync(join(queue(), first ?? ''));
    retakeTicket(queue(), first ?? '', ticket(process.pid, 'stranger'));
    await until('a queued again', () => tickets().length === 3);
    expect(tickets()[2]).toBe('ticket-000000000003');
    expect(logs).toContain(
      "heavy lock: this waiter's queue ticket was removed; queued again as ticket-000000000003",
    );
    removeTicket(queue(), first ?? '', 'stranger');
    releaseLock(lockPath, 't-holder');
    await Promise.all([a, b]);
    expect(order).toEqual(['b', 'a']);
  });

  it('removes drafts left by a waiter killed while taking a ticket, after a minute', () => {
    mkdirSync(queue(), { recursive: true });
    writeFileSync(join(queue(), 'draft-1.old.tmp'), '{}');
    writeFileSync(join(queue(), 'draft-1.new.tmp'), '{}');
    const old = new Date(Date.now() - 61_000);
    utimesSync(join(queue(), 'draft-1.old.tmp'), old, old);
    const recent = new Date(Date.now() - 59_000);
    utimesSync(join(queue(), 'draft-1.new.tmp'), recent, recent);
    writeFileSync(join(queue(), 'ticket-000000000001'), 'x');
    utimesSync(join(queue(), 'ticket-000000000001'), old, old);
    removeOldDrafts(queue());
    expect(readdirSync(queue()).sort()).toEqual(['draft-1.new.tmp', 'ticket-000000000001']);
    // Exactly a minute old is still young.
    const at = new Date('2026-10-24T08:00:00.000Z');
    utimesSync(join(queue(), 'draft-1.new.tmp'), at, at);
    removeOldDrafts(queue(), at.getTime() + 60_000);
    expect(existsSync(join(queue(), 'draft-1.new.tmp'))).toBe(true);
    removeOldDrafts(queue(), at.getTime() + 60_001);
    expect(existsSync(join(queue(), 'draft-1.new.tmp'))).toBe(false);
    removeOldDrafts(join(dir, 'none')); // no queue yet: nothing to do
  });

  it('takes no ticket when inheriting the lock', async () => {
    const parent = await acquireHeavyLock({ lockPath, command: 'pnpm gate', env: {}, log });
    expect(tickets()).toEqual([]);
    const child = await acquireHeavyLock({
      lockPath,
      command: 'pnpm verify',
      env: { ...parent.env },
      timeoutMs: 0,
      log,
    });
    expect(child.inherited).toBe(true);
    expect(existsSync(queue()) ? readdirSync(queue()) : []).toEqual([]);
    parent.release();
  });

  it('removes its ticket when taking the lock fails with an error', async () => {
    // The lock's parent is a file: making the staging directory fails with ENOTDIR.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'file'), '');
    const badLock = join(dir, 'file', 'heavy.lock');
    // The queue sits beside it, under the same file: taking the ticket fails first.
    await expect(
      acquireHeavyLock({ lockPath: badLock, command: 'x', env: {}, timeoutMs: 0, log }),
    ).rejects.toThrow();
    const readOnlyParent = join(dir, 'ro');
    mkdirSync(join(readOnlyParent, 'heavy.lock.queue'), { recursive: true });
    writeFileSync(join(readOnlyParent, 'heavy.lock'), 'not a directory');
    const error: unknown = await acquireHeavyLock({
      lockPath: join(readOnlyParent, 'heavy.lock'),
      command: 'x',
      env: {},
      timeoutMs: 0,
      log,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(readdirSync(join(readOnlyParent, 'heavy.lock.queue'))).toEqual([]);
    expect(statSync(join(readOnlyParent, 'heavy.lock')).isFile()).toBe(true);
  });
});
