import { WS_CLOSE_FORBIDDEN, WS_CLOSE_UNAUTHENTICATED } from '@shopfloor/contracts/identity';
import {
  serverMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from '@shopfloor/contracts/mes-api';

export type LiveStatus = 'connecting' | 'open' | 'reconnecting' | 'stopped';

/** The part of the browser's WebSocket the client uses. */
export interface LiveSocket {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const OPEN = 1;

export interface LiveClientOptions {
  readonly url: string;
  readonly createSocket?: (url: string) => LiveSocket;
  /** First reconnect delay; it doubles per failed attempt up to `maxDelayMs`. */
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  /** 0 to 1, for the jitter that spreads reconnects of many tabs. */
  readonly random?: () => number;
  /** Client messages the client sends per second, below the MES's 10 (bursts of 20). */
  readonly messagesPerSecond?: number;
  readonly burst?: number;
}

interface Subscription {
  readonly topic: string;
  readonly metric: string | undefined;
  refs: number;
  confirmed: boolean;
  /** A subscribe went out on the current connection, so the MES may hold it. */
  sent: boolean;
}

/**
 * Close codes after which the client stops instead of reconnecting (ADR-0026): 4401, no or an ended
 * session; 4403, a session that may not read (it must change its password first). Reconnecting
 * would only be closed again; the app logs in and calls `start()`.
 */
const AUTH_CLOSES: ReadonlySet<number> = new Set([WS_CLOSE_UNAUTHENTICATED, WS_CLOSE_FORBIDDEN]);

/** Errors after which the unconfirmed subscriptions are asked for again (ADR-0019 limits). */
const RETRIED = new Set(['busy', 'rate-limited', 'unavailable']);

const keyOf = (topic: string, metric: string | null | undefined): string =>
  `${topic}|${metric ?? ''}`;

/** The browser's WebSocket URL of a path on the page's own origin (the proxy forwards it). */
export function sameOriginWsUrl(path: string, location: Location = window.location): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${path}`;
}

/**
 * One WebSocket to the MES per tab (docs/api/realtime.md): subscriptions are counted by their
 * users, sent again after every reconnect (which brings fresh snapshots), and paced below the
 * MES's rate limit. A lost connection is retried with exponential backoff and jitter; `busy`,
 * `rate-limited` and `unavailable` answers retry the subscriptions not yet confirmed.
 */
export class LiveClient {
  readonly #options: Required<Omit<LiveClientOptions, 'createSocket'>> & {
    createSocket: (url: string) => LiveSocket;
  };
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #messageListeners = new Set<(message: ServerMessage) => void>();
  readonly #statusListeners = new Set<() => void>();
  readonly #authListeners = new Set<(code: number) => void>();
  #socket: LiveSocket | undefined;
  #status: LiveStatus = 'stopped';
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryDelayMs = 0;
  #outbox: ClientMessage[] = [];
  #tokens: number;
  #tokensAt = 0;
  #drainTimer: ReturnType<typeof setTimeout> | undefined;
  #lastError: ServerMessage | undefined;
  #connection: { readonly status: LiveStatus; readonly attempt: number } = {
    status: 'stopped',
    attempt: 0,
  };

  constructor(options: LiveClientOptions) {
    this.#options = {
      createSocket: (url) => new WebSocket(url),
      initialDelayMs: 500,
      maxDelayMs: 15_000,
      random: Math.random,
      messagesPerSecond: 5,
      burst: 8,
      ...options,
    };
    this.#tokens = this.#options.burst;
  }

  get status(): LiveStatus {
    return this.#status;
  }

  /** Status and attempt as one value that changes identity only when either changes. */
  get connection(): { readonly status: LiveStatus; readonly attempt: number } {
    return this.#connection;
  }

  /** Failed connection attempts since the last open connection. */
  get attempt(): number {
    return this.#attempt;
  }

  /** The last `error` message from the MES that was not retried. */
  get lastError(): ServerMessage | undefined {
    return this.#lastError;
  }

  start(): void {
    if (this.#status !== 'stopped') return;
    this.#connect('connecting');
  }

  stop(): void {
    this.#setStatus('stopped');
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#clearSending();
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close(1000, 'stopped');
    }
  }

  /** Subscribes to a topic (and metric); returns the unsubscribe. Repeats share one subscription. */
  subscribe(topic: string, metric?: string): () => void {
    const key = keyOf(topic, metric);
    const existing = this.#subscriptions.get(key);
    if (existing) existing.refs += 1;
    else {
      this.#subscriptions.set(key, { topic, metric, refs: 1, confirmed: false, sent: false });
      if (this.#isOpen()) this.#enqueue(subscribeMessage(topic, metric));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#release(key);
    };
  }

  onMessage(listener: (message: ServerMessage) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onStatus(listener: () => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /**
   * Called with 4401 or 4403 when the MES closed the socket for its session (ADR-0026). The client
   * has stopped then: subscriptions are kept and sent again after the next `start()`.
   */
  onAuthClose(listener: (code: number) => void): () => void {
    this.#authListeners.add(listener);
    return () => this.#authListeners.delete(listener);
  }

  #release(key: string): void {
    const subscription = this.#subscriptions.get(key);
    if (!subscription) return;
    subscription.refs -= 1;
    if (subscription.refs > 0) return;
    this.#subscriptions.delete(key);
    this.#outbox = this.#outbox.filter(
      (message) => !(message.type === 'subscribe' && keyOf(message.topic, message.metric) === key),
    );
    // Only a subscribe that went out needs undoing; one still waiting never reached the MES. A
    // retry may have queued it again after it was sent, so the outbox alone can't tell.
    if (this.#isOpen() && subscription.sent) {
      this.#enqueue({
        type: 'unsubscribe',
        topic: subscription.topic,
        ...(subscription.metric === undefined ? {} : { metric: subscription.metric }),
      });
    }
  }

  #isOpen(): boolean {
    return this.#status === 'open' && this.#socket?.readyState === OPEN;
  }

  #setStatus(status: LiveStatus): void {
    this.#status = status;
    const { connection } = this;
    if (connection.status === status && connection.attempt === this.#attempt) return;
    this.#connection = { status, attempt: this.#attempt };
    for (const listener of this.#statusListeners) listener();
  }

  #connect(status: 'connecting' | 'reconnecting'): void {
    this.#setStatus(status);
    let socket: LiveSocket;
    try {
      socket = this.#options.createSocket(this.#options.url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      this.#attempt = 0;
      this.#retryDelayMs = 0;
      this.#outbox = [];
      this.#setStatus('open');
      for (const subscription of this.#subscriptions.values()) {
        subscription.confirmed = false;
        subscription.sent = false;
        this.#enqueue(subscribeMessage(subscription.topic, subscription.metric));
      }
    };
    socket.onmessage = (event) => {
      this.#receive(event.data);
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      for (const subscription of this.#subscriptions.values()) {
        subscription.confirmed = false;
        subscription.sent = false;
      }
      this.#clearSending();
      if (AUTH_CLOSES.has(event.code)) {
        this.#attempt = 0;
        this.#setStatus('stopped');
        for (const listener of this.#authListeners) listener(event.code);
        return;
      }
      this.#scheduleReconnect();
    };
  }

  #clearSending(): void {
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#drainTimer);
    this.#retryTimer = undefined;
    this.#drainTimer = undefined;
    this.#outbox = [];
  }

  #scheduleReconnect(): void {
    if (this.#status === 'stopped') return;
    const { initialDelayMs, maxDelayMs, random } = this.#options;
    const base = Math.min(maxDelayMs, initialDelayMs * 2 ** this.#attempt);
    const delay = Math.round(base * (0.75 + 0.5 * random()));
    this.#attempt += 1;
    this.#setStatus('reconnecting');
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect('reconnecting');
    }, delay);
  }

  #receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = serverMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'subscribed') {
      const subscription = this.#subscriptions.get(keyOf(message.topic, message.metric));
      if (subscription) subscription.confirmed = true;
      // The MES accepts subscriptions again: the next refusal starts its backoff anew.
      this.#retryDelayMs = 0;
    } else if (message.type === 'error') {
      if (RETRIED.has(message.code)) this.#scheduleRetry();
      else this.#lastError = message;
    }
    for (const listener of this.#messageListeners) listener(message);
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== undefined) return;
    this.#retryDelayMs = Math.min(this.#options.maxDelayMs, Math.max(1000, this.#retryDelayMs * 2));
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (!this.#isOpen()) return;
      const queued = new Set(
        this.#outbox.map((message) => keyOf(message.topic, message.metric) + message.type),
      );
      for (const [key, subscription] of this.#subscriptions) {
        if (!subscription.confirmed && !queued.has(`${key}subscribe`)) {
          this.#enqueue(subscribeMessage(subscription.topic, subscription.metric));
        }
      }
    }, this.#retryDelayMs);
  }

  #enqueue(message: ClientMessage): void {
    this.#outbox.push(message);
    this.#drain();
  }

  #drain(): void {
    if (this.#drainTimer !== undefined) return;
    const { messagesPerSecond, burst } = this.#options;
    const now = Date.now();
    this.#tokens = Math.min(
      burst,
      this.#tokens + ((now - this.#tokensAt) / 1000) * messagesPerSecond,
    );
    this.#tokensAt = now;
    while (this.#outbox.length > 0 && this.#tokens >= 1 && this.#isOpen()) {
      const message = this.#outbox.shift();
      if (message === undefined) break;
      this.#tokens -= 1;
      this.#socket?.send(JSON.stringify(message));
      if (message.type === 'subscribe') {
        const subscription = this.#subscriptions.get(keyOf(message.topic, message.metric));
        if (subscription) subscription.sent = true;
      }
    }
    if (this.#outbox.length > 0 && this.#isOpen()) {
      const wait = Math.ceil(((1 - this.#tokens) / messagesPerSecond) * 1000);
      this.#drainTimer = setTimeout(() => {
        this.#drainTimer = undefined;
        this.#drain();
      }, wait);
    }
  }
}

function subscribeMessage(topic: string, metric: string | undefined): ClientMessage {
  return { type: 'subscribe', topic, ...(metric === undefined ? {} : { metric }) };
}
