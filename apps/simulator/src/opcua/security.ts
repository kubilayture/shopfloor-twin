import { createHash, timingSafeEqual } from 'node:crypto';
import { OPCUA_USERS } from '@shopfloor/pki';
import {
  MessageSecurityMode,
  PermissionType,
  SecurityPolicy,
  UserTokenType,
  WellKnownRoles,
  makeRoles,
  type OPCUAServer,
  type NodeId,
  type RolePermissionTypeOptions,
  type UserManagerOptions,
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

/** The server's two users and their roles: the gateway operates, the reader observes. */
export function userManager(passwords: {
  readonly gateway: string;
  readonly reader: string;
}): UserManagerOptions {
  const roles = new Map<string, NodeId[]>([
    [OPCUA_USERS.gateway, makeRoles('Operator')],
    [OPCUA_USERS.reader, makeRoles('Observer')],
  ]);
  const passwordOf = new Map<string, string>([
    [OPCUA_USERS.gateway, passwords.gateway],
    [OPCUA_USERS.reader, passwords.reader],
  ]);
  return {
    isValidUser: (username: string, password: string): boolean => {
      const expected = passwordOf.get(username);
      // An unknown user is compared too, so its answer takes as long as a wrong password's.
      const same = sameSecret(password, expected ?? '');
      return expected !== undefined && same;
    },
    getUserRoles: (username: string): NodeId[] => roles.get(username) ?? [],
  };
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
