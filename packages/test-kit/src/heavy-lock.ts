/**
 * The host-wide heavy-suite lock (#228, Phase 9 plan "Local gate"): one heavy command at a time on
 * the machine (`gate`, `verify` and its Testcontainers suites, `test:e2e`, `test:reconcile`,
 * `test:resilience`, `test:perf`, `test:trace-perf`, Playwright), however many worktrees or agents
 * share it. Phase 8 lost runs to two agents' suites at once (#212, #216, #218).
 *
 * - **Where:** a directory at a fixed absolute path, `~/.cache/shopfloor-twin/heavy.lock`, never
 *   under `os.tmpdir()` (per session under the sandbox, so two sessions would not see each other's).
 * - **What it holds:** `holder.json` with the holder's PID, command, start time and a token. The
 *   directory is made complete in a private temporary directory and renamed into place: rename
 *   onto an existing, non-empty directory fails, so taking the lock is atomic and a lock never
 *   exists without its holder.
 * - **Waiting:** a command that finds the lock taken prints the holder and polls until it is free,
 *   up to `HEAVY_LOCK_TIMEOUT_MS` (default 3 hours), then fails.
 * - **Stale:** only when `kill(pid, 0)` fails with `ESRCH` (no such process). `EPERM` means the
 *   holder is alive under another user, and any other answer counts as alive. Breaking a stale
 *   lock happens under a short guard file (`heavy.lock.break`), so two waiters that both see the
 *   same dead holder can't remove a lock the other has just taken.
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
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

/** The variable through which a holder's children inherit its lock. */
export const HEAVY_LOCK_ENV = 'SHOPFLOOR_HEAVY_LOCK';
/** The lock's fixed path (plan: not `os.tmpdir()`). */
export const HEAVY_LOCK_PATH = join(homedir(), '.cache', 'shopfloor-twin', 'heavy.lock');
/** How long a command waits for the lock unless `HEAVY_LOCK_TIMEOUT_MS` says otherwise. */
export const DEFAULT_HEAVY_LOCK_TIMEOUT_MS = 3 * 3_600_000;

const GIB = 1024 ** 3;
/** Free space a heavy command needs on the host's file system holding the repository. */
export const MIN_HOST_FREE_BYTES = 25 * GIB;
/** Free space a heavy command needs in Docker's data root (inside the VM). */
export const MIN_DOCKER_FREE_BYTES = 15 * GIB;
/** The BuildKit cache kept after a build (`docker builder prune --keep-storage`). */
export const BUILD_CACHE_KEEP = '10GB';

