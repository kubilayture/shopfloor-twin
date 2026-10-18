import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  USERNAME_PATTERN,
  can,
  permissionsOf,
  type Permission,
  type Role,
} from './identity.ts';
import { loginRequestSchema, userCreateRequestSchema } from './mes-api.ts';

/**
 * The Phase 7 plan's table ("Identity"), column by column: ✓ marks as written there; the Phase 8
 * plan's rows (#200: `spc:limits` quality, `spc:ack` quality and supervisor; #201: `quality:hold`
 * quality and supervisor, `quality:release` quality).
 */
const PLAN: Record<Permission, string> = {
  //                  operator maintenance quality supervisor admin
  read: '✓✓✓✓✓',
  'downtime:code': '✓✓·✓·',
  'alarm:ack': '✓✓✓✓·',
  'alarm:comment': '✓✓✓✓·',
  'alarm:shelve': '·✓·✓·',
  'note:write': '✓✓✓✓·',
  'terminal:operate': '✓··✓·',
  'scrap:code': '✓·✓✓·',
  'order:release': '···✓·',
  'order:dispatch': '···✓·',
  'order:cancel': '···✓·',
  'order:redispatch': '···✓·',
  'order:close': '···✓·',
  'order:abandon': '···✓·',
  'spc:limits': '··✓··',
  'spc:ack': '··✓✓·',
  'quality:hold': '··✓✓·',
  'quality:release': '··✓··',
  'user:admin': '····✓',
};

describe('permission matrix (#168, ADR-0026)', () => {
  it('equals the Phase 7 and Phase 8 plans, cell by cell', () => {
    const order: Role[] = ['operator', 'maintenance', 'quality', 'supervisor', 'admin'];
    expect([...ROLES].sort()).toEqual([...order].sort());
    expect(Object.keys(PLAN).sort()).toEqual([...PERMISSIONS].sort());
    for (const permission of PERMISSIONS) {
      const row = Array.from(PLAN[permission]);
      order.forEach((role, i) => {
        expect(ROLE_PERMISSIONS[role].includes(permission), `${role} ${permission}`).toBe(
          row[i] === '✓',
        );
      });
    }
  });

  it('keeps admin to user administration (separation of duties)', () => {
    expect(permissionsOf(['admin'])).toEqual(['read', 'user:admin']);
    expect(can(['admin'], 'downtime:code')).toBe(false);
    expect(can(['admin', 'supervisor'], 'order:release')).toBe(true);
    expect(permissionsOf(['operator', 'quality'])).toEqual(
      PERMISSIONS.filter((p) => can(['operator'], p) || can(['quality'], p)),
    );
    expect(can([], 'read')).toBe(false);
  });

  it('accepts user names and request bodies by the declared rules', () => {
    expect(USERNAME_PATTERN.test('anna.k')).toBe(true);
    expect(USERNAME_PATTERN.test('Anna')).toBe(false);
    expect(USERNAME_PATTERN.test('a')).toBe(false);
    expect(loginRequestSchema.parse({ username: 'x', password: 'y' }).kind).toBe('desk');
    expect(loginRequestSchema.safeParse({ username: 'x', password: 'y', extra: 1 }).success).toBe(
      false,
    );
    expect(
      userCreateRequestSchema.safeParse({
        username: 'anna',
        roles: ['operator', 'operator'],
        password: 'x',
      }).success,
    ).toBe(false);
    expect(
      userCreateRequestSchema.safeParse({ username: 'anna', roles: [], password: 'x' }).success,
    ).toBe(false);
  });
});
