import { STATUS_CODES } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Permission } from '@shopfloor/contracts/identity';
import type { ProblemType } from '@shopfloor/contracts/mes-api';
import { z } from 'zod';

/** An error answer of the API: RFC 9457 problem details, `about:blank` unless typed (#163). */
export class HttpProblem extends Error {
  readonly status: number;
  readonly type: ProblemType | undefined;
  /** The holds a refusal names (#203), served as the problem's `holds`. */
  readonly holds: readonly string[] | undefined;

  constructor(status: number, detail: string, type?: ProblemType, holds?: readonly string[]) {
    super(detail);
    this.status = status;
    this.type = type;
    this.holds = holds;
  }
}

export const PROBLEM_TYPE = 'application/problem+json';

export function problem(
  status: number,
  detail: string,
  url: string,
  type?: ProblemType,
  holds?: readonly string[],
) {
  return {
    type: type ?? 'about:blank',
    title: STATUS_CODES[status] ?? 'Error',
    status,
    detail,
    instance: url.split('?', 1)[0] ?? url,
    ...(holds === undefined ? {} : { holds: [...holds] }),
  };
}

/**
 * Who may call a route (#168, ADR-0026): a permission of `ROLE_PERMISSIONS`, `session` (any logged
 * in user, also one that must change the password: the session and password routes) or `public`
 * (the login). With `MES_AUTH=off` (#170) only `read` routes are served without a session.
 */
export type Access = Permission | 'session' | 'public';

/** A route's access, kept in its Fastify config for the `/api/v1` hook. */
export interface RouteConfig {
  readonly access: Access;
  /**
   * Whether this request counts as use of its session (moves its idle expiry, ADR-0026); every
   * request does unless the route says otherwise (#237: the console's permission check counts
   * only a non-GET console action).
   */
  readonly touch?: (request: FastifyRequest) => boolean;
}

const ACCESS_TEXT: Readonly<Record<'session' | 'public', string>> = {
  session: 'Access: a session (also one whose password must be changed).',
  public: 'Access: anyone (no session needed).',
};

/** The route description with its access appended, as the OpenAPI document shows it. */
function described(description: string | undefined, access: Access): string {
  const line =
    access === 'session' || access === 'public'
      ? ACCESS_TEXT[access]
      : `Access: permission \`${access}\` (MES_AUTH=on; ADR-0026).`;
  return description === undefined ? line : `${description} ${line}`;
}

const ERROR_TEXT: Readonly<Record<number, string>> = {
  400: 'Invalid path, query parameters or body',
  401: 'No session, or it ended or expired (MES_AUTH=on), or a failed login; type urn:shopfloor:unauthenticated',
  403: 'Host, Origin or Sec-Fetch-Site not allowed (a write needs a same-origin or allowlisted Origin; type urn:shopfloor:host-not-allowed or, for a write, urn:shopfloor:write-origin); or the session lacks the permission (urn:shopfloor:forbidden) or must change its password first (urn:shopfloor:password-change-required)',
  404: 'Unknown equipment, work center, metric, shift, shift instance, record, alarm, alarm point, handover note, order, order operation, SPC characteristic, limit version, signal or route',
  405: 'Writes are turned off (MES_WRITES=off; the login, logout and password change stay open); type urn:shopfloor:writes-off',
  409: 'The version sent is not the current one (type urn:shopfloor:coding-stale, shelf-stale or note-stale): read again and retry; or the handover of the shift is closed (plant time, or a newer epoch; urn:shopfloor:handover-closed) or not open yet (urn:shopfloor:handover-not-open); or a user of that name exists (urn:shopfloor:user-exists), or the change would leave no enabled admin; or an order changed (urn:shopfloor:order-stale), is in a status the write does not apply to (urn:shopfloor:order-state), or has an earlier command not settled (urn:shopfloor:commands-unsettled); or a scrap record changed (urn:shopfloor:scrap-stale); or a close before every operation is signed off (urn:shopfloor:sign-off-missing); or a terminal write on an operation that changed (urn:shopfloor:operation-stale) or whose state does not allow it (urn:shopfloor:operation-state), by an operator not signed on at the work center (urn:shopfloor:not-signed-on), a sign-on without a terminal session (urn:shopfloor:terminal-session-required) or outside a shift (urn:shopfloor:no-shift); or an SPC characteristic changed (urn:shopfloor:limits-stale), a limit version is ended already (urn:shopfloor:limits-ended) or version 1 does not exist yet (urn:shopfloor:limits-v1-missing); or a signal changed (urn:shopfloor:signal-stale), is withdrawn (urn:shopfloor:signal-withdrawn) or acknowledged already (urn:shopfloor:signal-acknowledged); or a hold changed (urn:shopfloor:hold-stale) or is decided already (urn:shopfloor:hold-decided); or an order’s close while a unit of it is in an open hold (urn:shopfloor:quality-hold) or before genealogy has processed every fact of its units (urn:shopfloor:genealogy-pending: retry after Retry-After)',
  413: 'Body larger than 16 KiB',
  415: 'Content-Type is not application/json; type urn:shopfloor:write-not-json',
  422: 'Well-formed, but not applicable (a coding outside its record, overlapping or with an unknown reason; a shelf longer than maxShelveMs, without a plant clock,, an unshelve of a point not shelved; a note beyond 200 per shift, type urn:shopfloor:note-limit; a password outside 12–128 characters, equal to the current one, or a wrong current password, type urn:shopfloor:password-rejected; a dispatch to equipment that is not a CNC or has no known device run, or a re-dispatch beyond the remaining blanks; a limit window without final first-pass readings, a moving range or a complete subgroup)',
  429: "Too many writes (the global limit, or the user's own; type urn:shopfloor:write-rate) or logins (all together, or per user name, or within the user's global delay after 10 failed logins in 15 minutes; type urn:shopfloor:login-rate): retry after Retry-After seconds",
  503: 'The MES is starting',
};

