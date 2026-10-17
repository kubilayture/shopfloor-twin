import { createServer, type Server } from 'node:net';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { onFreePort, temporaryPki } from './testing.ts';

function listen(port: number): Promise<Server> {
  return new Promise((resolveServer, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolveServer(server);
    });
  });
}

describe('runtime ports for the server tests (#216)', () => {
  it('starts again on a new port when the picked one was taken meanwhile', async () => {
    const tried: number[] = [];
    let thief: Server | undefined;
    const { port, value } = await onFreePort(async (port) => {
      tried.push(port);
      // Another process binds the first picked port between the check and our start.
      if (tried.length === 1) thief = await listen(port);
      return listen(port);
    });
    try {
      expect(tried).toHaveLength(2);
      expect(port).toBe(tried[1]);
      expect(port).not.toBe(tried[0]);
      expect(value.address()).toMatchObject({ port });
    } finally {
      value.close();
      thief?.close();
    }
  });

  it('throws a failure that is not a port clash at once', async () => {
    let attempts = 0;
    await expect(
      onFreePort(() => {
        attempts++;
        return Promise.reject(new Error('broken'));
      }),
    ).rejects.toThrow('broken');
    expect(attempts).toBe(1);
  });

  it('gives up after a bounded number of clashes', async () => {
    let attempts = 0;
    await expect(
      onFreePort(() => {
        attempts++;
        return Promise.reject(Object.assign(new Error('taken'), { code: 'EADDRINUSE' }));
      }),
    ).rejects.toThrow('taken');
    expect(attempts).toBe(5);
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
