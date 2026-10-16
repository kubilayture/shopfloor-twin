import {
  PASSWORD_LENGTH,
  ROLES,
  USERNAME_PATTERN,
  passwordLength,
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

/** What is wrong with a new password before it is sent (the MES checks the same, 422). */
export function newPasswordProblems(
  next: string,
  confirm: string,
  current?: string,
): readonly string[] {
  const problems: string[] = [];
  const length = passwordLength(next);
  if (length < PASSWORD_LENGTH.min || length > PASSWORD_LENGTH.max) {
    problems.push(
      `The new password needs ${String(PASSWORD_LENGTH.min)} to ${String(PASSWORD_LENGTH.max)} characters (it has ${String(length)}).`,
    );
  }
  if (current !== undefined && next === current && next !== '') {
    problems.push('The new password must differ from the current one.');
  }
  if (next !== confirm) problems.push('The two new passwords differ.');
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
