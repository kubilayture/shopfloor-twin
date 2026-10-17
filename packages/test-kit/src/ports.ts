import { createServer } from 'node:net';

// Host ports for test processes, chosen at runtime (#212): several suites, worktrees or agents
// run at once on one machine, so no test may assume a fixed port is free.

/**
 * A host port that is free right now: the OS picks one (bind to port 0), we read it back and
 * close. Chosen at runtime, so parallel runs (two worktrees, say) do not clash on a fixed port.
 * The port can still be taken before the caller binds it: callers that spawn a process retry the
 * start with new ports when the process exits early (`startSimulator`).
 */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => {
        if (port > 0) resolvePort(port);
        else reject(new Error('the OS did not report a free port'));
      });
    });
  });
}

/** `count` distinct free ports. */
export async function freePorts(count: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) ports.add(await freePort());
  return [...ports];
}

/** Whether `port` can be listened on, now, on both the IPv6 wildcard and the IPv4 loopback. */
export async function portIsFree(port: number): Promise<boolean> {
  for (const host of ['::', '127.0.0.1']) {
    const outcome = await new Promise<'free' | 'taken' | 'unsupported'>((resolveOutcome) => {
      const server = createServer();
      server.unref();
      server.once('error', (error: NodeJS.ErrnoException) => {
        // A host without IPv6 can't answer for `::`; the IPv4 check still does.
        resolveOutcome(
          error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL' ? 'unsupported' : 'taken',
        );
      });
      server.listen({ port, host }, () => {
        server.close(() => {
          resolveOutcome('free');
        });
      });
    });
    if (outcome === 'taken') return false;
  }
  return true;
}

/**
 * An offset that puts every one of `basePorts` on a free port (`base + offset`), for servers that
 * take a block of ports from a base plus one offset (the simulator's OPC UA machines,
 * `OPCUA_PORT_OFFSET`, at most 9 999). Random, in steps of 10, so two suites picking at the same
 * time rarely meet; every port of the block is checked. The result is below the OS's ephemeral
 * range (49 152+ on macOS, 32 768+ on Linux), where `freePort` and outgoing connections live.
 */
export async function freeOffset(
  basePorts: readonly number[],
  options: { readonly min?: number; readonly max?: number; readonly attempts?: number } = {},
): Promise<number> {
  const { min = 1_000, max = 9_990, attempts = 200 } = options;
  const steps = Math.floor((max - min) / 10) + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const offset = min + 10 * Math.floor(Math.random() * steps);
    let free = true;
    for (const base of basePorts) {
      if (!(await portIsFree(base + offset))) {
        free = false;
        break;
      }
    }
    if (free) return offset;
  }
  throw new Error(`no free port block for ${basePorts.join(', ')} after ${String(attempts)} tries`);
}
