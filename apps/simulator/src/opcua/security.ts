import { X509Certificate, createHash, timingSafeEqual } from 'node:crypto';
import { OPCUA_USERS } from '@shopfloor/pki';
import {
  MessageSecurityMode,
  OPCUACertificateManager,
  PermissionType,
  SecurityPolicy,
  StatusCodes,
  UserTokenType,
  WellKnownRoles,
  makeRoles,
  type OPCUAServer,
  type NodeId,
  type StatusCode,
  type StatusCodeCallback,
  type RolePermissionTypeOptions,
} from 'node-opcua';

/**
 * A machine server's security (ADR-0038). `sign-and-encrypt`: only a SignAndEncrypt endpoint
 * (`Basic256Sha256`, `Aes128_Sha256_RsaOaep`), the certificate the `pki` step made, client
 * certificates trusted only when pinned, no anonymous session, users `opcua-gateway` and
 * `opcua-reader`, and `LoadOrder` and `LoadProgram` callable by `opcua-gateway` only (address space
 * 1.3). `none`: for tests that don't test security, an anonymous None endpoint with no method
 * restriction (address space 1.2's behaviour).
 */
export type ServerSecurity =
  | { readonly mode: 'none' }
  | {
      readonly mode: 'sign-and-encrypt';
      readonly passwords: { readonly gateway: string; readonly reader: string };
    };

export const SECURE_POLICIES = [
  SecurityPolicy.Basic256Sha256,
  SecurityPolicy.Aes128_Sha256_RsaOaep,
];

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** Constant-time comparison of two secrets (digests first, so lengths don't leak). */
export function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * A refused user name and password answers only after this wait (#239 review): a small brake on
 * guessing, which a timer gives without blocking the event loop. Per-account and per-address
 * throttling is P9-15's (checklist S5).
 */
export const FAILED_LOGIN_DELAY_MS = 250;

/** node-opcua's user manager, as `userManager` makes it (assignable to `UserManagerOptions`). */
export interface ServerUsers {
  isValidUserAsync(
    username: string,
    password: string,
    callback: (error: Error | null, valid?: boolean) => void,
  ): void;
  getUserRoles(username: string): NodeId[];
}

/** The server's two users and their roles: the gateway operates, the reader observes. */
export function userManager(
  passwords: { readonly gateway: string; readonly reader: string },
  failedLoginDelayMs = FAILED_LOGIN_DELAY_MS,
): ServerUsers {
  const roles = new Map<string, NodeId[]>([
    [OPCUA_USERS.gateway, makeRoles('Operator')],
    [OPCUA_USERS.reader, makeRoles('Observer')],
  ]);
  const passwordOf = new Map<string, string>([
    [OPCUA_USERS.gateway, passwords.gateway],
    [OPCUA_USERS.reader, passwords.reader],
  ]);
  return {
    isValidUserAsync: (username, password, callback) => {
      const expected = passwordOf.get(username);
      // An unknown user is compared too, so its answer takes as long as a wrong password's.
      const same = sameSecret(password, expected ?? '');
      if (expected !== undefined && same) {
        callback(null, true);
        return;
      }
      setTimeout(() => {
        callback(null, false);
      }, failedLoginDelayMs);
    },
    getUserRoles: (username) => roles.get(username) ?? [],
  };
}

/**
 * The servers' store of trusted client certificates (#239 review): node-opcua checks a client
 * certificate's trust, validity and key usage but not its extended key usage, so a pinned
 * certificate made for a server (`serverAuth` only) could open a client session. This store also
 * refuses a chain whose leaf lacks `clientAuth` (`BadCertificateUseNotAllowed`).
 */
export class ClientCertificateManager extends OPCUACertificateManager {
  override checkCertificate(chain: Certificate | Certificate[]): Promise<StatusCode>;
  override checkCertificate(chain: Certificate | Certificate[], callback: StatusCodeCallback): void;
  override checkCertificate(
    chain: Certificate | Certificate[],
    callback?: StatusCodeCallback,
  ): Promise<StatusCode> | undefined {
    const result = super
      .checkCertificate(chain)
      .then((status) =>
        status.isGood() && !hasClientAuth(chain) ? StatusCodes.BadCertificateUseNotAllowed : status,
      );
    if (!callback) return result;
    result.then(
      (status) => {
        callback(null, status);
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)));
      },
    );
    return undefined;
  }
}

/** A DER certificate or chain, as node-opcua passes it. */
type Certificate = Buffer;

const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';

/** Whether the chain's first (leaf) certificate lists `clientAuth` in its extended key usage. */
export function hasClientAuth(chain: Certificate | Certificate[]): boolean {
  const first = Array.isArray(chain) ? chain[0] : chain;
  if (!first || first.length < 2) return false;
  // A chain is the certificates' DER one after the other: the leaf is the first SEQUENCE.
  const lengthByte = first[1] ?? 0;
  const lengthBytes = lengthByte & 0x80 ? lengthByte & 0x7f : 0;
  let length = lengthBytes === 0 ? lengthByte : 0;
  for (let i = 0; i < lengthBytes; i++) length = length * 256 + (first[2 + i] ?? 0);
  try {
    const leaf = new X509Certificate(first.subarray(0, 2 + lengthBytes + length));
    return leaf.keyUsage.includes(CLIENT_AUTH);
  } catch {
    return false;
  }
}

const READ: PermissionType =
  PermissionType.Browse | PermissionType.Read | PermissionType.ReadRolePermissions;
const OPERATE: PermissionType = READ | PermissionType.Call;

/**
 * `LoadOrder` and `LoadProgram` (address space 1.3): `Call` for the Operator role
 * (`opcua-gateway`) only; every other role may browse and read the method. node-opcua answers a
 * call without `Call` with `BadUserAccessDenied` and reports `UserExecutable` false to the caller.
 */
export const COMMAND_METHOD_PERMISSIONS: RolePermissionTypeOptions[] = [
  { roleId: WellKnownRoles.Operator, permissions: OPERATE },
  { roleId: WellKnownRoles.Observer, permissions: READ },
  { roleId: WellKnownRoles.AuthenticatedUser, permissions: READ },
  { roleId: WellKnownRoles.Anonymous, permissions: READ },
];

export const SECURE_MODES = [MessageSecurityMode.SignAndEncrypt];

/**
 * Leaves user-name tokens as the only identity tokens a secure server offers. node-opcua offers
 * X.509 user tokens beside them and has no option to leave them out (`userTokenTypes` is not
 * passed on to the endpoints in 2.187), so the policies are taken off the endpoint descriptions
 * after `initialize()`: the server then also refuses such a token (no matching policy).
 */
export function onlyUserNameTokens(server: OPCUAServer): void {
  for (const endpoint of server.endpoints) {
    for (const description of endpoint.endpointDescriptions()) {
      description.userIdentityTokens = (description.userIdentityTokens ?? []).filter(
        (policy) => policy.tokenType === UserTokenType.UserName,
      );
    }
  }
}
