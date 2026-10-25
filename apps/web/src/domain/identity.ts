import {
  PASSWORD_LENGTH,
  ROLES,
  USERNAME_PATTERN,
  passwordLength,
  type Permission,
  type Role,
} from '@shopfloor/contracts/identity';
import { PROBLEM_TYPES } from '@shopfloor/contracts/mes-api';
import { ApiError } from '../api/client.ts';
import { writeFailure, type WriteFailure } from './writes.ts';

// Identity on screen (#170): what the login and the user administration tell people.

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  operator: 'Operator',
  maintenance: 'Maintenance',
  quality: 'Quality',
  supervisor: 'Supervisor',
  admin: 'Admin',
};

export const rolesText = (roles: readonly Role[]): string =>
  ROLES.filter((role) => roles.includes(role))
    .map((role) => ROLE_LABELS[role])
    .join(', ');

/** The areas the account page groups permissions by (Y-02), in reading order. */
export const PERMISSION_AREAS = [
  'Plant data',
  'Downtime and scrap',
  'Alarms and shift notes',
  'Operator terminal',
  'Orders',
  'Quality',
  'Administration',
] as const;
export type PermissionArea = (typeof PERMISSION_AREAS)[number];

/**
 * Every permission in words, with its area (Y-02): the account page says what a role may do
 * instead of listing `resource:verb` ids. A `Record` over the contract's permissions, so a new
 * permission does not compile until it has its words here.
 */
export const PERMISSION_LABELS: Readonly<
  Record<Permission, { readonly area: PermissionArea; readonly text: string }>
> = {
  read: { area: 'Plant data', text: 'See every screen of the plant' },
  'downtime:code': { area: 'Downtime and scrap', text: 'Code downtime' },
  'scrap:code': { area: 'Downtime and scrap', text: 'Code scrap' },
  'alarm:ack': { area: 'Alarms and shift notes', text: 'Acknowledge alarms' },
  'alarm:comment': { area: 'Alarms and shift notes', text: 'Comment on alarms' },
  'alarm:shelve': { area: 'Alarms and shift notes', text: 'Shelve alarms' },
  'note:write': { area: 'Alarms and shift notes', text: 'Write shift notes' },
  'terminal:operate': { area: 'Operator terminal', text: 'Work at an operator terminal' },
  'order:release': { area: 'Orders', text: 'Release orders' },
  'order:dispatch': { area: 'Orders', text: 'Dispatch orders' },
  'order:cancel': { area: 'Orders', text: 'Cancel orders' },
  'order:redispatch': { area: 'Orders', text: 'Dispatch orders again' },
  'order:close': { area: 'Orders', text: 'Close orders' },
  'order:abandon': { area: 'Orders', text: 'Abandon orders' },
  'spc:limits': { area: 'Quality', text: 'Set SPC control limits' },
  'spc:ack': { area: 'Quality', text: 'Acknowledge SPC signals' },
  'quality:hold': { area: 'Quality', text: 'Open quality holds and comment on them' },
  'quality:release': { area: 'Quality', text: 'Release or reject quality holds' },
  'user:admin': { area: 'Administration', text: 'Administer users' },
  'sim:control': { area: 'Administration', text: 'Drive the simulation console' },
};

/** A permission in words with its id, for the account page's grouped list. */
export interface PermissionLine {
  readonly id: Permission;
  readonly text: string;
}

/** The held permissions grouped by area, areas and permissions in reading order; empty areas left out. */
export function permissionGroups(
  permissions: readonly Permission[],
): readonly { readonly area: PermissionArea; readonly permissions: readonly PermissionLine[] }[] {
  return PERMISSION_AREAS.map((area) => ({
    area,
    permissions: permissions
      .filter((id) => PERMISSION_LABELS[id].area === area)
      .map((id) => ({ id, text: PERMISSION_LABELS[id].text })),
  })).filter((group) => group.permissions.length > 0);
}

/**
 * A failed login as a message. The MES answers every failure the same (ADR-0026: unknown user,
 * wrong password, disabled, locked or delayed), so this can't say which.
 */
export function loginFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return 'Not logged in: the user name or password is wrong, or the account is locked or disabled. Five failed attempts in a row lock an account for 15 minutes.';
    }
    if (error.status === 429) {
      return `Not logged in: too many logins right now. Try again in ${String(error.retryAfter ?? 1)} s.`;
    }
    if (error.status === 0) return 'Not logged in: the MES cannot be reached.';
  }
  return writeFailure(error, { not: 'Not logged in', conflict: '', what: 'this login' }).text;
}

/** The fields of the password form a problem belongs to. */
export type PasswordField = 'current' | 'next' | 'confirm';

/** A problem of the password form, with the field it is shown under (L-01, WCAG 3.3.1). */
export interface PasswordProblem {
  readonly field: PasswordField;
  readonly text: string;
}

/**
 * What is wrong with a password change before it is sent (the MES checks the same, 422), each
 * problem with its field. `current` undefined: the form does not ask for it (the forced change
 * after a login, which knows it); an empty one is a problem of its own.
 */
export function passwordFormProblems(
  next: string,
  confirm: string,
  current?: string,
): readonly PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  if (current === '') problems.push({ field: 'current', text: 'Enter your current password.' });
  const length = passwordLength(next);
  if (length < PASSWORD_LENGTH.min || length > PASSWORD_LENGTH.max) {
    problems.push({
      field: 'next',
      text: `The new password needs ${String(PASSWORD_LENGTH.min)} to ${String(PASSWORD_LENGTH.max)} characters (it has ${String(length)}).`,
    });
  }
  if (current !== undefined && next === current && next !== '') {
    problems.push({ field: 'next', text: 'The new password must differ from the current one.' });
  }
  if (next !== confirm) problems.push({ field: 'confirm', text: 'The two new passwords differ.' });
  return problems;
}

/** A failed password change as a message (422: rejected, with the MES's reason). */
export function passwordChangeFailure(error: unknown): WriteFailure {
  if (error instanceof ApiError && error.problem?.type === PROBLEM_TYPES.passwordRejected) {
    return {
      kind: 'invalid',
      text: `Not changed: ${error.problem.detail}. A wrong current password counts as a failed login.`,
    };
  }
  return writeFailure(error, {
    not: 'Not changed',
    conflict: 'try again.',
    what: 'this password',
  });
}

/** A failed user administration write as a message (409: the name exists or the last admin). */
export function userWriteFailure(error: unknown): WriteFailure {
  if (error instanceof ApiError && error.problem?.type === PROBLEM_TYPES.userExists) {
    return { kind: 'conflict', text: 'Not saved: a user with that name exists.' };
  }
  const detail = error instanceof ApiError ? (error.problem?.detail ?? error.message) : '';
  return writeFailure(error, {
    not: 'Not saved',
    conflict: `${detail}.`,
    what: 'this change',
  });
}

export const validUsername = (name: string): boolean => USERNAME_PATTERN.test(name);

/** Letters and digits without look-alikes (no 0/O, 1/l/I), for passwords read off a screen. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A random temporary password for a new user or a reset (16 characters, about 92 bits): the user
 * must change it at the first login. `crypto.getRandomValues` with rejection sampling, no bias.
 */
export function temporaryPassword(
  length = 16,
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const byte of random(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += ALPHABET.charAt(byte % ALPHABET.length);
    }
  }
  return out;
}