export type ErrorStatus = 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 422 | 429 | 503;

/** JSON Schema (2020-12, as OpenAPI 3.1 uses) of a zod schema, without `$schema`. */
export function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const result: Record<string, unknown> = z.toJSONSchema(schema, { io, unrepresentable: 'any' });
  delete result.$schema;
  return result;
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
    .join('; ');
}

export interface RouteSpec<P extends z.ZodType, Q extends z.ZodType, R extends z.ZodType> {
  readonly url: string;
  readonly summary: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly params?: P;
  readonly query: Q;
  readonly response: R;
  readonly errors: readonly ErrorStatus[];
  /** Default `read`. */
  readonly access?: Access;
  /** The route answers 304 to a matching `If-None-Match` (its handler sets `ETag`). */
  readonly etag?: boolean;
  /** See `RouteConfig.touch`. */
  readonly touch?: (request: FastifyRequest) => boolean;
  /** The route answers 204 without a body (#237: a permission check); `response` is unused. */
  readonly noContent?: boolean;
}

/**
 * A GET route whose path and query are validated by zod (the parsed values reach the handler)
 * and whose response is typed by a zod schema. The same schemas, as JSON Schema, describe the
 * route in the OpenAPI document. A handler throws `HttpProblem` for an error answer.
 */
function errorResponses(errors: readonly ErrorStatus[], access: Access) {
  const problemContent = { [PROBLEM_TYPE]: { schema: { $ref: 'Problem#' } } };
  // Every route but the login may answer 401, and every route 403 (#168).
  const all = new Set<ErrorStatus>([
    ...errors,
    403,
    ...(access === 'public' ? [] : [401 as const]),
  ]);
  return Object.fromEntries(
    [...all]
      .sort((a, b) => a - b)
      .map((code) => [code, { description: ERROR_TEXT[code], content: problemContent }]),
  );
}

/** Zod parses each part (the parsed values reach the handler); a failure is a 400. */
function validator(parts: Record<string, z.ZodType | undefined>) {
  return ({ httpPart }: { httpPart?: string }) =>
    (data: unknown) => {
      const schema = httpPart === undefined ? undefined : parts[httpPart];
      if (!schema) return { value: data };
      const result = schema.safeParse(data);
      return result.success
        ? { value: result.data }
        : { error: new HttpProblem(400, `${httpPart ?? ''}: ${issues(result.error)}`) };
    };
}

