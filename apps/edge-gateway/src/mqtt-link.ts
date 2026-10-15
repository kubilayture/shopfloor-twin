import { isSysRetained, sysTopic, type Status } from '@shopfloor/contracts';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import type { TopicSequences } from './identity.ts';
import type { Publisher, UnsPublication } from './publisher.ts';

export interface MqttLinkOptions {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly gatewayId: string;
  readonly version: string;
  readonly sequences: TopicSequences;
  readonly startedAt: number;
  readonly now?: () => number;
  readonly reconnectPeriodMs?: number;
  /** Connection errors (refused, DNS, …). MQTT.js keeps reconnecting by itself. */
  readonly onError?: (error: Error) => void;
}

/** Thrown by `publish` while the broker is unreachable: the caller keeps the message (#78). */
export class NotConnectedError extends Error {
  constructor() {
    super('not connected to the broker');
    this.name = 'NotConnectedError';
  }
}

/**
 * The gateway's MQTT session: QoS 1 publishing, plus its own `_sys` status. The status goes
 * straight to the broker (never through the store-and-forward buffer), with the last will
 * "offline" refreshed before every (re)connect so it carries a fresh sequence number.
 */
export class MqttLink implements Publisher {
  readonly statusTopic: string;
  readonly #options: MqttLinkOptions;
  readonly #now: () => number;
  readonly #client: MqttClient;
  #published = 0;
  #started = false;

  constructor(options: MqttLinkOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.statusTopic = sysTopic('edge-gateway', options.gatewayId, 'status');
    const clientOptions: IClientOptions = {
      clientId: options.gatewayId,
      username: options.username,
      password: options.password,
      protocolVersion: 5,
      clean: true,
      reconnectPeriod: options.reconnectPeriodMs ?? 1_000,
      connectTimeout: 5_000,
      manualConnect: true,
      will: this.#will(),
    };
    this.#client = mqtt.connect(options.url, clientOptions);
    this.#client.on('reconnect', () => {
      this.#client.options.will = this.#will();
    });
    this.#client.on('connect', () => {
      this.#publishStatus('online').catch(() => undefined);
    });
    const onError = options.onError ?? (() => undefined);
    this.#client.on('error', (error) => {
      onError(error);
    });
  }

  get connected(): boolean {
    return this.#client.connected;
  }

  /** Messages acknowledged by the broker (PUBACK). */
  get published(): number {
    return this.#published;
  }

  get client(): MqttClient {
    return this.#client;
  }

  start(): void {
    this.#started = true;
    this.#client.connect();
  }

  /**
   * Resolves on PUBACK; rejects if the broker refuses (for example the ACL: reason 0x87), and at
   * once with `NotConnectedError` while disconnected. MQTT.js would otherwise keep the message in
   * memory until a reconnect: unbounded, lost on a crash, and duplicated by the disk buffer (#78).
   */
  async publish({ topic, message, retain }: UnsPublication): Promise<void> {
    if (!this.#client.connected) {
      throw new NotConnectedError();
    }
    await this.#client.publishAsync(topic, JSON.stringify(message), { qos: 1, retain });
    this.#published++;
  }

  /** A clean disconnect doesn't trigger the will, so "offline" is published explicitly first. */
  async close(): Promise<void> {
    if (!this.#started) {
      return;
    }
    if (!this.#client.connected) {
      // Nothing can be acknowledged now; a graceful end would wait for in-flight packets forever.
      await this.#client.endAsync(true);
      return;
    }
    await this.#publishStatus('offline').catch(() => undefined);
    await this.#client.endAsync();
  }

  #status(status: 'online' | 'offline'): Status {
    const now = new Date(this.#now()).toISOString();
    return {
      schema: 'uns.sys.status/1',
      scope: 'topic',
      epoch: this.#options.sequences.epoch,
      seq: this.#options.sequences.next(this.statusTopic),
      sourceTime: now,
      receivedAt: now,
      quality: 'good',
      source: { id: this.#options.gatewayId, protocol: 'internal' },
      value: {
        status,
        startedAt: new Date(this.#options.startedAt).toISOString(),
        version: this.#options.version,
      },
    };
  }

  #will(): NonNullable<IClientOptions['will']> {
    return {
      topic: this.statusTopic,
      payload: Buffer.from(JSON.stringify(this.#status('offline'))),
      qos: 1,
      retain: isSysRetained('status'),
    };
  }

  async #publishStatus(status: 'online' | 'offline'): Promise<void> {
    await this.#client.publishAsync(this.statusTopic, JSON.stringify(this.#status(status)), {
      qos: 1,
      retain: isSysRetained('status'),
    });
  }
}
