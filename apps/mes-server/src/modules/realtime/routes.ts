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
  400: 'Invalid path or query parameters',
  404: 'Unknown equipment, metric or route',
  503: 'The MES is starting',
};

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
  readonly errors: readonly (400 | 404 | 503)[];
}

/**
 * A GET route whose path and query are validated by zod (the parsed values reach the handler)
 * and whose response is typed by a zod schema. The same schemas, as JSON Schema, describe the
 * route in the OpenAPI document. A handler throws `HttpProblem` for an error answer.
 */
export function getRoute<P extends z.ZodType, Q extends z.ZodType, R extends z.ZodType>(
  app: FastifyInstance,
  spec: RouteSpec<P, Q, R>,
  handler: (input: { params: z.output<P>; query: z.output<Q> }) => z.input<R> | Promise<z.input<R>>,
): void {
  const parts: Record<string, z.ZodType | undefined> = {
    params: spec.params,
    querystring: spec.query,
  };
  const problemContent = { [PROBLEM_TYPE]: { schema: { $ref: 'Problem#' } } };
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
        ...Object.fromEntries(
          spec.errors.map((code) => [
            code,
            { description: ERROR_TEXT[code], content: problemContent },
          ]),
        ),
      },
    },
    validatorCompiler:
      ({ httpPart }) =>
      (data: unknown) => {
        const schema = httpPart === undefined ? undefined : parts[httpPart];
        if (!schema) return { value: data };
        const result = schema.safeParse(data);
        return result.success
          ? { value: result.data }
          : { error: new HttpProblem(400, `${httpPart ?? ''}: ${issues(result.error)}`) };
      },
    // Responses are typed by the handler's return type; JSON.stringify keeps them as built.
    serializerCompiler: () => (data: unknown) => JSON.stringify(data),
    handler: async (request) =>
      handler({
        params: request.params as z.output<P>,
        query: request.query as z.output<Q>,
      }),
  });
}
