import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPCUA_USERS, ensureOpcuaPki, pkiFiles } from '@shopfloor/pki';

// The exchange step for test processes outside Compose (#239, ADR-0038): the `pki` service's own
// code (`ensureOpcuaPki`) makes every OPC UA key and certificate once per test process and pins the
// peers; each simulator or gateway then gets a copy of its own folder, so a killed process can't
// leave a shared store locked, and a restart keeps the same certificates.

export interface TestOpcuaPki {
  /** The simulator's PKI root (one folder per machine server). */
  readonly simulator: string;
  readonly gateway: string;
  /** The tools client's folder: pinned on every server, user `opcua-reader`. */
  readonly tools: string;
  /** The users' passwords, random per test process. */
  readonly passwords: { readonly gateway: string; readonly reader: string };
}

let made: Promise<TestOpcuaPki> | undefined;

/** This process's PKI, made on first use and removed when the process exits. */
export function testOpcuaPki(): Promise<TestOpcuaPki> {
  made ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), 'shopfloor-twin-test-pki-'));
    process.once('exit', () => {
      rmSync(root, { recursive: true, force: true });
    });
    const pki = {
      simulator: join(root, 'simulator'),
      gateway: join(root, 'gateway'),
      tools: join(root, 'tools'),
    };
    await ensureOpcuaPki(pki);
    return {
      ...pki,
      passwords: {
        gateway: randomBytes(16).toString('hex'),
        reader: randomBytes(16).toString('hex'),
      },
    };
  })();
  return made;
}

/** The simulator's environment for SignAndEncrypt, its PKI copied into `pkiDir`. */
export async function secureSimulatorEnv(pkiDir: string): Promise<Record<string, string>> {
  const pki = await testOpcuaPki();
  cpSync(pki.simulator, pkiDir, { recursive: true });
  return {
    OPCUA_SECURITY: 'sign-and-encrypt',
    OPCUA_PKI_DIR: pkiDir,
    OPCUA_GATEWAY_PASSWORD: pki.passwords.gateway,
    OPCUA_READER_PASSWORD: pki.passwords.reader,
  };
}

/** What an in-process `OpcuaCollector` needs to connect as the gateway. */
export interface GatewayClientSecurity {
  readonly mode: 'sign-and-encrypt';
  readonly certificateFile: string;
  readonly privateKeyFile: string;
  readonly userName: string;
  readonly password: string;
}

/**
 * Installs the gateway's certificate, key and pins into `pkiDir` (the gateway's `OPCUA_PKI_DIR`, or
 * an in-process collector's certificate store) and says how to connect as `opcua-gateway`.
 */
export async function installGatewayPki(pkiDir: string): Promise<GatewayClientSecurity> {
  const pki = await testOpcuaPki();
  cpSync(pki.gateway, pkiDir, { recursive: true });
  const files = pkiFiles(pkiDir);
  return {
    mode: 'sign-and-encrypt',
    certificateFile: files.certificateFile,
    privateKeyFile: files.privateKeyFile,
    userName: OPCUA_USERS.gateway,
    password: pki.passwords.gateway,
  };
}
