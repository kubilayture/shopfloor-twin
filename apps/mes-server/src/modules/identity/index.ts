/**
 * The `identity` module (#168, ADR-0026): users with roles, scrypt password hashes, sessions whose
 * tokens live in the `sft_session` cookie (only their SHA-256 is stored), failed-login lockout with
 * a delay instead of a lock for admins, the optional bootstrap admin and the append-only audit log.
 * The permission matrix is `ROLE_PERMISSIONS` in `@shopfloor/contracts/identity`. Other modules use
 * only what is exported here.
 *
 * - `Identity.start({ bootstrapAdminPassword })` (after the migrations) and `stop()`.
 * - `login(...)`, `authenticate(token)`, `live(sessionId)`, `logout(principal)`,
 *   `changePassword(...)`: sessions; every failed login throws the same `IdentityError`.
 * - `users()`, `user(name)`, `createUser(...)`, `updateUser(...)`, `resetPassword(...)`.
 * - `onSessionsEnded(listener)`: sessions ended before expiring (sockets close with 4401).
 * - `Identity.audit(trx, ...entries)`: rows of `identity.audit_log` inside the caller's transaction,
 *   the one way every module writes its audit (#169); `Identity.auditEntries(db, type, ids)` reads
 *   an entity's rows back for its history endpoint. `WriteBy` (a session's user; a typed name
 *   only in module tests since #170) with `nameOf`, `isAuthenticated` and `auditActor`.
 */
export {
  IDENTITY_LIMITS,
  Identity,
  IdentityError,
  LOGIN_FAILED,
  auditActor,
  isAuthenticated,
  nameOf,
  parseToken,
  passwordProblem,
} from './identity.ts';
export type {
  Actor,
  AuditActor,
  AuditCondition,
  AuditEntry,
  AuditQuery,
  IdentityErrorKind,
  IdentityLog,
  IdentityOptions,
  Principal,
  SessionInfo,
  SessionUser,
  SessionsEnded,
  StoredAuditEntry,
  User,
  WriteBy,
} from './identity.ts';
export {
  SCRYPT_MAXMEM,
  SCRYPT_PARAMS,
  Semaphore,
  hashPassword,
  hashesRunning,
  needsRehash,
  parseHash,
  verifyPassword,
} from './password.ts';
export type { ScryptParams } from './password.ts';
export { IDENTITY_COLUMNS } from './tables.ts';
export type { IdentityTables, SessionEndReason } from './tables.ts';
