import { STATUS_CODES } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/** An error answer of the API: RFC 9457 problem details. */
export class HttpProblem extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

export const PROBLEM_TYPE = 'application/problem+json';

export function problem(status: number, detail: string, url: string) {
  return {
    type: 'about:blank',
    title: STATUS_CODES[status] ?? 'Error',
    status,
    detail,
    instance: url.split('?', 1)[0] ?? url,
  };
}

const ERROR_TEXT: Readonly<Record<number, string>> = {
  400: 'Invalid path, query parameters or body',
  403: 'Host, Origin or Sec-Fetch-Site not allowed (a write needs a same-origin or allowlisted Origin)',
  404: 'Unknown equipment, work center, metric, shift, shift instance, record, alarm, alarm point, handover note or route',
  405: 'Writes are turned off (MES_WRITES=off)',
  409: 'The version sent is not the current one (coding set, alarm shelf, handover note): read again and retry; or the handover of the shift is closed (plant time, or a newer epoch)',
  413: 'Body larger than 16 KiB',
  415: 'Content-Type is not application/json',
  422: 'Well-formed, but not applicable (a coding outside its record, overlapping or with an unknown reason; a shelf longer than maxShelveMs, without a plant clock,, an unshelve of a point not shelved; a note beyond 200 per shift)',
  429: 'Too many writes (one global limit): retry after Retry-After seconds',
  503: 'The MES is starting',
};

export type ErrorStatus = 400 | 403 | 404 | 405 | 409 | 413 | 415 | 422 | 429 | 503;

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
}

/**
 * A GET route whose path and query are validated by zod (the parsed values reach the handler)
 * and whose response is typed by a zod schema. The same schemas, as JSON Schema, describe the
 * route in the OpenAPI document. A handler throws `HttpProblem` for an error answer.
 */
function errorResponses(errors: readonly ErrorStatus[]) {
  const problemContent = { [PROBLEM_TYPE]: { schema: { $ref: 'Problem#' } } };
  return Object.fromEntries(
    errors.map((code) => [code, { description: ERROR_TEXT[code], content: problemContent }]),
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
  }) => z.input<R> | Promise<z.input<R>>,
): void {
  app.route({
    method: spec.method,
    url: spec.url,
    bodyLimit,
    schema: {
      summary: spec.summary,
      ...(spec.description === undefined ? {} : { description: spec.description }),
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
        ...errorResponses(spec.errors),
      },
    },
    validatorCompiler: validator({
      params: spec.params,
      body: spec.body,
      ...(spec.query ? { querystring: spec.query } : {}),
    }),
    serializerCompiler: () => (data: unknown) => JSON.stringify(data),
    handler: async (request) =>
      handler({
        params: request.params as z.output<P>,
        query: request.query as z.output<Q>,
        body: request.body as z.output<B>,
        requestId: request.id,
      }),
  });
}

export function getRoute<P extends z.ZodType, Q extends z.ZodType, R extends z.ZodType>(
  app: FastifyInstance,
  spec: RouteSpec<P, Q, R>,
  handler: (input: { params: z.output<P>; query: z.output<Q> }) => z.input<R> | Promise<z.input<R>>,
): void {
  app.route({
    method: 'GET',
    url: spec.url,
    schema: {
      summary: spec.summary,
      ...(spec.description === undefined ? {} : { description: spec.description }),
      tags: [...spec.tags],
      ...(spec.params ? { params: jsonSchema(spec.params, 'input') } : {}),
      querystring: jsonSchema(spec.query, 'input'),
      response: {
        200: {
          description: 'OK',
          content: { 'application/json': { schema: jsonSchema(spec.response, 'output') } },
        },
        ...errorResponses(spec.errors),
      },
    },
    validatorCompiler: validator({ params: spec.params, querystring: spec.query }),
    // Responses are typed by the handler's return type; JSON.stringify keeps them as built.
    serializerCompiler: () => (data: unknown) => JSON.stringify(data),
    handler: async (request) =>
      handler({
        params: request.params as z.output<P>,
        query: request.query as z.output<Q>,
      }),
  });
}
