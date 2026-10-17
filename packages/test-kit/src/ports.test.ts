import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { freeOffset, freePort, freePorts, portIsFree } from './ports.ts';
import { timed } from './timing.ts';

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((r) => {
      server.close(() => {
        r();
      });
    });
  }
});

const listen = (port: number, host?: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    servers.push(server);
    server.once('error', reject);
    server.listen({ port, ...(host ? { host } : {}) }, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

describe('ports chosen at runtime (#212)', () => {
  it('sees a port as taken on the IPv4 loopback and on the wildcard', async () => {
    const loopback = await listen(0, '127.0.0.1');
    expect(await portIsFree(loopback)).toBe(false);
    const wildcard = await listen(0);
    expect(await portIsFree(wildcard)).toBe(false);
    const free = await freePort();
    expect(await portIsFree(free)).toBe(true);
  });

  it('hands out distinct free ports', async () => {
    const ports = await freePorts(5);
    expect(new Set(ports).size).toBe(5);
  });

  it('finds an offset that puts a whole block on free ports, skipping a taken one', async () => {
    const base = [4841, 4842, 4843, 4844, 4845];
    const range = { min: 1_000, max: 1_090 };
    const offset = await freeOffset(base, range);
    expect(offset % 10).toBe(0);
    expect(offset).toBeGreaterThanOrEqual(range.min);
    expect(offset).toBeLessThanOrEqual(range.max);
    for (const port of base) expect(await portIsFree(port + offset)).toBe(true);
    // Take the middle port of that block: it is never handed out again.
    await listen(4843 + offset, '127.0.0.1');
    for (let i = 0; i < 10; i++) expect(await freeOffset(base, range)).not.toBe(offset);
    await expect(freeOffset(base, { min: offset, max: offset, attempts: 3 })).rejects.toThrow(
      /no free port block/,
    );
  });
});

describe('timed (#212)', () => {
  it('measures the scheduler lag of a blocked event loop', async () => {
    const { elapsedMs, maxLagMs } = await timed(async () => {
      await new Promise((r) => setTimeout(r, 30));
      const until = performance.now() + 150;
      while (performance.now() < until); // blocks the loop: timers fire late
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(elapsedMs).toBeGreaterThanOrEqual(200);
    expect(maxLagMs).toBeGreaterThanOrEqual(100);
  });
});