export interface WriteRouteSpec<
  P extends z.ZodType,
  B extends z.ZodType,
  R extends z.ZodType,
  Q extends z.ZodType = z.ZodType,
> {
  readonly method: 'PUT' | 'POST' | 'DELETE';
  readonly url: string;
  readonly summary: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly params: P;
  /** Query parameters, if the write takes any (#144: `?epoch`). */
  readonly query?: Q;
  readonly body: B;
  readonly response: R;
  readonly errors: readonly ErrorStatus[];
  /** The permission the write needs (MES_AUTH=on), or `session` / `public`. */
  readonly access: Access;
}

/**
 * A write route (#121, ADR-0023): path and JSON body validated by zod, the response typed. The
 * write guards run before it in the `/api/v1` hooks; the body is at most `bodyLimit` bytes.
 */
export function writeRoute<
  P extends z.ZodType,
  B extends z.ZodType,
  R extends z.ZodType,
  Q extends z.ZodType = z.ZodType,
>(
  app: FastifyInstance,
  spec: WriteRouteSpec<P, B, R, Q>,
  bodyLimit: number,
  handler: (input: {
    params: z.output<P>;
    query: z.output<Q>;
    body: z.output<B>;
    requestId: string;
    request: FastifyRequest;
    reply: FastifyReply;
  }) => z.input<R> | Promise<z.input<R>>,
): void {
  const config: RouteConfig = { access: spec.access };
  app.route({
    method: spec.method,
    url: spec.url,
    bodyLimit,
    config,
    schema: {
      summary: spec.summary,
      description: described(spec.description, spec.access),
      tags: [...spec.tags],
      params: jsonSchema(spec.params, 'input'),
      ...(spec.query ? { querystring: jsonSchema(spec.query, 'input') } : {}),
      body: {
        content: { 'application/json': { schema: jsonSchema(spec.body, 'input') } },
        required: true,
      },
      response: {
        200: {
          description: 'OK',
          content: { 'application/json': { schema: jsonSchema(spec.response, 'output') } },
        },
        ...errorResponses(spec.errors, spec.access),
      },
    },
    validatorCompiler: validator({
      params: spec.params,
      body: spec.body,
      ...(spec.query ? { querystring: spec.query } : {}),
    }),
    serializerCompiler: () => (data: unknown) => JSON.stringify(data),
    handler: async (request, reply) =>
      handler({
        params: request.params as z.output<P>,
        query: request.query as z.output<Q>,
        body: request.body as z.output<B>,
        requestId: request.id,
        request,
        reply,
      }),
  });
}

export function getRoute<P extends z.ZodType, Q extends z.ZodType, R extends z.ZodType>(
  app: FastifyInstance,
  spec: RouteSpec<P, Q, R>,
  handler: (input: {
    params: z.output<P>;
    query: z.output<Q>;
    request: FastifyRequest;
    reply: FastifyReply;
  }) => z.input<R> | Promise<z.input<R>>,
): void {
  const access = spec.access ?? 'read';
  const config: RouteConfig = { access, ...(spec.touch ? { touch: spec.touch } : {}) };
  app.route({
    method: 'GET',
    url: spec.url,
    config,
    schema: {
      summary: spec.summary,
      description: described(spec.description, access),
      tags: [...spec.tags],
      ...(spec.params ? { params: jsonSchema(spec.params, 'input') } : {}),
      querystring: jsonSchema(spec.query, 'input'),
      response: {
        ...(spec.noContent === true
          ? { 204: { description: 'No Content' } }
          : {
              200: {
                description: 'OK',
                content: { 'application/json': { schema: jsonSchema(spec.response, 'output') } },
              },
            }),
        ...(spec.etag === true
          ? { 304: { description: 'Not modified: `If-None-Match` names the current `ETag`' } }
          : {}),
        ...errorResponses(spec.errors, access),
      },
    },
    validatorCompiler: validator({ params: spec.params, querystring: spec.query }),
    // Responses are typed by the handler's return type; JSON.stringify keeps them as built.
    serializerCompiler: () => (data: unknown) => JSON.stringify(data),
    handler: async (request, reply) =>
      handler({
        params: request.params as z.output<P>,
        query: request.query as z.output<Q>,
        request,
        reply,
      }),
  });
}
