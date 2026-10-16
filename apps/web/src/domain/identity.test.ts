import { PROBLEM_TYPES } from '@shopfloor/contracts/mes-api';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import { countdownText, idleDeadline } from '../auth/idle.ts';
import { safeRedirect } from '../auth/redirect.ts';
import { sessionOf } from '../test/fixtures.ts';
import {
  loginFailure,
  newPasswordProblems,
  passwordChangeFailure,
  rolesText,
  temporaryPassword,
  userWriteFailure,
} from './identity.ts';

describe('identity on screen (#170)', () => {
  it('goes back only to a path of this app after the login', () => {
    expect(safeRedirect('/alarms?view=history#x')).toBe('/alarms?view=history#x');
    expect(safeRedirect('/equipment/cnc-01?range=1h')).toBe('/equipment/cnc-01?range=1h');
    for (const bad of [
      'https://evil.test/',
      '//evil.test/x',
      '/\\evil.test',
      'javascript:alert(1)',
      'alarms',
      '/login?redirect=/x',
      '/a\nb',
      '',
      42,
      undefined,
    ]) {
      expect(safeRedirect(bad), String(bad)).toBeUndefined();
    }
  });

  it('ends a desk session 60 min after the last input, or at its absolute expiry', () => {
    const now = Date.parse('2026-10-15T08:00:00.000Z');
    const session = {
      ...sessionOf(['operator']),
      expiresAt: '2026-10-15T18:00:00.000Z',
    };
    expect(idleDeadline(session, now)).toEqual({ at: now + 3_600_000, absolute: false });
    expect(idleDeadline({ ...session, kind: 'terminal' }, now)).toEqual({
      at: now + 900_000,
      absolute: false,
    });
    expect(idleDeadline(session, Date.parse('2026-10-15T17:30:00.000Z'))).toEqual({
      at: Date.parse('2026-10-15T18:00:00.000Z'),
      absolute: true,
    });
    expect(countdownText(119_001)).toBe('2:00');
    expect(countdownText(61_000)).toBe('1:01');
    expect(countdownText(-5)).toBe('0:00');
  });

  it('checks a new password as the MES does: 12–128 characters, not the current one, confirmed', () => {
    expect(newPasswordProblems('long enough pw', 'long enough pw', 'old one here')).toEqual([]);
    expect(newPasswordProblems('short', 'short')).toEqual([
      'The new password needs 12 to 128 characters (it has 5).',
    ]);
    expect(newPasswordProblems('same password', 'same password', 'same password')).toEqual([
      'The new password must differ from the current one.',
    ]);
    expect(newPasswordProblems('long enough pw', 'long enough px')).toEqual([
      'The two new passwords differ.',
    ]);
    // Characters, not UTF-16 units.
    expect(newPasswordProblems('🔒'.repeat(12), '🔒'.repeat(12))).toEqual([]);
  });

  it('makes temporary passwords of 16 unambiguous characters without bias', () => {
    const password = temporaryPassword();
    expect(password).toMatch(/^[a-km-np-zA-HJ-NP-Z2-9]{16}$/);
    expect(temporaryPassword()).not.toBe(password);
    // Bytes at or above the largest multiple of the alphabet are skipped.
    let call = 0;
    const fixed = temporaryPassword(4, (bytes) => {
      call += 1;
      bytes.fill(call === 1 ? 255 : 0);
      return bytes;
    });
    expect(fixed).toBe('aaaa');
  });

  it('tells login and administration failures apart without revealing which login failed', () => {
    const problem = (status: number, type: string, detail = 'x') =>
      new ApiError('x', status, { type, title: 't', status, detail, instance: '/' });
    expect(loginFailure(problem(401, PROBLEM_TYPES.unauthenticated))).toMatch(
      /user name or password is wrong, or the account is locked/,
    );
    expect(loginFailure(new ApiError('x', 429, undefined, 3))).toMatch(/Try again in 3 s/);
    expect(loginFailure(new ApiError('x', 0))).toMatch(/cannot be reached/);
    expect(
      passwordChangeFailure(problem(422, PROBLEM_TYPES.passwordRejected, 'wrong current password'))
        .text,
    ).toMatch(/^Not changed: wrong current password/);
    expect(userWriteFailure(problem(409, PROBLEM_TYPES.userExists)).text).toBe(
      'Not saved: a user with that name exists.',
    );
    expect(
      userWriteFailure(problem(403, PROBLEM_TYPES.forbidden, 'permission user:admin needed')),
    ).toMatchObject({ kind: 'refused' });
    expect(rolesText(['supervisor', 'operator'])).toBe('Operator, Supervisor');
  });
});