export interface HeavyLockHolder {
  readonly pid: number;
  readonly command: string;
  /** ISO time the holder took the lock. */
  readonly startedAt: string;
  /** Unique per acquisition: what `SHOPFLOOR_HEAVY_LOCK` carries to the holder's children. */
  readonly token: string;
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

/** One line naming the holder, for the waiting message and errors. */
export function describeHolder(holder: HeavyLockHolder): string {
  return `${holder.command} (pid ${String(holder.pid)}, since ${holder.startedAt})`;
}

const unique = () => `${String(process.pid)}.${randomBytes(6).toString('hex')}`;

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
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
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

/**
 * Removes the lock if its holder is the given dead one, under the guard `<lock>.break`. The guard
 * is made by hard-linking a complete file (atomic, never seen empty); a guard whose own writer is
 * dead (`ESRCH`) is removed. True when the stale lock is gone (by this call or another's).
 */
export function breakStaleLock(
  lockPath: string,
  stale: HeavyLockHolder,
  liveness: (pid: number) => Liveness = processLiveness,
): boolean {
  const guard = `${lockPath}.break`;
  const draft = `${lockPath}.${unique()}.break`;
  writeFileSync(draft, String(process.pid));
  try {
    try {
      linkSync(draft, guard);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(readFileSync(guard, 'utf8'));
      if (Number.isInteger(owner) && owner > 0 && liveness(owner) === 'dead') {
        unlinkSync(guard);
      }
      return false; // someone else is breaking it; try again on the next poll
    }
    try {
      const current = readHolder(lockPath);
      if (current === undefined) return true;
      if (current.token !== stale.token || liveness(current.pid) !== 'dead') return false;
      const away = `${lockPath}.${unique()}.stale`;
      renameSync(lockPath, away);
      rmSync(away, { recursive: true, force: true });
      return true;
    } finally {
      unlinkSync(guard);
    }
  } finally {
    rmSync(draft, { force: true });
  }
}

export interface HeavyLock {
  readonly holder: HeavyLockHolder;
  /** True when the lock was inherited from a parent (`SHOPFLOOR_HEAVY_LOCK`); release is a no-op. */
  readonly inherited: boolean;
  /** Variables for child processes, so they inherit the lock. */
  readonly env: Readonly<Record<string, string>>;
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
  /** Default `process.env`: where `SHOPFLOOR_HEAVY_LOCK` and `HEAVY_LOCK_TIMEOUT_MS` are read. */
  readonly env?: NodeJS.ProcessEnv;
  readonly pid?: number;
  readonly log?: (message: string) => void;
  readonly liveness?: (pid: number) => Liveness;
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
 * holder's token. Waits while a live process holds it, breaks it when its holder is dead (ESRCH),
 * and fails with `HeavyLockTimeoutError` after the timeout.
 */
export async function acquireHeavyLock(options: AcquireOptions): Promise<HeavyLock> {
  const lockPath = options.lockPath ?? HEAVY_LOCK_PATH;
  const env = options.env ?? process.env;
  const log =
    options.log ??
    ((message: string) => {
      console.error(message);
    });
  const liveness = options.liveness ?? ((pid: number) => processLiveness(pid));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? lockTimeoutMs(env);
  const pollMs = options.pollMs ?? 2_000;

  const inheritedToken = env[HEAVY_LOCK_ENV];
  if (inheritedToken !== undefined && inheritedToken !== '') {
    const current = readHolder(lockPath);
    if (current?.token === inheritedToken) {
      return {
        holder: current,
        inherited: true,
        env: { [HEAVY_LOCK_ENV]: inheritedToken },
        release: () => undefined,
      };
    }
    log(`heavy lock: ${HEAVY_LOCK_ENV} names no current lock; taking it afresh`);
  }

  const holder: HeavyLockHolder = {
    pid: options.pid ?? process.pid,
    command: options.command,
    startedAt: new Date(now()).toISOString(),
    token: `${String(options.pid ?? process.pid)}-${randomBytes(8).toString('hex')}`,
  };
  const deadline = now() + timeoutMs;
  let announced: string | undefined;
  for (;;) {
    if (tryTakeLock(lockPath, holder)) break;
    const current = readHolder(lockPath);
    if (current !== undefined && liveness(current.pid) === 'dead') {
      log(`heavy lock: removing the stale lock of ${describeHolder(current)} (no such process)`);
      breakStaleLock(lockPath, current, liveness);
      continue;
    }
    if (current !== undefined && current.token !== announced) {
      announced = current.token;
      log(`heavy lock: waiting for ${describeHolder(current)} (${lockPath})`);
    }
    if (now() >= deadline) throw new HeavyLockTimeoutError(current, timeoutMs);
    await sleep(Math.max(1, Math.min(pollMs, deadline - now())));
  }
  let released = false;
  return {
    holder,
    inherited: false,
    env: { [HEAVY_LOCK_ENV]: holder.token },
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
 * (no network) of `image`, whose overlay root reports the data root's file system.
 */
export async function dockerFreeBytes(image: string): Promise<number> {
  const { stdout } = await execFileAsync(
    'docker',
    ['run', '--rm', '--network', 'none', '--entrypoint', 'df', image, '-Pk', '/'],
    { timeout: 120_000 },
  );
  return parseDfAvailableBytes(stdout);
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
    return {
      problems: [
        `could not measure Docker's free space (docker run ${image} df): ${error instanceof Error ? error.message : String(error)}`,
      ],
      host,
      docker: Number.NaN,
    };
  }
  return { problems: diskProblems({ host, docker, hostPath: repo }), host, docker };
}

/** Prunes the BuildKit cache to `BUILD_CACHE_KEEP`; a failure is reported, not thrown. */
export async function pruneBuildCache(log: (message: string) => void = console.error) {
  try {
    await execFileAsync(
      'docker',
      ['builder', 'prune', '--force', '--keep-storage', BUILD_CACHE_KEEP],
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
