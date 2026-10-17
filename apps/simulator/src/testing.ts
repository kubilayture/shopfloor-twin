import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPCUA_MACHINES } from '@shopfloor/contracts';
import { freeOffset, freePort } from '@shopfloor/test-kit/ports';

// Ports and certificate folders for the simulator's server tests (#216, after #212): several
// suites, worktrees or agents run at once on one machine, so no test binds a fixed port or shares
// a fixed PKI folder.

/** How many times a start is tried on new ports when another process took the chosen one. */
const ATTEMPTS = 5;

function addressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
}

/**
 * Runs `start` on a port picked at runtime. A picked port is free when checked but can be taken
 * before `start` binds it, so a start that fails with `EADDRINUSE` is retried on a newly picked
 * port; any other failure, or the last attempt's, is thrown. `start` must leave nothing bound when
 * it throws (`PlantServers.start` stops the servers it started).
 */
async function onPicked<T>(
  pick: () => Promise<number>,
  start: (port: number) => Promise<T>,
): Promise<{ readonly port: number; readonly value: T }> {
  for (let attempt = 1; ; attempt++) {
    const port = await pick();
    try {
      return { port, value: await start(port) };
    } catch (error) {
      if (!addressInUse(error) || attempt >= ATTEMPTS) throw error;
    }
  }
}

/**
 * Starts the OPC UA machine servers on a free block: `start` gets an `OPCUA_PORT_OFFSET` that puts
 * every machine of `OPCUA_MACHINES` (4841–4845) on a port free right now, and is tried again on a
 * new block when one of them was taken meanwhile.
 */
export async function onFreeOpcuaPorts<T>(
  start: (portOffset: number) => Promise<T>,
): Promise<{ readonly portOffset: number; readonly value: T }> {
  const { port: portOffset, value } = await onPicked(
    () => freeOffset(OPCUA_MACHINES.map((machine) => machine.port)),
    start,
  );
  return { portOffset, value };
}

/** Starts a single-port server (the Modbus washer) on an OS-assigned free port. */
export async function onFreePort<T>(
  start: (port: number) => Promise<T>,
): Promise<{ readonly port: number; readonly value: T }> {
  return onPicked(freePort, start);
}

/**
 * A new, empty certificate folder for one suite's OPC UA servers, so that two runs never share
 * (and race on) the PKI that node-opcua writes on start. `remove` deletes it.
 */
export async function temporaryPki(
  name: string,
): Promise<{ readonly folder: string; readonly remove: () => Promise<void> }> {
  const folder = await mkdtemp(join(tmpdir(), `shopfloor-twin-${name}-pki-`));
  return {
    folder,
    remove: () => rm(folder, { recursive: true, force: true }),
  };
}
