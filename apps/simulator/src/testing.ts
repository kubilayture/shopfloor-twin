import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPCUA_MACHINES } from '@shopfloor/contracts';
import { ensureOpcuaPki } from '@shopfloor/pki';
import { freeOffset, freePort } from '@shopfloor/test-kit/ports';
import type { ServerSecurity } from './opcua/security.ts';

// Ports and certificate folders for the simulator's server tests (#216, after #212): several
// suites, worktrees or agents run at once on one machine, so no test binds a fixed port or shares
// a fixed PKI folder.

/** How many times a start is tried on new ports when another process took the chosen one. */
const ATTEMPTS = 5;

function addressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
}

/** A server the helpers start on picked ports: `PlantServers`, `WasherModbusServer`. */
export interface Startable {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Creates a server on a port picked at runtime and starts it. A picked port is free when checked
 * but can be taken before the server binds it, so a start that fails with `EADDRINUSE` is stopped
 * (whatever it did bind is released) and retried with a server created on a newly picked port; any
 * other failure, or the last attempt's, is thrown after the stop.
 */
async function onPicked<T extends Startable>(
  pick: () => Promise<number>,
  create: (port: number) => T,
): Promise<{ readonly port: number; readonly value: T }> {
  for (let attempt = 1; ; attempt++) {
    const port = await pick();
    const value = create(port);
    try {
      await value.start();
      return { port, value };
    } catch (error) {
      // The start's own error is the one to report; a failing stop must not hide it.
      await value.stop().catch(() => undefined);
      if (!addressInUse(error) || attempt >= ATTEMPTS) throw error;
    }
  }
}

/**
 * Creates and starts the OPC UA machine servers on a free block: `create` gets an
 * `OPCUA_PORT_OFFSET` that puts every machine of `OPCUA_MACHINES` (4841–4845) on a port free right
 * now, and is called again for a new block when one of them was taken meanwhile.
 */
export async function onFreeOpcuaPorts<T extends Startable>(
  create: (portOffset: number) => T,
): Promise<{ readonly portOffset: number; readonly value: T }> {
  const { port: portOffset, value } = await onPicked(
    () => freeOffset(OPCUA_MACHINES.map((machine) => machine.port)),
    create,
  );
  return { portOffset, value };
}

/** Creates and starts a single-port server (the Modbus washer) on an OS-assigned free port. */
export async function onFreePort<T extends Startable>(
  create: (port: number) => T,
): Promise<{ readonly port: number; readonly value: T }> {
  return onPicked(freePort, create);
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

/** A secure PKI for one suite (#239): the `pki` step's own code, run into a temporary folder. */
export interface SecurePki {
  /** The simulator's PKI root: `PlantServers`' `pkiFolder`. */
  readonly folder: string;
  /** The gateway's and the tools client's PKI folders. */
  readonly gateway: string;
  readonly tools: string;
  /** The two users' passwords, random per suite. */
  readonly passwords: { readonly gateway: string; readonly reader: string };
  /** `PlantServers`' `security`. */
  readonly security: ServerSecurity;
  readonly remove: () => Promise<void>;
}

/**
 * The exchange step for tests outside Compose (ADR-0038): `ensureOpcuaPki`, the code of the `pki`
 * service, makes and pins every certificate before the servers and clients start.
 */
export async function securePki(name: string): Promise<SecurePki> {
  const root = await mkdtemp(join(tmpdir(), `shopfloor-twin-${name}-secure-pki-`));
  const folder = join(root, 'simulator');
  const gateway = join(root, 'gateway');
  const tools = join(root, 'tools');
  await ensureOpcuaPki({ simulator: folder, gateway, tools });
  const passwords = {
    gateway: randomBytes(16).toString('hex'),
    reader: randomBytes(16).toString('hex'),
  };
  return {
    folder,
    gateway,
    tools,
    passwords,
    security: { mode: 'sign-and-encrypt', passwords },
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
