import {
  loginRequestSchema,
  passwordChangeRequestSchema,
  passwordChangeResultSchema,
  passwordResetRequestSchema,
  sessionSchema,
  userCreateRequestSchema,
  userListSchema,
  userSchema,
  userUpdateRequestSchema,
  type LoginRequest,
  type PasswordChangeRequest,
  type PasswordChangeResult,
  type SessionDto,
  type UserCreateRequest,
  type UserDto,
  type UserList,
  type UserUpdateRequest,
} from '@shopfloor/contracts/mes-api';
import { z } from 'zod';
import { ApiError, getJson, sendJson } from './client.ts';

// Identity (#168, #170, ADR-0026): the session and user administration routes of the MES.

/** The caller's session, or null when there is none (401): the web then shows `/login`. */
export async function getSession(signal?: AbortSignal): Promise<SessionDto | null> {
  try {
    return await getJson('/session', sessionSchema, signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/** Logs in: the MES sets the `HttpOnly` session cookie; the answer is the new session. */
export function login(body: LoginRequest): Promise<SessionDto> {
  return sendJson('POST', '/session', loginRequestSchema.parse(body), sessionSchema);
}

/** Logs out: ends the session (if live) and clears the cookie; never needs a live session. */
export function logout(): Promise<{ readonly ended: boolean }> {
  return sendJson('DELETE', '/session', {}, z.object({ ended: z.boolean() }));
}

/** Changes the caller's own password; ends the user's other sessions. */
export function changePassword(body: PasswordChangeRequest): Promise<PasswordChangeResult> {
  return sendJson(
    'POST',
    '/account/password',
    passwordChangeRequestSchema.parse(body),
    passwordChangeResultSchema,
  );
}

export function getUsers(signal?: AbortSignal): Promise<UserList> {
  return getJson('/users', userListSchema, signal);
}

/** Creates a user with a temporary password (it must change it at the first login). */
export function createUser(body: UserCreateRequest): Promise<UserDto> {
  return sendJson('POST', '/users', userCreateRequestSchema.parse(body), userSchema);
}

/** Changes a user's roles or whether it may log in (disabling ends its sessions). */
export function updateUser(username: string, body: UserUpdateRequest): Promise<UserDto> {
  return sendJson(
    'PUT',
    `/users/${encodeURIComponent(username)}`,
    userUpdateRequestSchema.parse(body),
    userSchema,
  );
}

/** Sets a temporary password; ends the user's sessions and clears a lock. */
export function resetPassword(username: string, password: string): Promise<UserDto> {
  return sendJson(
    'POST',
    `/users/${encodeURIComponent(username)}/password`,
    passwordResetRequestSchema.parse({ password }),
    userSchema,
  );
}
