import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { OPCUA_MACHINES } from '@shopfloor/contracts';
import { describe, expect, it } from 'vitest';
import { onFreeOpcuaPorts, onFreePort, temporaryPki, type Startable } from './testing.ts';

function listen(port: number): Promise<Server> {
  return new Promise((resolveServer, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, () => {
      resolveServer(server);
    });
  });
}

function close(server: Server | undefined): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server?.listening) {
      resolveClose();
      return;
    }
    server.close(() => {
      resolveClose();
    });
  });
}

/** A fake server on `ports`: listens on each, and counts its stops. */
class Listeners implements Startable {
  readonly ports: readonly number[];
  readonly servers: Server[] = [];
  stops = 0;

  constructor(ports: readonly number[]) {
    this.ports = ports;
  }

  async start(): Promise<void> {
    for (const port of this.ports) this.servers.push(await listen(port));
  }

  async stop(): Promise<void> {
    this.stops++;
    await Promise.all(this.servers.map(close));
  }
}

describe('runtime ports for the server tests (#216)', () => {
  it('starts again on a new port, stopping the failed attempt, when the picked one was taken meanwhile', async () => {
    const attempts: Listeners[] = [];
    let thief: Server | undefined;
    try {
      const second = await onFreePort((port) => {
        const attempt = new Listeners([port]);
        attempts.push(attempt);
        return {
          start: async () => {
            // Another process binds the first picked port between the check and our start.
            if (attempts.length === 1) thief = await listen(port);
            await attempt.start();
          },
          stop: () => attempt.stop(),
        };
      });
      try {
        expect(attempts).toHaveLength(2);
        expect(attempts[0]?.stops).toBe(1);
        expect(attempts[1]?.stops).toBe(0);
        expect(attempts[1]?.ports).toEqual([second.port]);
        expect(second.port).not.toBe(attempts[0]?.ports[0]);
        expect(attempts[1]?.servers[0]?.address()).toMatchObject({ port: second.port });
      } finally {
        await second.value.stop();
      }
    } finally {
      await close(thief);
    }
  });

  it('puts every OPC UA machine on a free port of one block, again on a new block when one was taken', async () => {
    const bases = OPCUA_MACHINES.map((machine) => machine.port);
    const attempts: Listeners[] = [];
    let thief: Server | undefined;
    try {
      const { portOffset, value } = await onFreeOpcuaPorts((offset) => {
        const attempt = new Listeners(bases.map((base) => base + offset));
        attempts.push(attempt);
        return {
          start: async () => {
            // Another process binds the first block's last port between the check and our start.
            if (attempts.length === 1) thief = await listen(attempt.ports.at(-1) ?? 0);
            await attempt.start();
          },
          stop: () => attempt.stop(),
        };
      });
      try {
        expect(attempts).toHaveLength(2);
        expect(attempts[0]?.stops).toBe(1);
        expect(attempts[1]?.stops).toBe(0);
        expect(portOffset % 10).toBe(0);
        expect(attempts[1]?.ports).toEqual(bases.map((base) => base + portOffset));
        // The failed attempt released the ports it had bound before the clash.
        expect(attempts[0]?.servers.every((server) => !server.listening)).toBe(true);
        expect(attempts[1]?.servers.map((server) => server.address())).toEqual(
          bases.map((base) => expect.objectContaining({ port: base + portOffset }) as unknown),
        );
      } finally {
        await value.stop();
      }
    } finally {
      await close(thief);
    }
  });

  it('throws a failure that is not a port clash at once, after stopping the attempt', async () => {
    let starts = 0;
    let stops = 0;
    await expect(
      onFreePort(() => ({
        start: () => {
          starts++;
          return Promise.reject(new Error('broken'));
        },
        stop: () => {
          stops++;
          return Promise.resolve();
        },
      })),
    ).rejects.toThrow('broken');
    expect({ starts, stops }).toEqual({ starts: 1, stops: 1 });
  });

  it('gives up after a bounded number of clashes, reporting the start error over a failing stop', async () => {
    let starts = 0;
    await expect(
      onFreePort(() => ({
        start: () => {
          starts++;
          return Promise.reject(Object.assign(new Error('taken'), { code: 'EADDRINUSE' }));
        },
        stop: () => Promise.reject(new Error('stop failed')),
      })),
    ).rejects.toThrow('taken');
    expect(starts).toBe(5);
  });

  it('makes a new certificate folder per call and removes it', async () => {
    const first = await temporaryPki('kit');
    const second = await temporaryPki('kit');
    expect(first.folder).not.toBe(second.folder);
    expect(existsSync(first.folder)).toBe(true);
    await first.remove();
    await second.remove();
    expect(existsSync(first.folder)).toBe(false);
    expect(existsSync(second.folder)).toBe(false);
  });
});
