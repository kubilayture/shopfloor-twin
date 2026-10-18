/**
 * The host-wide heavy-suite lock (#228, Phase 9 plan "Local gate"): one heavy command at a time on
 * the machine (`gate`, `verify` and its Testcontainers suites, `test:e2e`, `test:reconcile`,
 * `test:resilience`, `test:perf`, `test:trace-perf`, Playwright), however many worktrees or agents
 * share it. Phase 8 lost runs to two agents' suites at once (#212, #216, #218).
 *
 * - **Where:** a directory at a fixed absolute path, `~/.cache/shopfloor-twin/heavy.lock` (the
 *   account's home from the user database, not `$HOME`, which a sandbox may change), never under
 *   `os.tmpdir()` (per session under the sandbox, so two sessions would not see each other's).
 * - **What it holds:** `holder.json` with the holder's PID, command, start time, a token, the
 *   machine's boot time and the holder process's own start time. The directory is made complete in
 *   a private temporary directory and renamed into place: rename onto an existing, non-empty
 *   directory fails, so taking the lock is atomic and a lock never exists without its holder. The
 *   holder (and any child that inherits it) adds an empty `group-<pgid>` file for each process
 *   group it starts detached, so the suite it runs keeps the lock alive after its own death.
 * - **Waiting:** a command that finds the lock taken prints the holder and polls until it is free,
 *   up to `HEAVY_LOCK_TIMEOUT_MS` (default 3 hours), then fails.
 * - **Stale:** the lock is alive while its holder's PID answers `kill(pid, 0)` (or `EPERM`: another
 *   user's process) **or** any recorded process group answers `kill(-pgid, 0)`. It is stale when
 *   it was taken in an earlier boot, when the holder PID's process start time differs from the one
 *   recorded (the PID was reused), or when neither the PID nor any group exists (`ESRCH`). A lock
 *   directory without a valid `holder.json` (made by hand, or truncated) is waited for and counted
 *   stale only after a grace period. Breaking a stale lock happens under a short guard file
 *   (`heavy.lock.break`), so two waiters that see the same dead holder can't remove a lock the
 *   other has just taken.
 * - **Children:** the holder passes its token in `SHOPFLOOR_HEAVY_LOCK`; a command started under
 *   it (the gate's `verify`, the reconciliation's Playwright) finds its own token in the lock and
 *   runs without waiting on its parent.
 * - **Release:** the holder renames the directory away (only when the token is still its own) and
 *   removes it, so a release never deletes a lock another process took meanwhile.
 *
 * Also the disk checks every heavy command makes once it holds the lock: at least 25 GiB free on
 * the host (the repository's file system) and 15 GiB in Docker's data root (inside the VM), and the
 * BuildKit cache pruned to 10 GiB after a build.
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

/** The variable through which a holder's children inherit its lock. */
export const HEAVY_LOCK_ENV = 'SHOPFLOOR_HEAVY_LOCK';
/** The lock's fixed path (plan: not `os.tmpdir()`; the account's home, not `$HOME`). */
export const HEAVY_LOCK_PATH = join(userInfo().homedir, '.cache', 'shopfloor-twin', 'heavy.lock');
/** How long a command waits for the lock unless `HEAVY_LOCK_TIMEOUT_MS` says otherwise. */
export const DEFAULT_HEAVY_LOCK_TIMEOUT_MS = 3 * 3_600_000;
/** How long a lock directory without a valid holder is waited for before it counts as stale. */
export const NO_HOLDER_GRACE_MS = 60_000;

const GIB = 1024 ** 3;
/** Free space a heavy command needs on the host's file system holding the repository. */
export const MIN_HOST_FREE_BYTES = 25 * GIB;
/** Free space a heavy command needs in Docker's data root (inside the VM). */
export const MIN_DOCKER_FREE_BYTES = 15 * GIB;
/** The BuildKit cache kept after a build (`docker builder prune --all --keep-storage`). */
export const BUILD_CACHE_KEEP = '10GB';

