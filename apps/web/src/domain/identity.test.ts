import { PERMISSIONS, permissionsOf } from '@shopfloor/contracts/identity';
import { PROBLEM_TYPES } from '@shopfloor/contracts/mes-api';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import { authSignalOf } from '../auth/events.ts';
import { countdownText, idleDeadline } from '../auth/idle.ts';
import { safeRedirect } from '../auth/redirect.ts';
import { sessionOf } from '../test/fixtures.ts';
import {
  loginFailure,
  PERMISSION_AREAS,
  PERMISSION_LABELS,
  passwordChangeFailure,
  passwordFormProblems,
  permissionGroups,
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
      // Normalised by the URL parser to `//evil.test` (#170 review M1): dot segments are refused.
      '/.//evil.test',
      '/..//evil.test',
      '/%2e//evil.test',
      '/%2E%2E//evil.test',
      '/a/..//evil.test/x',
      '/a/./b',
      '/%zz',
      // `/login` in any case, with trailing slashes.
      '/login/',
      '/LOGIN',
      '/Login//?redirect=/x',
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
      idleExpiresAt: '2026-10-15T23:00:00.000Z',
      expiresAt: '2026-10-15T18:00:00.000Z',
    };
    expect(idleDeadline(session, now)).toEqual({ at: now + 3_600_000, absolute: false });
    // The MES's own idle expiry, when earlier (#170 review M3): never past the MES's deadline.
    expect(idleDeadline({ ...session, idleExpiresAt: '2026-10-15T08:30:00.000Z' }, now)).toEqual({
      at: Date.parse('2026-10-15T08:30:00.000Z'),
      absolute: false,
    });
    // The MES's clock 3 minutes ahead of this one: its times move 3 minutes earlier here.
    expect(
      idleDeadline({ ...session, idleExpiresAt: '2026-10-15T08:30:00.000Z' }, now, 180_000),
    ).toEqual({ at: Date.parse('2026-10-15T08:27:00.000Z'), absolute: false });
    expect(idleDeadline(session, Date.parse('2026-10-15T17:30:00.000Z'), -60_000)).toEqual({
      at: Date.parse('2026-10-15T18:01:00.000Z'),
      absolute: true,
    });
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
    const texts = (next: string, confirm: string, current?: string) =>
      passwordFormProblems(next, confirm, current).map((problem) => problem.text);
    expect(texts('long enough pw', 'long enough pw', 'old one here')).toEqual([]);
    expect(texts('short', 'short')).toEqual([
      'The new password needs 12 to 128 characters (it has 5).',
    ]);
    expect(texts('same password', 'same password', 'same password')).toEqual([
      'The new password must differ from the current one.',
    ]);
    expect(texts('long enough pw', 'long enough px')).toEqual(['The two new passwords differ.']);
    // Characters, not UTF-16 units.
    expect(texts('🔒'.repeat(12), '🔒'.repeat(12))).toEqual([]);
  });

  it('ties each problem of the password form to its field (UX-11)', () => {
    expect(passwordFormProblems('long enough pw', 'long enough pw', 'old one here')).toEqual([]);
    // The forced change knows the current password: no field of its own to blame.
    expect(passwordFormProblems('long enough pw', 'long enough pw')).toEqual([]);
    expect(passwordFormProblems('short', 'shorter', '')).toEqual([
      { field: 'current', text: 'Enter your current password.' },
      { field: 'next', text: 'The new password needs 12 to 128 characters (it has 5).' },
      { field: 'confirm', text: 'The two new passwords differ.' },
    ]);
    expect(passwordFormProblems('same password', 'same password', 'same password')).toEqual([
      { field: 'next', text: 'The new password must differ from the current one.' },
    ]);
    expect(passwordFormProblems('x'.repeat(129), 'x'.repeat(129), 'old one here')).toEqual([
      { field: 'next', text: 'The new password needs 12 to 128 characters (it has 129).' },
    ]);
  });

  it('says every permission in words, grouped by area in reading order (UX-11, Y-02)', () => {
    for (const permission of PERMISSIONS) {
      expect(PERMISSION_AREAS).toContain(PERMISSION_LABELS[permission].area);
      expect(PERMISSION_LABELS[permission].text).toMatch(/^[A-Z][a-z]/);
    }
    // Every area holds a permission.
    expect(new Set(PERMISSIONS.map((p) => PERMISSION_LABELS[p].area))).toEqual(
      new Set(PERMISSION_AREAS),
    );
    const groups = permissionGroups(permissionsOf(['supervisor']));
    expect(groups.map((group) => group.area)).toEqual(
      PERMISSION_AREAS.filter((area) => groups.some((group) => group.area === area)),
    );
    expect(permissionGroups(['scrap:code', 'read', 'downtime:code'])).toEqual([
      { area: 'Plant data', permissions: [{ id: 'read', text: 'See every screen of the plant' }] },
      {
        area: 'Downtime and scrap',
        permissions: [
          { id: 'scrap:code', text: 'Code scrap' },
          { id: 'downtime:code', text: 'Code downtime' },
        ],
      },
    ]);
    expect(permissionGroups([])).toEqual([]);
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
    // What the app does about a refusal (#170 review L4): a 403 forbidden reads the session again.
    expect(authSignalOf(problem(401, PROBLEM_TYPES.unauthenticated))).toBe('ended');
    expect(authSignalOf(problem(403, PROBLEM_TYPES.passwordChangeRequired))).toBe('password');
    expect(authSignalOf(problem(403, PROBLEM_TYPES.forbidden))).toBe('forbidden');
    expect(authSignalOf(problem(403, PROBLEM_TYPES.writeOrigin))).toBeUndefined();
    expect(authSignalOf(new Error('x'))).toBeUndefined();
  });
});
