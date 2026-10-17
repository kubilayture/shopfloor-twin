import type { Role } from '@shopfloor/contracts/identity';
import { PROBLEM_TYPES, type SessionDto, type UserDto } from '@shopfloor/contracts/mes-api';
import { EQUIPMENT, PLANT, json, problem, sessionOf } from './fixtures.ts';

// Generated per run: no password is written into the repository.
export const PASSWORD = `pw-${crypto.randomUUID()}`;
export const NEW_PASSWORD = `new-${crypto.randomUUID()}`;

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** A small MES with sessions: `GET /session`, login, logout, the password change, reads, users. */
export function fakeMes(
  options: {
    roles?: Role[];
    mustChange?: boolean;
    signedIn?: boolean;
    users?: UserDto[];
    /** The session `GET /session` answers while signed in (read on every call). */
    session?: () => SessionDto;
  } = {},
) {
  const roles = options.roles ?? ['supervisor'];
  let username = 'ayse';
  const signedIn = (must = false) =>
    options.session?.() ?? sessionOf(roles, { mustChangePassword: must, username });
  let session: SessionDto | null = options.signedIn ? signedIn() : null;
  const users = [...(options.users ?? [])];
  const calls: Call[] = [];
  const unauthenticated = (path: string) =>
    problem(401, 'Unauthorized', 'a session is needed', path, PROBLEM_TYPES.unauthenticated);
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
      'http://localhost',
    );
    const method = init?.method ?? 'GET';
    const body: unknown =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname, body });
    const path = url.pathname;
    await Promise.resolve();
    if (path === '/api/v1/session') {
      if (method === 'GET') {
        if (session && options.session) session = options.session();
        return session ? json(session) : unauthenticated(path);
      }
      if (method === 'DELETE') {
        const ended = session !== null;
        session = null;
        return json({ ended });
      }
      const login = body as { username: string; password: string };
      if (login.password !== PASSWORD) {
        return problem(401, 'Unauthorized', 'login failed', path, PROBLEM_TYPES.unauthenticated);
      }
      username = login.username;
      session = signedIn(options.mustChange);
      return json(session);
    }
    if (!session) return unauthenticated(path);
    if (path === '/api/v1/account/password') {
      session = signedIn(false);
      return json({ changed: true, endedSessions: 1 });
    }
    if (session.user.mustChangePassword) {
      return problem(403, 'Forbidden', 'change it', path, PROBLEM_TYPES.passwordChangeRequired);
    }
    if (path === '/api/v1/equipment') return json({ equipment: EQUIPMENT });
    if (path === '/api/v1/plant') return json(PLANT);
    if (path === '/api/v1/users' && method === 'GET') return json({ users });
    if (path === '/api/v1/users' && method === 'POST') {
      const request = body as { username: string; roles: Role[] };
      const user: UserDto = {
        id: users.length + 10,
        username: request.username,
        roles: request.roles,
        enabled: true,
        mustChangePassword: true,
        locked: false,
        createdAt: '2026-10-15T06:00:00.000Z',
        updatedAt: '2026-10-15T06:00:00.000Z',
      };
      users.push(user);
      return json(user);
    }
    return problem(404, 'Not Found', 'no route', path);
  };
  return {
    fetch,
    calls,
    end: () => {
      session = null;
    },
  };
}
