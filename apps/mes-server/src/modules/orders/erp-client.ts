import {
  ERP_PROBLEM_TYPES,
  messageReceiptSchema,
  orderFeedSchema,
  type MessageReceipt,
  type OrderFeed,
} from '@shopfloor/contracts/erp-api';

/**
 * What the orders module asks of the ERP (ADR-0028, `@shopfloor/contracts/erp-api`): a page of the
 * order change feed, and message posts with their `Idempotency-Key`. `ErpClient` is the real one
 * (REST with the shared bearer token); tests pass a fake.
 */
export interface ErpApi {
  /** A feed page after `after`; `cursor-ahead` when the ERP answered 409 erp-cursor-ahead. */
  feed(after: number, limit: number): Promise<FeedPage>;
  /** Posts a message; the outcome tells the outbox whether to retry. */
  post(kind: 'status' | 'confirmation', key: string, body: unknown): Promise<PostOutcome>;
}

export type FeedPage =
  | { readonly kind: 'page'; readonly page: OrderFeed }
  | { readonly kind: 'cursor-ahead'; readonly detail: string };

export type PostOutcome =
  /** 201 the first time, 200 with the stored receipt on a replay. */
  | { readonly kind: 'stored'; readonly status: number; readonly receipt: MessageReceipt }
  /** 409: the key was used with another body. Never retried (a defect: an incident). */
  | { readonly kind: 'conflict'; readonly status: number; readonly detail: string }
  /** Another 4xx but 401/403/408/429: refused for good. Never retried (an incident). */
  | { readonly kind: 'refused'; readonly status: number; readonly detail: string }
  /** Network, 5xx, 401/403 (configuration), 408, 429: retried with backoff. */
  | { readonly kind: 'retry'; readonly detail: string };

export interface ErpClientOptions {
  /** The ERP's base URL, e.g. `http://erp:4600`. */
  readonly url: string;
  readonly token: string;
  /** Per request (default 10 s). */
  readonly timeoutMs?: number;
}

const RETRIED = new Set([401, 403, 408, 429]);

async function problemOf(response: Response): Promise<{ type: string; detail: string }> {
  const text = await response.text().catch(() => '');
  try {
    const json = JSON.parse(text) as { type?: unknown; detail?: unknown };
    return {
      type: typeof json.type === 'string' ? json.type : 'about:blank',
      detail: typeof json.detail === 'string' ? json.detail : text.slice(0, 500),
    };
  } catch {
    return { type: 'about:blank', detail: text.slice(0, 500) };
  }
}

/** The ERP mock's REST API over `fetch`. The token never reaches a log or an error message. */
export class ErpClient implements ErpApi {
  readonly #url: string;
  readonly #token: string;
  readonly #timeoutMs: number;

  constructor(options: ErpClientOptions) {
    this.#url = options.url.replace(/\/+$/, '');
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async feed(after: number, limit: number): Promise<FeedPage> {
    const response = await fetch(
      `${this.#url}/api/v1/orders?after=${String(after)}&limit=${String(limit)}`,
      {
        headers: { authorization: `Bearer ${this.#token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.#timeoutMs),
      },
    );
    if (response.status === 409) {
      const problem = await problemOf(response);
      if (problem.type === ERP_PROBLEM_TYPES.cursorAhead) {
        return { kind: 'cursor-ahead', detail: problem.detail };
      }
      throw new Error(`ERP feed: 409 ${problem.detail}`);
    }
    if (!response.ok) {
      const problem = await problemOf(response);
      throw new Error(`ERP feed: ${String(response.status)} ${problem.detail}`);
    }
    const parsed = orderFeedSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error(`ERP feed: invalid page (${parsed.error.message})`);
    return { kind: 'page', page: parsed.data };
  }

  async post(
    kind: 'status' | 'confirmation',
    key: string,
    /** A `StatusMessageRequest` or a `ConfirmationRequest`, as stored in the outbox. */
    body: unknown,
  ): Promise<PostOutcome> {
    let response: Response;
    try {
      response = await fetch(
        `${this.#url}/api/v1/${kind === 'status' ? 'order-status' : 'confirmations'}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.#token}`,
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch (error) {
      return { kind: 'retry', detail: error instanceof Error ? error.message : String(error) };
    }
    if (response.status === 200 || response.status === 201) {
      const receipt = messageReceiptSchema.safeParse(await response.json().catch(() => null));
      if (!receipt.success) return { kind: 'retry', detail: 'invalid receipt' };
      return { kind: 'stored', status: response.status, receipt: receipt.data };
    }
    const problem = await problemOf(response);
    const detail = `${String(response.status)} ${problem.type}: ${problem.detail}`;
    if (response.status === 409) return { kind: 'conflict', status: 409, detail };
    if (response.status >= 400 && response.status < 500 && !RETRIED.has(response.status)) {
      return { kind: 'refused', status: response.status, detail };
    }
    return { kind: 'retry', detail };
  }
}
