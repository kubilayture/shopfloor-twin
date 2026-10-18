import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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
  HeavyLockTimeoutError,
  MIN_DOCKER_FREE_BYTES,
  MIN_HOST_FREE_BYTES,
  acquireHeavyLock,
  bootTime,
  breakStaleLock,
  diskProbeImage,
  dockerProbeProblem,
  fakeProbe,
  holderLiveness,
  diskProblems,
  lockTimeoutMs,
  parseDfAvailableBytes,
  processLiveness,
  processStartTime,
  readGroups,
  readHolder,
  recordGroup,
  releaseLock,
  tryTakeLock,
  type HeavyLockHolder,
  type LockProbe,
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
    expect(readGroups(lockPath)).toEqual([4242]);
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

  it('counts a lock from an earlier boot as stale, even if its PID now exists', () => {
    const old = { ...holder(66), boot: '100' };
    tryTakeLock(lockPath, old);
    const probe = fakeProbe({ pids: [66] }, { boot: () => '200' });
    expect(holderLiveness(lockPath, old, probe)).toBe('dead');
    expect(holderLiveness(lockPath, old, fakeProbe({ pids: [66] }, { boot: () => '100' }))).toBe(
      'alive',
    );
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

  it('reads the boot time and process start times of this machine', async () => {
    expect(bootTime()).toMatch(/^\d+$/);
    expect(processStartTime(process.pid)).toBeTruthy();
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
