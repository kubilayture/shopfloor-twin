import type { ColumnType, JSONColumnType } from 'kysely';

/** Read as a Date; written as a Date or an ISO string. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
/** Defaults in the database. */
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
/** A generated id or a column only the database writes. */
type Generated<T> = ColumnType<T, never, never>;

/** The five roles (#168, migration 0016); seeded by the migration, compared with contracts. */
export interface RoleTable {
  id: string;
  description: string;
}

export interface UserAccountTable {
  id: Generated<number>;
  username: string;
  password_hash: string;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  must_change_password: ColumnType<boolean, boolean | undefined, boolean>;
  failed_logins: ColumnType<number, number | undefined, number>;
  next_attempt_at: NullableTimestamp;
  password_changed_at: DefaultTimestamp;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface UserRoleTable {
  user_id: number;
  role_id: string;
}

/**
 * Consecutive failures of one account from one address and the lock the fifth sets (#242,
 * migration 0033); never an admin's.
 */
export interface LoginAddressTable {
  user_id: number;
  address: string;
  failed_logins: number;
  locked_until: NullableTimestamp;
  last_failure_at: Timestamp;
}

/** One judged failed login of an account, kept 15 minutes for the global delay (#242). */
export interface LoginFailureTable {
  id: Generated<number>;
  user_id: number;
  address: string;
  at: Timestamp;
}

export type SessionEndReason =
  'logout' | 'password-changed' | 'password-reset' | 'user-disabled' | 'replaced';

export interface SessionTable {
  token_hash: Buffer;
  user_id: number;
  kind: 'desk' | 'terminal';
  created_at: Timestamp;
  last_used_at: Timestamp;
  idle_expires_at: Timestamp;
  expires_at: Timestamp;
  ended_at: NullableTimestamp;
  end_reason: ColumnType<
    SessionEndReason | null,
    SessionEndReason | null | undefined,
    SessionEndReason | null
  >;
}

/** One audited action, append-only (#168; the module audits join it in #169). */
export interface AuditLogTable {
  id: Generated<number>;
  at: ColumnType<Date, Date | string | undefined, never>;
  plant_at: ColumnType<Date | null, Date | string | null | undefined, never>;
  user_id: ColumnType<number | null, number | null | undefined, never>;
  username: ColumnType<string, string, never>;
  roles: ColumnType<string[], string[] | undefined, never>;
  authenticated: ColumnType<boolean, boolean, never>;
  action: ColumnType<string, string, never>;
  entity_type: ColumnType<string, string, never>;
  entity_id: ColumnType<string, string, never>;
  before: JSONColumnType<object | null, string | null | undefined, never>;
  after: JSONColumnType<object | null, string | null | undefined, never>;
  request_id: ColumnType<string | null, string | null | undefined, never>;
  legacy: ColumnType<boolean, boolean | undefined, never>;
}

export interface IdentityTables {
  'identity.role': RoleTable;
  'identity.user_account': UserAccountTable;
  'identity.user_role': UserRoleTable;
  'identity.session': SessionTable;
  'identity.audit_log': AuditLogTable;
  'identity.login_address': LoginAddressTable;
  'identity.login_failure': LoginFailureTable;
}

export const IDENTITY_COLUMNS = {
  'identity.role': ['id', 'description'],
  'identity.user_account': [
    'id',
    'username',
    'password_hash',
    'enabled',
    'must_change_password',
    'failed_logins',
    'next_attempt_at',
    'password_changed_at',
    'created_at',
    'updated_at',
  ],
  'identity.user_role': ['user_id', 'role_id'],
  'identity.session': [
    'token_hash',
    'user_id',
    'kind',
    'created_at',
    'last_used_at',
    'idle_expires_at',
    'expires_at',
    'ended_at',
    'end_reason',
  ],
  'identity.audit_log': [
    'id',
    'at',
    'plant_at',
    'user_id',
    'username',
    'roles',
    'authenticated',
    'action',
    'entity_type',
    'entity_id',
    'before',
    'after',
    'request_id',
    'legacy',
  ],
  'identity.login_address': [
    'user_id',
    'address',
    'failed_logins',
    'locked_until',
    'last_failure_at',
  ],
  'identity.login_failure': ['id', 'user_id', 'address', 'at'],
} as const;
