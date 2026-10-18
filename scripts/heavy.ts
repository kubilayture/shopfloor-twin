/**
 * Runs a heavy command under the host-wide heavy-suite lock (#228, Phase 9 plan "Local gate";
 * `@shopfloor/test-kit/heavy-lock`): `pnpm verify`, `pnpm test`, `pnpm test:e2e`,
 * `pnpm test:reconcile` and `pnpm test:trace-perf` start through it, and `pnpm gate` takes the
 * same lock itself.
 *
 * - Takes `~/.cache/shopfloor-twin/heavy.lock`, waiting (and saying for whom) while another live
 *   process holds it, up to `HEAVY_LOCK_TIMEOUT_MS` (default 3 hours); a lock whose holder is gone
 *   (`ESRCH`) is removed. Under a holder (`SHOPFLOOR_HEAVY_LOCK` names its lock, as the gate's
 *   jobs do) it runs at once.
 * - Once it holds the lock (not when inherited): refuses to start below 25 GiB free on the host or
 *   15 GiB in Docker's data root, saying which (exit 2).
 * - Runs the command in its own process group with `SHOPFLOOR_HEAVY_LOCK` set, so its children
 *   inherit the lock; passes SIGINT, SIGTERM and SIGHUP on to that group (a second signal kills
 *   it); releases the lock when the command ends and exits with its code.
 *
 * Usage: node scripts/heavy.ts <command> [arguments…]
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  HeavyLockTimeoutError,
  acquireHeavyLock,
  checkDisks,
  formatGib,
} from '@shopfloor/test-kit/heavy-lock';

const REPO = resolve(import.meta.dirname, '..');
const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  console.error('usage: node scripts/heavy.ts <command> [arguments…]');
  process.exit(2);
}
// What other waiters see: the pnpm script when there is one, and the checkout it runs in.
const script = process.env.npm_lifecycle_event;
const label = `${script ? `pnpm ${script}` : [command, ...args].join(' ')} in ${process.cwd()}`;

const lock = await acquireHeavyLock({ command: label }).catch((error: unknown) => {
  console.error(error instanceof HeavyLockTimeoutError ? `heavy: ${error.message}` : error);
  process.exit(1);
});
process.on('exit', () => {
  lock.release();
});
if (!lock.inherited) {
  const disks = await checkDisks(REPO);
  if (disks.problems.length > 0) {
    for (const problem of disks.problems) console.error(`heavy: refusing to start: ${problem}`);
    process.exit(2);
  }
  console.error(
    `heavy: lock taken for ${label}; free: host ${formatGib(disks.host)}, Docker ${formatGib(disks.docker)}`,
  );
}

const child = spawn(command, args, {
  stdio: 'inherit',
  detached: true,
  env: { ...process.env, ...lock.env },
});
const signals = { received: 0 };
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    signals.received += 1;
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signals.received > 1 ? 'SIGKILL' : signal);
    } catch {
      // the group has ended
    }
  });
}
child.on('error', (error) => {
  console.error(`heavy: could not start ${command}: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  const signalCodes: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  process.exit(code ?? (signal ? (signalCodes[signal] ?? 1) : 1));
});
