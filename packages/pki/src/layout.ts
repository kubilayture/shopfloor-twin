import { join } from 'node:path';
import { OPCUA_MACHINES, SHOPFLOOR_NAMESPACE_URI } from '@shopfloor/contracts';

/**
 * OPC UA security (ADR-0038): `sign-and-encrypt` (Compose and every test of security) or `none`
 * (unit tests that don't test security; anonymous, no certificate check, methods unrestricted).
 */
export const OPCUA_SECURITY_MODES = ['sign-and-encrypt', 'none'] as const;
export type OpcuaSecurityMode = (typeof OPCUA_SECURITY_MODES)[number];

/** The two OPC UA user names (ADR-0038): the gateway, and a read-only user for tools and tests. */
export const OPCUA_USERS = { gateway: 'opcua-gateway', reader: 'opcua-reader' } as const;

/** A machine server's `applicationUri`, the URI in its certificate's SAN. */
export const machineApplicationUri = (machineId: string): string =>
  `${SHOPFLOOR_NAMESPACE_URI}:${machineId}`;

/** The edge gateway's `applicationUri` (set explicitly in its OPC UA clients). */
export const GATEWAY_APPLICATION_URI = `${SHOPFLOOR_NAMESPACE_URI}:edge-gateway`;

/** The tools client's `applicationUri` (development tools, the smoke and the `opcua-reader` tests). */
export const TOOLS_APPLICATION_URI = `${SHOPFLOOR_NAMESPACE_URI}:tools`;

/**
 * DNS names in every machine server's SAN: the gateway reaches the servers as `simulator` in
 * Compose, host tools and tests as `localhost`.
 */
export const SERVER_DNS_NAMES = ['simulator', 'localhost'] as const;

/** Where one component's material lies inside its PKI folder (node-opcua's own layout). */
export interface PkiFiles {
  readonly root: string;
  /** `own/certs/certificate.pem`: node-opcua's default for a server, passed explicitly everywhere. */
  readonly certificateFile: string;
  /** `own/private/private_key.pem`: node-opcua's default private key. */
  readonly privateKeyFile: string;
  /** The pinned peer certificates. */
  readonly trustedCerts: string;
}

export function pkiFiles(root: string): PkiFiles {
  return {
    root,
    certificateFile: join(root, 'own', 'certs', 'certificate.pem'),
    privateKeyFile: join(root, 'own', 'private', 'private_key.pem'),
    trustedCerts: join(root, 'trusted', 'certs'),
  };
}

/** The folders node-opcua's certificate manager expects under a PKI root. */
export const PKI_SUBFOLDERS = [
  'own/certs',
  'own/private',
  'trusted/certs',
  'trusted/crl',
  'issuers/certs',
  'issuers/crl',
  'rejected',
] as const;

export type IdentityRole = 'server' | 'client';

/** One OPC UA application with its own key and certificate. */
export interface OpcuaIdentity {
  /** A short name: the machine id, `edge-gateway` or `tools`. */
  readonly name: string;
  readonly role: IdentityRole;
  readonly applicationUri: string;
  readonly dnsNames: readonly string[];
  readonly folder: string;
  /** The names of the identities whose certificates this one pins. */
  readonly pins: readonly string[];
}

/** Where the three PKI volumes are mounted (each component mounts only its own). */
export interface PkiRoots {
  /** The simulator's volume: one folder per machine server, `<simulator>/<machineId>`. */
  readonly simulator: string;
  readonly gateway: string;
  readonly tools: string;
}

/**
 * Every OPC UA identity of the plant and whom it pins (ADR-0038): each machine server pins the
 * gateway and the tools client; the gateway and the tools client pin every machine server. No CA.
 */
export function opcuaIdentities(roots: PkiRoots): OpcuaIdentity[] {
  const servers = OPCUA_MACHINES.map((machine) => machine.id);
  return [
    ...servers.map((id): OpcuaIdentity => ({
      name: id,
      role: 'server',
      applicationUri: machineApplicationUri(id),
      dnsNames: SERVER_DNS_NAMES,
      folder: join(roots.simulator, id),
      pins: ['edge-gateway', 'tools'],
    })),
    {
      name: 'edge-gateway',
      role: 'client',
      applicationUri: GATEWAY_APPLICATION_URI,
      dnsNames: ['gateway'],
      folder: roots.gateway,
      pins: servers,
    },
    {
      name: 'tools',
      role: 'client',
      applicationUri: TOOLS_APPLICATION_URI,
      dnsNames: ['localhost'],
      folder: roots.tools,
      pins: servers,
    },
  ];
}
