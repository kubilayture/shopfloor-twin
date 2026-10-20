import { createHash, timingSafeEqual } from 'node:crypto';
import {
  STATUS_CODES,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  ERP_API_LIMITS,
  ERP_PROBLEM_TYPES,
  ERP_ORDER_NUMBER,
  HOLD_ID,
  MESSAGE_KINDS,
  confirmationKey,
  confirmationRequestSchema,
  erpOrderInputSchema,
  statusKey,
  idempotencyKeySchema,
  qualityNotificationKey,
  qualityNotificationRequestSchema,
  statusMessageRequestSchema,
  type ConfirmationRequest,
  type MessageKind,
  type OrderMessageKind,
  type StatusMessageRequest,
} from '@shopfloor/contracts/erp-api';
import type { z } from 'zod';
import type { Erp } from './erp.ts';
import type { Logger } from './log.ts';
import { DuplicateConfirmationError, DuplicateTransitionError, type ErpStore } from './store.ts';

export interface ErpServerOptions {
  readonly erp: Erp;
  readonly store: ErpStore;
  /** The shared bearer token (`ERP_API_TOKEN`). */
  readonly token: string;
  /** The dev-only `POST /api/v1/orders` (`ERP_ADMIN=on`). */
  readonly admin: boolean;
  readonly log: Logger;
  /** Wall clock, for `receivedAt` only. */
  readonly now?: () => Date;
}

/** An answer other than success, sent as RFC 9457 problem details. */
class HttpError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly type: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    detail: string,
    type = 'about:blank',
    headers: Readonly<Record<string, string>> = {},
  ) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.type = type;
    this.headers = headers;
  }
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

type Handler = (request: IncomingMessage, url: URL, params: readonly string[]) => Promise<Reply>;

interface Route {
  readonly pattern: RegExp;
  readonly methods: Readonly<Record<string, Handler>>;
}

const POST_OUTCOMES = [
  'created',
  'replayed',
  'conflict',
  'invalid',
  'key-mismatch',
  'unknown-order',
  'no-final',
  'unknown-subject',
  'hold-sequence',
  'hold-decided',
] as const;
type PostOutcome = (typeof POST_OUTCOMES)[number];

/** SHA-256 of a token: what the bearer check compares, 32 bytes whatever the token's length. */
export const tokenDigest = (value: string): Buffer =>
  createHash('sha256').update(value, 'utf8').digest();

/**
 * Whether an `Authorization` header carries the token whose digest is `expected` (#242, checklist
 * S7): `Bearer` (any case), one token, nothing else. The presented token is hashed first, so
 * `timingSafeEqual` always compares 32 bytes with 32 bytes: the time depends neither on where a
 * guess first differs nor on its length (a plain `===`, or `timingSafeEqual` on the raw values,
 * which throws on a length mismatch, would leak one or the other).
 */
export function bearerMatches(header: string | undefined, expected: Buffer): boolean {
  const match = /^Bearer[ ]+(\S+)\s*$/i.exec(header ?? '');
  return match?.[1] !== undefined && timingSafeEqual(tokenDigest(match[1]), expected);
}

/** The API's routes, for the test that every one of them needs the token (#242). */
export interface ErpApiRoute {
  readonly pattern: RegExp;
  readonly methods: readonly string[];
}

/** The ERP mock's server, with its `/api/v1` route table. */
export type ErpServer = Server & { readonly apiRoutes: readonly ErpApiRoute[] };

const issuesText = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(body)'}: ${issue.message}`)
    .join('; ');

function parseBody<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw new HttpError(422, issuesText(result.error));
  return result.data;
}

/** Reads a JSON body of at most `ERP_API_LIMITS.bodyBytes`. */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const type = request.headers['content-type'] ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new HttpError(415, 'the body must be application/json');
  }
  const limit = ERP_API_LIMITS.bodyBytes;
  const tooLarge = () =>
    new HttpError(413, `the body is larger than ${String(limit)} bytes`, 'about:blank', {
      connection: 'close',
    });
  if (Number(request.headers['content-length'] ?? 0) > limit) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw tooLarge();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'the body is not valid JSON');
  }
}