export interface HeavyLockHolder {
  readonly pid: number;
  readonly command: string;
  /** ISO time the holder took the lock. */
  readonly startedAt: string;
  /** Unique per acquisition: what `SHOPFLOOR_HEAVY_LOCK` carries to the holder's children. */
  readonly token: string;
  /** The machine's boot time when the lock was taken (a lock from an earlier boot is stale). */
  readonly boot?: string;
  /** The holder process's start time (`ps -o lstart=`): a different one means the PID was reused. */
  readonly processStart?: string;
}

export type Liveness = 'alive' | 'dead';
type Kill = (pid: number, signal: 0) => unknown;

/** `kill(pid, 0)`: dead only on `ESRCH`; `EPERM` (another user's process) and the rest alive. */
export function processLiveness(pid: number, kill: Kill = process.kill.bind(process)): Liveness {
  try {
    kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'alive';
  }
}

/** The machine's boot time: `kern.boottime` on macOS, `btime` in `/proc/stat` on Linux. */
export function bootTime(): string | undefined {
  try {
    if (process.platform === 'linux') {
      return /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1];
    }
    const out = execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' });
    return /sec = (\d+)/.exec(out)?.[1];
  } catch {
    return undefined;
  }
}

/** A process's start time as `ps` prints it; undefined when there is no such process. */
export function processStartTime(pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

/** What the liveness rules ask of the machine; injectable for tests. */
export interface LockProbe {
  /** `kill(pid, 0)` of a process. */
  readonly pid: (pid: number) => Liveness;
  /** `kill(-pgid, 0)` of a process group. */
  readonly group: (pgid: number) => Liveness;
  readonly boot: () => string | undefined;
  readonly processStart: (pid: number) => string | undefined;
}

export const systemProbe: LockProbe = {
  pid: (pid) => processLiveness(pid),
  group: (pgid) => processLiveness(-pgid),
  boot: bootTime,
  processStart: processStartTime,
};

/** A probe with every process and group dead except the listed live ones (for tests). */
export function fakeProbe(
  live: { readonly pids?: readonly number[]; readonly groups?: readonly number[] } = {},
  extra: Partial<LockProbe> = {},
): LockProbe {
  return {
    pid: (pid) => (live.pids?.includes(pid) ? 'alive' : 'dead'),
    group: (pgid) => (live.groups?.includes(pgid) ? 'alive' : 'dead'),
    boot: () => undefined,
    processStart: () => undefined,
    ...extra,
  };
}

const holderFile = (lockPath: string) => join(lockPath, 'holder.json');

/** The lock's holder; undefined when there is no lock (or no readable holder in it). */
export function readHolder(lockPath: string): HeavyLockHolder | undefined {
  let text: string;
  try {
    text = readFileSync(holderFile(lockPath), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(text) as Partial<HeavyLockHolder>;
    if (
      typeof value.pid === 'number' &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.command === 'string' &&
      typeof value.startedAt === 'string' &&
      typeof value.token === 'string'
    ) {
      return value as HeavyLockHolder;
    }
  } catch {
    // fall through: unreadable
  }
  return undefined;
}

/** The process groups recorded in the lock (`group-<pgid>` files). */
export function readGroups(lockPath: string): number[] {
  try {
    return readdirSync(lockPath)
      .map((name) => /^group-(\d+)$/.exec(name)?.[1])
      .filter((pgid): pgid is string => pgid !== undefined)
      .map(Number)
      .filter((pgid) => pgid > 1);
  } catch {
    return [];
  }
}

/**
 * Records a process group the lock's holder (or a child that inherited it) started, so the lock
 * stays alive while that group runs. Only while `token` still holds the lock; false otherwise.
 */
export function recordGroup(lockPath: string, token: string, pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  if (readHolder(lockPath)?.token !== token) return false;
  try {
    writeFileSync(join(lockPath, `group-${String(pgid)}`), '');
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a holder still holds its lock: dead for a lock taken in another boot, or whose PID now
 * belongs to a process started at another time; else alive while its PID or any recorded group
 * exists.
 */
export function holderLiveness(
  lockPath: string,
  holder: HeavyLockHolder,
  probe: LockProbe = systemProbe,
): Liveness {
  const boot = probe.boot();
  if (holder.boot !== undefined && boot !== undefined && holder.boot !== boot) return 'dead';
  if (probe.pid(holder.pid) === 'alive') {
    const started = holder.processStart === undefined ? undefined : probe.processStart(holder.pid);
    if (started === undefined || started === holder.processStart) return 'alive';
    // the PID was reused: only a recorded group can keep the lock alive now
  }
  return readGroups(lockPath).some((pgid) => probe.group(pgid) === 'alive') ? 'alive' : 'dead';
}

/** Age of the lock directory (from its modification time); undefined when it doesn't exist. */
function lockAgeMs(lockPath: string, now: number): number | undefined {
  try {
    return now - statSync(lockPath).mtimeMs;
  } catch {
    return undefined;
  }
}

/** One line naming the holder, for the waiting message and errors. */
export function describeHolder(holder: HeavyLockHolder): string {
  return `${holder.command} (pid ${String(holder.pid)}, since ${holder.startedAt})`;
}

const unique = () => `${String(process.pid)}.${randomBytes(6).toString('hex')}`;
const isCode = (error: unknown, code: string) =>
  (error as NodeJS.ErrnoException | undefined)?.code === code;

/** Takes the lock if it is free: true when this call made it. Atomic (rename of a full directory). */
export function tryTakeLock(lockPath: string, holder: HeavyLockHolder): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  const staging = `${lockPath}.${unique()}.tmp`;
  mkdirSync(staging);
  try {
    writeFileSync(holderFile(staging), `${JSON.stringify(holder)}\n`);
    try {
      renameSync(staging, lockPath);
      return true;
    } catch (error) {
      if (isCode(error, 'ENOTEMPTY') || isCode(error, 'EEXIST')) return false;
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Removes the lock when it is still held by `token`: renamed away first, then deleted, so the
 * deletion never runs on the lock path another process may take the next instant. True when it
 * removed it.
 */
export function releaseLock(lockPath: string, token: string): boolean {
  if (readHolder(lockPath)?.token !== token) return false;
  const away = `${lockPath}.${unique()}.released`;
  try {
    renameSync(lockPath, away);
  } catch {
    return false;
  }
  // Only the holder releases its lock and a live holder's lock is never broken, so between the
  // read above and the rename nobody else can have replaced it: `away` is ours.
  rmSync(away, { recursive: true, force: true });
  return true;
}

/** Unlinks a file, ignoring that someone else removed it first. */
function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error;
  }
}

/**
 * Removes the lock if it is still the stale one seen (`stale`: the same holder token, or still no
 * valid holder when `stale` is undefined) and `stillStale` agrees, under the guard `<lock>.break`.
 * The guard is made by hard-linking a complete file (atomic, never seen empty); a guard whose own
 * writer is dead (`ESRCH`) is removed, and one that vanishes meanwhile is simply retried later.
 * True only when this call removed the lock or found it gone.
 */
export function breakStaleLock(
  lockPath: string,
  stale: HeavyLockHolder | undefined,
  stillStale: (current: HeavyLockHolder | undefined) => boolean,
  pidLiveness: (pid: number) => Liveness = (pid) => processLiveness(pid),
): boolean {
  const guard = `${lockPath}.break`;
  const draft = `${lockPath}.${unique()}.break`;
  writeFileSync(draft, String(process.pid));
  try {
    try {
      linkSync(draft, guard);
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      let owner: number;
      try {
        owner = Number(readFileSync(guard, 'utf8'));
      } catch (readError) {
        if (isCode(readError, 'ENOENT')) return false; // the other breaker just finished
        throw readError;
      }
      if (Number.isInteger(owner) && owner > 0 && pidLiveness(owner) === 'dead') {
        unlinkQuietly(guard);
      }
      return false; // someone else is breaking it; try again on the next poll
    }
    try {
      if (!lockExists(lockPath)) return true;
      const current = readHolder(lockPath);
      if (current?.token !== stale?.token || !stillStale(current)) return false;
      const away = `${lockPath}.${unique()}.stale`;
      renameSync(lockPath, away);
      rmSync(away, { recursive: true, force: true });
      return true;
    } finally {
      unlinkQuietly(guard);
    }
  } finally {
    rmSync(draft, { force: true });
  }
}

function lockExists(lockPath: string): boolean {
  try {
    statSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export interface HeavyLock {
  readonly holder: HeavyLockHolder;
  /** True when the lock was inherited from a parent (`SHOPFLOOR_HEAVY_LOCK`); release is a no-op. */
  readonly inherited: boolean;
  /** Variables for child processes, so they inherit the lock. */
  readonly env: Readonly<Record<string, string>>;
  /** Records a process group started under the lock (kept alive while it runs). */
  recordGroup(pgid: number): void;
  /** Releases the lock (synchronous, so it can run in an `exit` handler); idempotent. */
  release(): void;
}

export interface AcquireOptions {
  /** What runs under the lock, for the waiting message of others. */
  readonly command: string;
  readonly lockPath?: string;
  /** Default: `HEAVY_LOCK_TIMEOUT_MS` from `env`, else 3 hours. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  /** How long a lock without a valid holder is waited for before it is stale (default 60 s). */
  readonly noHolderGraceMs?: number;
  /** Default `process.env`: where `SHOPFLOOR_HEAVY_LOCK` and `HEAVY_LOCK_TIMEOUT_MS` are read. */
  readonly env?: NodeJS.ProcessEnv;
  readonly pid?: number;
  readonly log?: (message: string) => void;
  readonly probe?: LockProbe;
  readonly now?: () => number;
}

export class HeavyLockTimeoutError extends Error {
  readonly holder: HeavyLockHolder | undefined;
  readonly timeoutMs: number;

  constructor(holder: HeavyLockHolder | undefined, timeoutMs: number) {
    super(
      `the heavy-suite lock was not free within ${String(timeoutMs)} ms (HEAVY_LOCK_TIMEOUT_MS)` +
        (holder ? `; held by ${describeHolder(holder)}` : ''),
    );
    this.name = 'HeavyLockTimeoutError';
    this.holder = holder;
    this.timeoutMs = timeoutMs;
  }
}

/** `HEAVY_LOCK_TIMEOUT_MS` as a number of milliseconds, else the 3-hour default. */
export function lockTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HEAVY_LOCK_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_HEAVY_LOCK_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`HEAVY_LOCK_TIMEOUT_MS must be a number of milliseconds, not "${raw}"`);
  }
  return value;
}

/**
 * Takes the heavy-suite lock, or inherits it when `SHOPFLOOR_HEAVY_LOCK` names the current
 * holder's token. Waits while the lock is alive (`holderLiveness`), breaks it when stale, and
 * fails with `HeavyLockTimeoutError` after the timeout; a break that doesn't succeed (another
 * process holds the guard) waits like any other poll.
 */
export async function acquireHeavyLock(options: AcquireOptions): Promise<HeavyLock> {
  const lockPath = options.lockPath ?? HEAVY_LOCK_PATH;
  const env = options.env ?? process.env;
  const log =
    options.log ??
    ((message: string) => {
      console.error(message);
    });
  const probe = options.probe ?? systemProbe;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? lockTimeoutMs(env);
  const pollMs = options.pollMs ?? 2_000;
  const grace = options.noHolderGraceMs ?? NO_HOLDER_GRACE_MS;
  const groupRecorder =
    (token: string) =>
    (pgid: number): void => {
      recordGroup(lockPath, token, pgid);
    };

  const inheritedToken = env[HEAVY_LOCK_ENV];
  if (inheritedToken !== undefined && inheritedToken !== '') {
    const current = readHolder(lockPath);
    if (current?.token === inheritedToken) {
      return {
        holder: current,
        inherited: true,
        env: { [HEAVY_LOCK_ENV]: inheritedToken },
        recordGroup: groupRecorder(inheritedToken),
        release: () => undefined,
      };
    }
    log(`heavy lock: ${HEAVY_LOCK_ENV} names no current lock; taking it afresh`);
  }

  const pid = options.pid ?? process.pid;
  const boot = probe.boot();
  const processStart = probe.processStart(pid);
  const holder: HeavyLockHolder = {
    pid,
    command: options.command,
    startedAt: new Date(now()).toISOString(),
    token: `${String(pid)}-${randomBytes(8).toString('hex')}`,
    ...(boot === undefined ? {} : { boot }),
    ...(processStart === undefined ? {} : { processStart }),
  };
  const deadline = now() + timeoutMs;
  /** Tokens (or `-` for a lock without a holder) already announced as waiting or stale. */
  const announced = new Set<string>();
  const once = (key: string, message: string) => {
    if (announced.has(key)) return;
    announced.add(key);
    log(message);
  };
  for (;;) {
    if (tryTakeLock(lockPath, holder)) break;
    const current = readHolder(lockPath);
    const stillStale = (seen: HeavyLockHolder | undefined): boolean =>
      seen === undefined
        ? (lockAgeMs(lockPath, now()) ?? 0) >= grace
        : holderLiveness(lockPath, seen, probe) === 'dead';
    if (current === undefined) {
      if (stillStale(undefined)) {
        once('stale:-', `heavy lock: removing ${lockPath}, which has no valid holder.json`);
        if (breakStaleLock(lockPath, undefined, stillStale, probe.pid)) continue;
      } else {
        once(
          'wait:-',
          `heavy lock: waiting for ${lockPath}, which has no valid holder.json (stale after ${String(grace)} ms)`,
        );
      }
    } else if (stillStale(current)) {
      once(
        `stale:${current.token}`,
        `heavy lock: removing the stale lock of ${describeHolder(current)} (no such process or group, a reused PID or an earlier boot)`,
      );
      if (breakStaleLock(lockPath, current, stillStale, probe.pid)) continue;
    } else {
      once(
        `wait:${current.token}`,
        `heavy lock: waiting for ${describeHolder(current)} (${lockPath})`,
      );
    }
    if (now() >= deadline) throw new HeavyLockTimeoutError(current, timeoutMs);
    await sleep(Math.max(1, Math.min(pollMs, deadline - now())));
  }
  let released = false;
  return {
    holder,
    inherited: false,
    env: { [HEAVY_LOCK_ENV]: holder.token },
    recordGroup: groupRecorder(holder.token),
    release: () => {
      if (released) return;
      released = true;
      releaseLock(lockPath, holder.token);
    },
  };
}

// --- Disk ---

/** Free bytes for an unprivileged user on the file system holding `path`. */
export function hostFreeBytes(path: string): number {
  const stats = statfsSync(path);
  return stats.bavail * stats.bsize;
}

/**
 * The free bytes from POSIX `df -Pk` output (header, then one line per file system; the last line
 * is the one asked for). Read from the right, by the capacity column (`NN%`), so a file-system
 * name with spaces doesn't shift it.
 */
export function parseDfAvailableBytes(output: string): number {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const last = lines.at(-1);
  if (lines.length < 2 || last === undefined) {
    throw new Error(`df printed no file system line: ${JSON.stringify(output)}`);
  }
  const fields = last.split(/\s+/);
  const capacity = fields.findLastIndex((field) => /^\d+%$/.test(field));
  const available = capacity > 0 ? fields[capacity - 1] : undefined;
  if (available === undefined || !/^\d+$/.test(available)) {
    throw new Error(`df printed no available size: ${JSON.stringify(last)}`);
  }
  return Number(available) * 1024;
}

/** The broker's image in docker-compose.yml: small, always present, with BusyBox `df`. */
export function diskProbeImage(composeYaml: string): string {
  const image = /^\s*image:\s*['"]?(eclipse-mosquitto:[^\s'"]+)/m.exec(composeYaml)?.[1];
  if (image === undefined) throw new Error('docker-compose.yml names no eclipse-mosquitto image');
  return image;
}

const execFileAsync = promisify(execFile);

/**
 * Free bytes in Docker's data root, measured inside the VM: `df -Pk /` in a throw-away container
 * (no network, never pulled: the probe must not download anything) of `image`, whose overlay root
 * reports the data root's file system.
 */
export async function dockerFreeBytes(image: string): Promise<number> {
  const { stdout } = await execFileAsync(
    'docker',
    [
      'run',
      '--rm',
      '--pull',
      'never',
      '--network',
      'none',
      '--entrypoint',
      'df',
      image,
      '-Pk',
      '/',
    ],
    { timeout: 120_000 },
  );
  return parseDfAvailableBytes(stdout);
}

/** Why the Docker disk probe failed, in words a developer can act on. */
export function dockerProbeProblem(image: string, error: unknown): string {
  const text = [
    error instanceof Error ? error.message : String(error),
    (error as { stderr?: unknown } | undefined)?.stderr,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  if (/no such image|not found|pull access denied|--pull never/i.test(text)) {
    return `the disk probe's image ${image} is not on this machine (it is never pulled): run \`docker pull ${image}\` once, then retry`;
  }
  if (
    /cannot connect to the docker daemon|is the docker daemon running|docker\.sock|ENOENT/i.test(
      text,
    )
  ) {
    return `Docker is not running (needed to measure its free space; heavy commands need Docker): start it (\`colima start\`) and retry`;
  }
  return `could not measure Docker's free space (docker run ${image} df): ${text.trim()}`;
}

const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`;

/** The reasons a heavy command must not start, each saying which disk; empty when both suffice. */
export function diskProblems(free: {
  readonly host: number;
  readonly docker: number;
  readonly hostPath: string;
}): string[] {
  const problems: string[] = [];
  if (free.host < MIN_HOST_FREE_BYTES) {
    problems.push(
      `the host has ${gib(free.host)} free on ${free.hostPath}, below ${gib(MIN_HOST_FREE_BYTES)}`,
    );
  }
  if (free.docker < MIN_DOCKER_FREE_BYTES) {
    problems.push(
      `Docker's data root (inside the VM) has ${gib(free.docker)} free, below ${gib(MIN_DOCKER_FREE_BYTES)}`,
    );
  }
  return problems;
}

/** Measures both disks for a repository and returns `diskProblems`, with the figures measured. */
export async function checkDisks(
  repo: string,
): Promise<{ problems: string[]; host: number; docker: number }> {
  const host = hostFreeBytes(repo);
  const image = diskProbeImage(readFileSync(join(repo, 'docker-compose.yml'), 'utf8'));
  let docker: number;
  try {
    docker = await dockerFreeBytes(image);
  } catch (error) {
    return { problems: [dockerProbeProblem(image, error)], host, docker: Number.NaN };
  }
  return { problems: diskProblems({ host, docker, hostPath: repo }), host, docker };
}

/** Prunes the BuildKit cache to `BUILD_CACHE_KEEP`; a failure is reported, not thrown. */
export async function pruneBuildCache(log: (message: string) => void = console.error) {
  try {
    await execFileAsync(
      'docker',
      // --all: without it only dangling records may go, and the cache can stay above the cap.
      // Machine-wide: it prunes every project's build cache down to the cap, newest kept.
      ['builder', 'prune', '--force', '--all', '--keep-storage', BUILD_CACHE_KEEP],
      { timeout: 600_000 },
    );
    log(`build cache pruned to ${BUILD_CACHE_KEEP}`);
  } catch (error) {
    log(
      `could not prune the build cache: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const formatGib = gib;
