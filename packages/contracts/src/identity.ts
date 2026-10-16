// Identity (#168, ADR-0026): the roles, the permissions and which role holds which, defined once
// so the MES enforces and the web hides with the same table.

/** The five roles of master plan section 7. A user has one or more. */
export const ROLES = ['operator', 'maintenance', 'quality', 'supervisor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Every permission the MES checks. `read` covers every GET under `/api/v1` and the WebSocket; the
 * others name one kind of write (Phase 7 plan, "Identity").
 */
export const PERMISSIONS = [
  'read',
  'downtime:code',
  'alarm:ack',
  'alarm:comment',
  'alarm:shelve',
  'note:write',
  'terminal:operate',
  'scrap:code',
  'order:release',
  'order:dispatch',
  'order:cancel',
  'order:redispatch',
  'order:close',
  'user:admin',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * The permission matrix. `admin` administers users and nothing else (separation of duties); a
 * person who needs both gets both roles.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  operator: [
    'read',
    'downtime:code',
    'alarm:ack',
    'alarm:comment',
    'note:write',
    'terminal:operate',
    'scrap:code',
  ],
  maintenance: [
    'read',
    'downtime:code',
    'alarm:ack',
    'alarm:comment',
    'alarm:shelve',
    'note:write',
  ],
  quality: ['read', 'alarm:ack', 'alarm:comment', 'note:write', 'scrap:code'],
  supervisor: [
    'read',
    'downtime:code',
    'alarm:ack',
    'alarm:comment',
    'alarm:shelve',
    'note:write',
    'terminal:operate',
    'scrap:code',
    'order:release',
    'order:dispatch',
    'order:cancel',
    'order:redispatch',
    'order:close',
  ],
  admin: ['read', 'user:admin'],
};

/** Every permission any of the roles holds, in `PERMISSIONS` order. */
export function permissionsOf(roles: readonly Role[]): Permission[] {
  const held = new Set(roles.flatMap((role) => ROLE_PERMISSIONS[role]));
  return PERMISSIONS.filter((permission) => held.has(permission));
}

/** Whether any of the roles holds the permission. */
export function can(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}

/** A user name: lower case, 2–64 characters, letters, digits, `.`, `_`, `-`. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** Password length (NIST SP 800-63B: a length rule, no composition rules). */
export const PASSWORD_LENGTH = { min: 12, max: 128 } as const;

/** A password's length in characters (Unicode code points, as NIST counts them). */
export function passwordLength(password: string): number {
  return Array.from(password).length;
}

/** Session kinds: a desk (browser) or a shared terminal, each with its own idle timeout. */
export const SESSION_KINDS = ['desk', 'terminal'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/** The session cookie on plain HTTP; with `MES_COOKIE_SECURE=on` it is `__Host-sft_session`. */
export const SESSION_COOKIE = 'sft_session';
export const SECURE_SESSION_COOKIE = '__Host-sft_session';

/** The WebSocket close code of a missing or ended session; the web goes to `/login`. */
export const WS_CLOSE_UNAUTHENTICATED = 4401;