/** A non-negative integer query parameter. */
function integerParam(url: URL, name: string, fallback: number, max: number): number {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  if (!/^\d{1,15}$/.test(value) || Number(value) > max) {
    throw new HttpError(400, `${name} must be an integer from 0 to ${String(max)}`);
  }
  return Number(value);
}

/** A path segment, percent-decoded; a malformed one stays as it is (and matches nothing). */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function orderNumberParam(url: URL): string | undefined {
  const value = url.searchParams.get('orderNumber');
  if (value === null) return undefined;
  if (!ERP_ORDER_NUMBER.test(value)) throw new HttpError(400, 'orderNumber is not an order number');
  return value;
}

/**
 * The ERP mock's REST API (ADR-0028) on `node:http`: the order change feed, lots, idempotent
 * confirmations, status messages and quality notifications, the ERP's view of an order and of a
 * lot, and the dev-only order post.
 * Every `/api/v1` route needs the bearer token; `/health/*` and `/metrics` are open (loopback).
 */
export function createErpServer(options: ErpServerOptions): ErpServer {
  const { erp, store, log } = options;
  const now = options.now ?? (() => new Date());
  const expectedDigest = tokenDigest(options.token);
  const posts = new Map<string, number>();
  let unauthorized = 0;

  const count = (kind: string, outcome: PostOutcome) => {
    const key = `${kind}|${outcome}`;
    posts.set(key, (posts.get(key) ?? 0) + 1);
  };

  const authorized = (request: IncomingMessage): boolean =>
    bearerMatches(request.headers.authorization, expectedDigest);

  /** The `Idempotency-Key` header, or 400. */
  const readKey = (kind: MessageKind, request: IncomingMessage): string => {
    const header = request.headers['idempotency-key'];
    const key = idempotencyKeySchema.safeParse(header);
    if (!key.success) {
      count(kind, 'invalid');
      throw new HttpError(
        400,
        header === undefined
          ? 'the Idempotency-Key header is required'
          : `Idempotency-Key: ${issuesText(key.error)}`,
      );
    }
    return key.data;
  };

  /** The validated body, or 4xx. */
  const readMessage = async <S extends z.ZodType>(
    kind: MessageKind,
    schema: S,
    request: IncomingMessage,
  ): Promise<z.output<S>> => {
    try {
      return parseBody(schema, await readJson(request));
    } catch (error) {
      count(kind, 'invalid');
      throw error;
    }
  };

  /** 422 unless the key is the one built from the body. */
  const checkKey = (kind: MessageKind, key: string, expected: string): void => {
    if (key === expected) return;
    count(kind, 'key-mismatch');
    throw new HttpError(
      422,
      `Idempotency-Key ${key} is not the key of this ${kind}: expected ${expected}`,
      ERP_PROBLEM_TYPES.keyMismatch,
    );
  };

  /**
   * A key seen before: 200 with the stored receipt for the same body, 409 for another body or kind;
   * undefined for a new key. From here to the insert everything is synchronous (node:sqlite), so no
   * other request interleaves between the key lookup and the insert.
   */
  const replay = (kind: MessageKind, key: string, body: unknown): Reply | undefined => {
    const prior = store.lookup(kind, key, body);
    if (prior?.outcome === 'replayed') {
      count(kind, 'replayed');
      return { status: 200, body: prior.receipt };
    }
    if (prior?.outcome === 'conflict') {
      count(kind, 'conflict');
      throw new HttpError(
        409,
        `Idempotency-Key ${key} was used before with another ${prior.receipt.kind} body (received as number ${String(prior.receipt.receivedSeq)})`,
        ERP_PROBLEM_TYPES.idempotencyConflict,
      );
    }
    return undefined;
  };

  const postMessage =
    (
      kind: OrderMessageKind,
      schema: typeof confirmationRequestSchema | typeof statusMessageRequestSchema,
    ) =>
    async (request: IncomingMessage): Promise<Reply> => {
      const key = readKey(kind, request);
      const body: ConfirmationRequest | StatusMessageRequest = await readMessage(
        kind,
        schema,
        request,
      );
      // The key is built from the body, so one (order, operation, number) or (order, revision,
      // status) has exactly one key: a second message for it can't hide under another key.
      const confirmation = 'operation' in body ? body : undefined;
      checkKey(
        kind,
        key,
        confirmation !== undefined
          ? confirmationKey(body.orderNumber, confirmation.operation, confirmation.confirmation)
          : statusKey(body.orderNumber, body.revision, (body as StatusMessageRequest).status),
      );
      const prior = replay(kind, key, body);
      if (prior !== undefined) return prior;
      const unknown = erp.unknownReference(body);
      if (unknown !== undefined) {
        count(kind, 'unknown-order');
        throw new HttpError(422, unknown, ERP_PROBLEM_TYPES.unknownOrder);
      }
      const identity =
        confirmation === undefined
          ? undefined
          : { operation: confirmation.operation, confirmation: confirmation.confirmation };
      if (
        identity !== undefined &&
        identity.confirmation > 1 &&
        !store.hasConfirmation(body.orderNumber, { ...identity, confirmation: 1 })
      ) {
        count(kind, 'no-final');
        throw new HttpError(
          422,
          `correction ${String(identity.confirmation)} of ${body.orderNumber} ${identity.operation} has no final confirmation before it`,
          ERP_PROBLEM_TYPES.correctionWithoutFinal,
        );
      }
      let receipt;
      try {
        receipt = store.insert(kind, key, body.orderNumber, body, now(), identity);
      } catch (error) {
        if (!(error instanceof DuplicateConfirmationError)) throw error;
        count(kind, 'conflict');
        throw new HttpError(409, error.message, ERP_PROBLEM_TYPES.duplicateConfirmation);
      }
      count(kind, 'created');
      log.info(
        { key, kind, orderNumber: body.orderNumber, receivedSeq: receipt.receivedSeq },
        'message received',
      );
      return { status: 201, body: receipt };
    };

  const REFUSALS = {
    'unknown-subject': { status: 422, type: ERP_PROBLEM_TYPES.unknownSubject },
    'hold-sequence': { status: 422, type: ERP_PROBLEM_TYPES.holdSequence },
    'hold-decided': { status: 409, type: ERP_PROBLEM_TYPES.holdDecided },
  } as const;

  /** `POST /quality-notifications` (ADR-0028 amendment): the idempotency of the order messages. */
  const postNotification = async (request: IncomingMessage): Promise<Reply> => {
    const kind = 'quality-notification';
    const key = readKey(kind, request);
    const body = await readMessage(kind, qualityNotificationRequestSchema, request);
    checkKey(kind, key, qualityNotificationKey(body.holdId, body.transition, body.transitionNo));
    const prior = replay(kind, key, body);
    if (prior !== undefined) return prior;
    const refusal = erp.notificationRefusal(body);
    if (refusal !== undefined) {
      count(kind, refusal.reason);
      const { status, type } = REFUSALS[refusal.reason];
      throw new HttpError(status, refusal.detail, type);
    }
    const identity = { holdId: body.holdId, transitionNo: body.transitionNo };
    let receipt;
    try {
      receipt = store.insertNotification(key, identity, body, now());
    } catch (error) {
      if (!(error instanceof DuplicateTransitionError)) throw error;
      count(kind, 'hold-decided');
      throw new HttpError(409, error.message, ERP_PROBLEM_TYPES.holdDecided);
    }
    count(kind, 'created');
    log.info(
      {
        key,
        kind,
        holdId: body.holdId,
        transition: body.transition,
        subject: `${body.subject.kind}:${body.subject.id}`,
        receivedSeq: receipt.receivedSeq,
      },
      'message received',
    );
    return { status: 201, body: receipt };
  };

  const listMessages =
    (kind: OrderMessageKind, field: 'confirmations' | 'messages') =>
    (_request: IncomingMessage, url: URL): Promise<Reply> =>
      Promise.resolve({
        status: 200,
        body: { [field]: store.messages(kind, orderNumberParam(url)) },
      });

  const listNotifications = (_request: IncomingMessage, url: URL): Promise<Reply> => {
    const holdId = url.searchParams.get('holdId') ?? undefined;
    if (holdId !== undefined && !HOLD_ID.test(holdId)) {
      throw new HttpError(400, 'holdId is not a hold id');
    }
    return Promise.resolve({
      status: 200,
      body: { notifications: store.notifications(holdId) },
    });
  };

  const routes: Route[] = [
    {
      pattern: /^\/api\/v1\/orders$/,
      methods: {
        GET: (_request, url) => {
          const after = integerParam(url, 'after', 0, Number.MAX_SAFE_INTEGER);
          const limit = integerParam(
            url,
            'limit',
            ERP_API_LIMITS.feedPage,
            ERP_API_LIMITS.feedPageMax,
          );
          if (limit === 0) throw new HttpError(400, 'limit must be at least 1');
          const page = erp.feedPage(after, limit);
          if (page === undefined) {
            throw new HttpError(
              409,
              `after=${String(after)} is beyond this feed's last entry ${String(erp.feedLength)}: ` +
                `the cursor belongs to another feed (this one is ${erp.feedId})`,
              ERP_PROBLEM_TYPES.cursorAhead,
            );
          }
          return Promise.resolve({ status: 200, body: page });
        },
        POST: async (request) => {
          if (!options.admin) {
            throw new HttpError(
              405,
              'POST /api/v1/orders is a dev-only endpoint; it needs ERP_ADMIN=on',
              'about:blank',
              { allow: 'GET' },
            );
          }
          const input = parseBody(erpOrderInputSchema, await readJson(request));
          const added = erp.addOrder(input, now());
          if (!added.ok) {
            throw new HttpError(
              409,
              `order ${input.orderNumber} is at revision ${String(added.latest)}; post a higher one`,
              ERP_PROBLEM_TYPES.revisionConflict,
            );
          }
          log.info(
            {
              orderNumber: input.orderNumber,
              revision: input.revision,
              feedSeq: added.entry.feedSeq,
            },
            'order added (ERP_ADMIN)',
          );
          return { status: 201, body: added.entry };
        },
      },
    },
    {
      pattern: /^\/api\/v1\/orders\/([^/]+)$/,
      methods: {
        GET: (_request, _url, [orderNumber = '']) => {
          const view = ERP_ORDER_NUMBER.test(orderNumber) ? erp.view(orderNumber) : undefined;
          if (view === undefined) throw new HttpError(404, `order ${orderNumber} is unknown`);
          return Promise.resolve({ status: 200, body: view });
        },
      },
    },
    {
      pattern: /^\/api\/v1\/lots$/,
      methods: {
        GET: () => Promise.resolve({ status: 200, body: { feedId: erp.feedId, lots: erp.lots } }),
      },
    },
    {
      pattern: /^\/api\/v1\/lots\/([^/]+)$/,
      methods: {
        GET: (_request, _url, [id = '']) => {
          const view = erp.lotView(id);
          if (view === undefined) throw new HttpError(404, `lot ${id} is unknown`);
          return Promise.resolve({ status: 200, body: view });
        },
      },
    },
    {
      pattern: /^\/api\/v1\/quality-notifications$/,
      methods: { GET: listNotifications, POST: postNotification },
    },
    {
      pattern: /^\/api\/v1\/confirmations$/,
      methods: {
        GET: listMessages('confirmation', 'confirmations'),
        POST: postMessage('confirmation', confirmationRequestSchema),
      },
    },
    {
      pattern: /^\/api\/v1\/order-status$/,
      methods: {
        GET: listMessages('status', 'messages'),
        POST: postMessage('status', statusMessageRequestSchema),
      },
    },
  ];

  const metrics = (): string => {
    const counts = store.counts();
    const lines = [
      '# HELP erp_feed_entries Order versions in the change feed',
      '# TYPE erp_feed_entries gauge',
      `erp_feed_entries ${String(erp.feedLength)}`,
      '# HELP erp_messages_stored Messages from the MES held in the store, by kind',
      '# TYPE erp_messages_stored gauge',
      ...MESSAGE_KINDS.map((k) => `erp_messages_stored{kind="${k}"} ${String(counts[k])}`),
      '# HELP erp_message_posts_total Message posts since start, by kind and outcome',
      '# TYPE erp_message_posts_total counter',
      ...MESSAGE_KINDS.flatMap((k) =>
        POST_OUTCOMES.map(
          (o) =>
            `erp_message_posts_total{kind="${k}",outcome="${o}"} ${String(posts.get(`${k}|${o}`) ?? 0)}`,
        ),
      ),
      '# HELP erp_unauthorized_requests_total API requests refused for a missing or wrong token',
      '# TYPE erp_unauthorized_requests_total counter',
      `erp_unauthorized_requests_total ${String(unauthorized)}`,
    ];
    return `${lines.join('\n')}\n`;
  };

  const route = async (request: IncomingMessage, url: URL): Promise<Reply | string> => {
    const method = request.method ?? 'GET';
    const path = url.pathname;
    if (path === '/health/live' || path === '/health/ready' || path === '/metrics') {
      if (method !== 'GET') {
        throw new HttpError(405, `${method} is not allowed here`, 'about:blank', { allow: 'GET' });
      }
      return path === '/metrics' ? metrics() : { status: 200, body: { status: 'ok' } };
    }
    if (!path.startsWith('/api/v1/')) throw new HttpError(404, `${path} is not a route`);
    if (!authorized(request)) {
      unauthorized++;
      throw new HttpError(401, 'a valid bearer token is required', 'about:blank', {
        'www-authenticate': 'Bearer realm="erp-mock"',
      });
    }
    for (const { pattern, methods } of routes) {
      const match = pattern.exec(path);
      if (match === null) continue;
      const handler = methods[method];
      if (handler === undefined) {
        throw new HttpError(405, `${method} is not allowed on ${path}`, 'about:blank', {
          allow: Object.keys(methods).join(', '),
        });
      }
      return handler(request, url, match.slice(1).map(decodeSegment));
    }
    throw new HttpError(404, `${path} is not a route`);
  };

  const send = (
    response: ServerResponse,
    status: number,
    type: string,
    text: string,
    headers: Readonly<Record<string, string>> = {},
  ) => {
    response.writeHead(status, {
      'content-type': type,
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      ...headers,
    });
    response.end(text);
  };

  const server = createServer((request, response) => {
    const started = performance.now();
    const url = new URL(request.url ?? '/', 'http://erp-mock');
    response.on('finish', () => {
      const fields = {
        method: request.method,
        path: url.pathname,
        status: response.statusCode,
        ms: Math.round(performance.now() - started),
      };
      if (url.pathname.startsWith('/api/')) log.info(fields, 'request');
      else log.debug(fields, 'request');
    });
    route(request, url).then(
      (reply) => {
        if (typeof reply === 'string') {
          send(response, 200, 'text/plain; version=0.0.4; charset=utf-8', reply);
        } else {
          send(
            response,
            reply.status,
            'application/json; charset=utf-8',
            JSON.stringify(reply.body),
          );
        }
      },
      (error: unknown) => {
        const known = error instanceof HttpError;
        if (!known) log.error({ err: error, path: url.pathname }, 'request failed');
        const status = known ? error.status : 500;
        const problem = {
          type: known ? error.type : 'about:blank',
          title: STATUS_CODES[status] ?? 'Error',
          status,
          detail: known ? error.detail : 'internal error',
          instance: url.pathname,
        };
        send(
          response,
          status,
          'application/problem+json; charset=utf-8',
          JSON.stringify(problem),
          known ? error.headers : {},
        );
        // A body refused part-way is not read to its end; the connection closes after the answer.
        if (known && error.headers.connection === 'close') {
          response.on('finish', () => request.destroy());
        }
      },
    );
  });
  return Object.assign(server, {
    apiRoutes: routes.map((r) => ({ pattern: r.pattern, methods: Object.keys(r.methods) })),
  });
}
