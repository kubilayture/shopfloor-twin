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
 *   holder (and any child that inherits it) adds a `group-<pgid>` file, holding the group
 *   leader's start time, for each process group it starts detached, so the suite it runs keeps
 *   the lock alive after its own death.
 * - **Waiting, first come, first served (#348):** a command that finds the lock taken prints the
 *   holder and its place in the queue and polls until it is free, up to `HEAVY_LOCK_TIMEOUT_MS`
 *   (default 3 hours), then fails. Every waiter first takes a ticket in the queue directory beside
 *   the lock (`heavy.lock.queue/ticket-<sequence>`, see "Queue" below) and tries the lock only when
 *   its ticket is the oldest live one, so a short job no longer starves behind later long ones.
 * - **Stale:** the lock is alive while its holder's PID answers `kill(pid, 0)` (or `EPERM`: another
 *   user's process) **or** any recorded process group answers `kill(-pgid, 0)`. Start times are
 *   read with `ps` in a fixed locale and time zone and compared as instants: a live PID with the
 *   recorded start time is conclusive, one with another start time was reused (dead), and when
 *   they can't be compared the PID counts as alive unless the boot time differs by more than
 *   5 minutes (an earlier boot). A recorded group is dead when its leader's PID now belongs to a
 *   process started at another time (a reused PGID). A lock directory without a valid
 *   `holder.json` (made by hand, or truncated) is waited for and counted stale only after a grace
 *   period. Breaking a stale lock happens under a short guard file (`heavy.lock.break`), so two
 *   waiters that see the same dead holder can't remove a lock the other has just taken; a guard
 *   whose writer is gone, or older than a minute, is removed.
 * - **Children:** the holder passes its token in `SHOPFLOOR_HEAVY_LOCK`; a command started under
 *   it (the gate's `verify`, the reconciliation's Playwright) finds its own token in the lock and
 *   runs without waiting on its parent.
 * - **Release:** the holder renames the directory away (only when the token is still its own) and
 *   removes it, so a release never deletes a lock another process took meanwhile.
 * - **Queue (#348):** a ticket is a complete JSON file (the waiter's PID, command, start and token)
 *   hard-linked into `heavy.lock.queue` under the name `ticket-<sequence>` (12 digits): the link
 *   fails with `EEXIST` when the name is taken, so two waiters never share a sequence and nobody
 *   ever reads a half-written ticket; the sequence is the highest one in the queue plus one,
 *   retried upwards on `EEXIST`. The waiter touches its ticket on every poll (a heartbeat). A
 *   ticket is dead when its PID answers `ESRCH`, or when it was not touched for
 *   `TICKET_STALE_MS` (a waiter stopped, or its PID reused after it died; not judged by a waiter
 *   that itself slept that long, so a machine waking up doesn't make every ticket look stale);
 *   the waiter behind removes it and says so, once. A waiter that finds its own ticket gone takes
 *   it again under the same name when it is free (keeping its place), else a new one at the end.
 *   It removes its ticket when it takes the lock, times out or fails. The head of the queue polls
 *   every `HEAD_POLL_MS` (at most), so a release is taken up within a fraction of a second.
 *   Taking the lock is still the atomic rename above: the queue decides who tries, never whether
 *   two hold it, so a ticket removed by mistake costs at most one turn, never exclusivity.
 * - **Waiters of the old code (before #348)** take no ticket and keep trying the lock every 2 s
 *   while it is held. Such a waiter can still take a lock the head of the queue was about to
 *   take; the head then sees an ordinary live holder, keeps its ticket and place, and waits for
 *   that holder like any other. Both versions share the lock directory, `holder.json`, the
 *   `group-<pgid>` files and the break guard unchanged, and the old code never reads the queue
 *   directory, so they coexist until every worktree runs this code (the fast head poll makes an
 *   old waiter's win unlikely meanwhile).
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
  utimesSync,
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
/** A break guard older than this is left over (its writer died, its PID maybe reused). */
export const GUARD_MAX_AGE_MS = 60_000;
/** How long a lock directory without a valid holder is waited for before it counts as stale. */
export const NO_HOLDER_GRACE_MS = 60_000;
/** A queue ticket not touched (its waiter's heartbeat) for longer than this is stale (#348). */
export const TICKET_STALE_MS = 60_000;
/** The longest the head of the queue waits between two tries of the lock (#348). */
export const HEAD_POLL_MS = 200;

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
  /** The machine's boot time when the lock was taken (consulted when start times can't be). */
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

/**
 * Boot times further apart than this mean another boot: `kern.boottime` moves when the clock is
 * stepped, and Linux's `btime` jitters by a second, so exact equality would break live locks.
 */
export const BOOT_TOLERANCE_S = 300;

/** Whether two recorded boot times are surely different boots; false when either is unknown. */
export function differentBoot(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) > BOOT_TOLERANCE_S;
}

/**
 * A process's start time as `ps -o lstart=` prints it, in a fixed environment (`LC_ALL=C`,
 * `TZ=UTC`): the text depends on the caller's locale and time zone, and a holder and a waiter in
 * different terminals (a Turkish-locale shell and an agent's, say) must read the same text.
 * Undefined when there is no such process.
 */
export function processStartTime(pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
    })
      .trim()
      .replace(/\s+/g, ' ');
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

/** A `ps -o lstart=` text from `processStartTime` (C locale, UTC) as an instant, or undefined. */
export function parseProcessStart(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const match = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(
    text.trim().replace(/\s+/g, ' '),
  );
  if (match === null) return undefined;
  const [, month, day, time, year] = match;
  const instant = Date.parse(`${month ?? ''} ${day ?? ''} ${year ?? ''} ${time ?? ''} UTC`);
  return Number.isFinite(instant) ? instant : undefined;
}

/**
 * Whether two start times name the same process start: `same` or `different` only when both
 * parse as instants; `unknown` otherwise (an older record, another format), which never counts
 * as a reused PID.
 */
export function compareStarts(
  recorded: string | undefined,
  current: string | undefined,
): 'same' | 'different' | 'unknown' {
  const a = parseProcessStart(recorded);
  const b = parseProcessStart(current);
  if (a === undefined || b === undefined) return 'unknown';
  return a === b ? 'same' : 'different';
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

export interface RecordedGroup {
  readonly pgid: number;
  /** The group leader's start time when it was recorded (`processStartTime`), if known. */
  readonly leaderStart: string | undefined;
}

/** The process groups recorded in the lock (`group-<pgid>` files holding the leader's start). */
export function readGroups(lockPath: string): RecordedGroup[] {
  let names: string[];
  try {
    names = readdirSync(lockPath);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const pgid = Number(/^group-(\d+)$/.exec(name)?.[1]);
    if (!Number.isInteger(pgid) || pgid <= 1) return [];
    let text = '';
    try {
      text = readFileSync(join(lockPath, name), 'utf8').trim();
    } catch {
      // removed meanwhile, or unreadable: no start recorded
    }
    return [{ pgid, leaderStart: text === '' ? undefined : text }];
  });
}

/**
 * Records a process group the lock's holder (or a child that inherited it) started, with its
 * leader's start time, so the lock stays alive while that group runs. Only while `token` still
 * holds the lock; false otherwise.
 */
export function recordGroup(
  lockPath: string,
  token: string,
  pgid: number,
  leaderStart?: string,
): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  if (readHolder(lockPath)?.token !== token) return false;
  try {
    writeFileSync(join(lockPath, `group-${String(pgid)}`), leaderStart ?? '');
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a recorded group still runs: its group answers `kill(-pgid, 0)`, unless a process with
 * PID `pgid` exists with another start time than its recorded leader's (the PGID was reused).
 */
function groupLiveness(group: RecordedGroup, probe: LockProbe): Liveness {
  if (probe.group(group.pgid) !== 'alive') return 'dead';
  if (probe.pid(group.pgid) === 'alive') {
    const current = probe.processStart(group.pgid);
    if (compareStarts(group.leaderStart, current) === 'different') return 'dead';
  }
  return 'alive';
}

/**
 * Whether a holder still holds its lock. A live PID with the recorded start time is conclusive;
 * one with another start time was reused. When the start times can't be compared (unknown either
 * side), a boot more than `BOOT_TOLERANCE_S` away from the recorded one means the PID is from an
 * earlier boot; otherwise the live PID counts. Failing the PID, the lock is alive while any
 * recorded group runs (`groupLiveness`).
 */
export function holderLiveness(
  lockPath: string,
  holder: HeavyLockHolder,
  probe: LockProbe = systemProbe,
): Liveness {
  if (probe.pid(holder.pid) === 'alive') {
    const starts = compareStarts(holder.processStart, probe.processStart(holder.pid));
    if (starts === 'same') return 'alive';
    if (starts === 'unknown' && !differentBoot(holder.boot, probe.boot())) return 'alive';
    // a reused PID, or one from an earlier boot: only a recorded group can keep the lock alive
  }
  return readGroups(lockPath).some((group) => groupLiveness(group, probe) === 'alive')
    ? 'alive'
    : 'dead';
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
      let ageMs: number;
      try {
        owner = Number(readFileSync(guard, 'utf8'));
        ageMs = Date.now() - statSync(guard).mtimeMs;
      } catch (readError) {
        if (isCode(readError, 'ENOENT')) return false; // the other breaker just finished
        throw readError;
      }
      // A guard is held for microseconds: one whose writer is gone, or that is older than
      // `GUARD_MAX_AGE_MS` (its writer's PID reused meanwhile), is left over and removed.
      if (
        ageMs > GUARD_MAX_AGE_MS ||
        (Number.isInteger(owner) && owner > 0 && pidLiveness(owner) === 'dead')
      ) {
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

// --- Queue (#348) ---

/** The queue directory beside a lock (`<lock>.queue`): never inside it, which a release removes. */
export function queuePath(lockPath: string): string {
  return `${lockPath}.queue`;
}

/** What a waiter's ticket holds. */
export interface QueueTicket {
  readonly pid: number;
  readonly command: string;
  /** ISO time the waiter took its ticket. */
  readonly since: string;
  /** The token the waiter will hold the lock under; tells its ticket from a later one. */
  readonly token: string;
}

/** A ticket in the queue as a waiter sees it. */
export interface QueueEntry {
  readonly name: string;
  readonly seq: number;
  /** Undefined when the file is not a valid ticket (made by hand, say). */
  readonly ticket: QueueTicket | undefined;
  /** Time since the ticket was last touched (its waiter's heartbeat). */
  readonly ageMs: number;
}

const TICKET_NAME = /^ticket-(\d{12})$/;
const DRAFT_NAME = /^draft-.+\.tmp$/;

/** The file name of the ticket with sequence `seq`: zero-padded, so names sort like numbers. */
export function ticketName(seq: number): string {
  return `ticket-${String(seq).padStart(12, '0')}`;
}

/** The ticket in `queue` called `name`; undefined when there is none or it is not valid. */
export function readTicket(queue: string, name: string): QueueTicket | undefined {
  try {
    const value = JSON.parse(readFileSync(join(queue, name), 'utf8')) as Partial<QueueTicket>;
    if (
      typeof value.pid === 'number' &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.command === 'string' &&
      typeof value.since === 'string' &&
      typeof value.token === 'string'
    ) {
      return value as QueueTicket;
    }
  } catch {
    // missing or unreadable
  }
  return undefined;
}

/** The queue's tickets, oldest (lowest sequence) first; drafts and other files are left out. */
export function readQueue(queue: string, now: number = Date.now()): QueueEntry[] {
  let names: string[];
  try {
    names = readdirSync(queue);
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const seq = TICKET_NAME.exec(name)?.[1];
      if (seq === undefined) return [];
      let touched: number;
      try {
        touched = statSync(join(queue, name)).mtimeMs;
      } catch {
        return []; // removed meanwhile
      }
      return [{ name, seq: Number(seq), ticket: readTicket(queue, name), ageMs: now - touched }];
    })
    .sort((a, b) => a.seq - b.seq);
}

/** Writes a complete draft of `ticket` in `queue`, runs `use` with its path, then removes it. */
function withDraft<T>(queue: string, ticket: QueueTicket, use: (draft: string) => T): T {
  mkdirSync(queue, { recursive: true });
  const draft = join(queue, `draft-${unique()}.tmp`);
  writeFileSync(draft, `${JSON.stringify(ticket)}\n`);
  try {
    return use(draft);
  } finally {
    rmSync(draft, { force: true });
  }
}

/** Hard-links `draft` to `name` in `queue`: true when made, false when the name is taken. */
function linkTicket(queue: string, draft: string, name: string): boolean {
  try {
    linkSync(draft, join(queue, name));
    return true;
  } catch (error) {
    if (isCode(error, 'EEXIST')) return false;
    throw error;
  }
}

/**
 * Takes a ticket at the end of the queue and returns its name: the highest sequence in the queue
 * plus one, made by hard-linking a complete draft (atomic: the link fails with `EEXIST` when
 * another waiter took that sequence first, and then the next one is tried), so sequences are
 * unique and a ticket is never seen half-written.
 */
export function takeTicket(queue: string, ticket: QueueTicket): string {
  return withDraft(queue, ticket, (draft) => {
    let seq = Math.max(0, ...readdirSafe(queue).map((name) => ticketSeq(name))) + 1;
    while (!linkTicket(queue, draft, ticketName(seq))) seq += 1;
    return ticketName(seq);
  });
}

/** Takes the ticket `name` again (a waiter whose ticket was removed): false when it is taken. */
export function retakeTicket(queue: string, name: string, ticket: QueueTicket): boolean {
  return withDraft(queue, ticket, (draft) => linkTicket(queue, draft, name));
}

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function ticketSeq(name: string): number {
  const seq = TICKET_NAME.exec(name)?.[1];
  return seq === undefined ? 0 : Number(seq);
}

/**
 * Removes the ticket `name` when it is still the one seen (`token`; undefined for a ticket that
 * was not valid): true when this call removed it.
 */
export function removeTicket(queue: string, name: string, token: string | undefined): boolean {
  if (readTicket(queue, name)?.token !== token) return false;
  try {
    unlinkSync(join(queue, name));
    return true;
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false;
    throw error;
  }
}

/** Touches a ticket (its waiter's heartbeat): false when it is gone. */
export function touchTicket(queue: string, name: string): boolean {
  const at = new Date();
  try {
    utimesSync(join(queue, name), at, at);
    return true;
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false;
    throw error;
  }
}

/**
 * Whether a ticket's waiter still waits: dead when its PID answers `ESRCH`, or (only when
 * `judgeAge`) when it was not touched for longer than `staleMs`, the only test of a ticket that is
 * not valid.
 */
export function ticketLiveness(
  entry: QueueEntry,
  probe: Pick<LockProbe, 'pid'>,
  staleMs: number,
  judgeAge: boolean,
): Liveness {
  if (entry.ticket !== undefined && probe.pid(entry.ticket.pid) === 'dead') return 'dead';
  if (judgeAge && entry.ageMs > staleMs) return 'dead';
  return 'alive';
}

/** Removes drafts left by a waiter killed while taking a ticket (a draft lives microseconds). */
export function removeOldDrafts(queue: string, now: number = Date.now()): void {
  for (const name of readdirSafe(queue)) {
    if (!DRAFT_NAME.test(name)) continue;
    try {
      if (now - statSync(join(queue, name)).mtimeMs > GUARD_MAX_AGE_MS) {
        rmSync(join(queue, name), { force: true });
      }
    } catch {
      // removed meanwhile
    }
  }
}

/** One line naming a waiter, for the messages. */
export function describeTicket(ticket: QueueTicket): string {
  return `${ticket.command} (pid ${String(ticket.pid)}, waiting since ${ticket.since})`;
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
  /** The longest the head of the queue waits between tries (default `HEAD_POLL_MS`). */
  readonly headPollMs?: number;
  /** How long a queue ticket may go untouched before it is stale (default `TICKET_STALE_MS`). */
  readonly ticketStaleMs?: number;
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

/** Where a waiter stands in the queue after the dead tickets ahead of it were removed. */
export interface QueuePlace {
  /** 1 for the head of the queue. */
  readonly place: number;
  /** Live tickets, this waiter's included. */
  readonly total: number;
  /** The oldest live ticket ahead of this waiter, if any. */
  readonly first: QueueEntry | undefined;
}

/**
 * Reads the queue for the waiter holding ticket `own`, removing every dead ticket it sees
 * (`ticketLiveness`; `removed` is told of each one this call removed), and returns its place.
 */
export function queuePlace(
  queue: string,
  own: string,
  probe: Pick<LockProbe, 'pid'>,
  staleMs: number,
  judgeAge: boolean,
  removed: (entry: QueueEntry) => void = () => undefined,
  now: number = Date.now(),
): QueuePlace {
  const ownSeq = ticketSeq(own);
  let place = 1;
  let total = 0;
  let first: QueueEntry | undefined;
  for (const entry of readQueue(queue, now)) {
    if (entry.name !== own && ticketLiveness(entry, probe, staleMs, judgeAge) === 'dead') {
      if (removeTicket(queue, entry.name, entry.ticket?.token)) removed(entry);
      continue;
    }
    total += 1;
    if (entry.seq < ownSeq) {
      place += 1;
      first ??= entry;
    }
  }
  return { place, total, first };
}

/**
 * Takes the heavy-suite lock, or inherits it when `SHOPFLOOR_HEAVY_LOCK` names the current
 * holder's token. Takes a ticket in the queue (#348) and tries the lock only at the head of it:
 * waits while the lock is alive (`holderLiveness`), breaks it when stale, and fails with
 * `HeavyLockTimeoutError` after the timeout; a break that doesn't succeed (another process holds
 * the guard) waits like any other poll. The ticket is removed however this ends.
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
  const headPollMs = options.headPollMs ?? HEAD_POLL_MS;
  const staleMs = options.ticketStaleMs ?? TICKET_STALE_MS;
  const grace = options.noHolderGraceMs ?? NO_HOLDER_GRACE_MS;
  const groupRecorder =
    (token: string) =>
    (pgid: number): void => {
      recordGroup(lockPath, token, pgid, probe.processStart(pgid));
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
  /** Keys already announced: waiting (per holder, and per place behind the head) and stale. */
  const announced = new Set<string>();
  const once = (key: string, message: string) => {
    if (announced.has(key)) return;
    announced.add(key);
    log(message);
  };

  const queue = queuePath(lockPath);
  const ticket: QueueTicket = {
    pid,
    command: options.command,
    since: holder.startedAt,
    token: holder.token,
  };
  let own = takeTicket(queue, ticket);
  let lastBeat = Date.now();
  /** Touches this waiter's ticket, or takes it again (same name if free) when it was removed. */
  const keepTicket = () => {
    if (readTicket(queue, own)?.token === holder.token && touchTicket(queue, own)) return;
    if (!retakeTicket(queue, own, ticket)) own = takeTicket(queue, ticket);
    log(`heavy lock: this waiter's queue ticket was removed; queued again as ${own}`);
  };
  const ticketRemoved = (entry: QueueEntry) => {
    const who =
      entry.ticket === undefined
        ? `${entry.name} (not a valid ticket)`
        : describeTicket(entry.ticket);
    // Once per ticket: only the call that removed it reports it.
    log(
      `heavy lock: removing the queue ticket of ${who} (no such process, or no heartbeat for ${String(staleMs)} ms)`,
    );
  };

  try {
    for (;;) {
      const beat = Date.now();
      // A waiter that itself went without a poll for a while (the machine slept) doesn't judge
      // the others' heartbeats on this poll: theirs are as old as its own.
      const judgeAge = beat - lastBeat <= staleMs / 2;
      lastBeat = beat;
      keepTicket();
      removeOldDrafts(queue, beat);
      const { place, total, first } = queuePlace(
        queue,
        own,
        probe,
        staleMs,
        judgeAge,
        ticketRemoved,
        beat,
      );
      const inQueue = `place ${String(place)} of ${String(total)} in the queue`;
      let current: HeavyLockHolder | undefined;
      if (place === 1) {
        if (tryTakeLock(lockPath, holder)) break;
        current = readHolder(lockPath);
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
              `heavy lock: waiting for ${lockPath}, which has no valid holder.json (stale after ${String(grace)} ms), ${inQueue}`,
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
            `heavy lock: waiting for ${describeHolder(current)} (${lockPath}), ${inQueue}`,
          );
        }
      } else {
        // Behind others: only the head tries the lock (and breaks a stale one).
        current = readHolder(lockPath);
        const ahead = first?.ticket
          ? describeTicket(first.ticket)
          : `${first?.name ?? 'a ticket'} (not a valid ticket)`;
        once(
          `wait:${current?.token ?? '-'}:${String(place)}`,
          current === undefined
            ? `heavy lock: waiting behind ${ahead}, ${inQueue} (${lockPath})`
            : `heavy lock: waiting for ${describeHolder(current)} (${lockPath}), ${inQueue}, behind ${ahead}`,
        );
      }
      if (now() >= deadline) throw new HeavyLockTimeoutError(current, timeoutMs);
      // The head polls fast, so a release is taken up at once; nobody sleeps past a heartbeat.
      const interval = Math.min(place === 1 ? Math.min(pollMs, headPollMs) : pollMs, staleMs / 4);
      await sleep(Math.max(1, Math.min(interval, deadline - now())));
    }
  } finally {
    removeTicket(queue, own, holder.token);
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
