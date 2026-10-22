import { UNS_ROOT, parseEquipmentTopic } from '@shopfloor/contracts';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import type { CommandStore, InboxEntry } from './store.ts';

export interface CommandLinkOptions {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  /** `{gatewayId}-cmd`: never the publishing connection's client id (plan, M2). */
  readonly clientId: string;
  /** The plant's areas: one subscription `orbis/gebze/{area}/+/+/cmd/#` each, as the ACL lists them. */
  readonly areas: readonly string[];
  /** MQTT 5 session expiry (`GATEWAY_CMD_SESSION_EXPIRY_S`), longer than any command's life. */
  readonly sessionExpirySeconds: number;
  /** Where deliveries are committed (the gateway's `CommandStore`). */
  readonly store: Pick<CommandStore, 'record'>;
  /** A delivery recorded in the store; its PUBACK follows. */
  readonly onCommand: (entry: InboxEntry) => void;
  /** Pause before reconnecting after a delivery could not be recorded. */
  readonly retryMs?: number;
  readonly reconnectPeriodMs?: number;
  readonly onError?: (error: unknown) => void;
  /** A delivery on a topic that is not an equipment's `cmd/…`: acknowledged and dropped. */
  readonly onIgnored?: (topic: string) => void;
}

/** The subscriptions of the command session, one per area (`+` in the area level could match `_sys`). */
export const commandSubscriptions = (areas: readonly string[]): string[] =>
  areas.map((area) => `${UNS_ROOT}/${area}/+/+/cmd/#`);

/**
 * The gateway's command session (#173, ADR-0029, plan M2): a second MQTT connection, client id
 * `gw-01-cmd`, so it never takes over the publishing connection's session. Since UNS 1.5 (#240,
 * ADR-0039) it logs in as its own broker user `gw-01-cmd` (`MQTT_CMD_USERNAME`), bound to that
 * client id. It is persistent (`clean: false` with a session expiry), so the broker queues commands
 * while the gateway is away, and a delivery is acknowledged only after it is committed to the
 * gateway's SQLite inbox: MQTT.js sends the PUBACK when `handleMessage`'s callback runs. A
 * delivery that can't be recorded is never acknowledged: the session is dropped and resumed after
 * a pause, and the broker delivers it again.
 */
export class CommandLink {
  readonly #options: CommandLinkOptions;
  #client: MqttClient | undefined;
  #subscribed = false;
  #received = 0;
  #stopping = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: CommandLinkOptions) {
    this.#options = options;
  }

  /** True while connected with every subscription granted. */
  get subscribed(): boolean {
    return this.#subscribed && this.#client?.connected === true;
  }

  /** Command deliveries recorded since start (redeliveries included). */
  get received(): number {
    return this.#received;
  }

  start(): void {
    this.#connect();
  }

  async close(): Promise<void> {
    this.#stopping = true;
    clearTimeout(this.#retryTimer);
    this.#subscribed = false;
    // No DISCONNECT with a session expiry of 0: the session (and anything unacknowledged) stays.
    await this.#client?.endAsync(true);
  }

  #connect(): void {
    if (this.#stopping) return;
    const options: IClientOptions = {
      clientId: this.#options.clientId,
      username: this.#options.username,
      password: this.#options.password,
      protocolVersion: 5,
      clean: false,
      properties: {
        sessionExpiryInterval: this.#options.sessionExpirySeconds,
        // Unacknowledged command deliveries in flight at once.
        receiveMaximum: 10,
      },
      // Subscriptions are renewed on every connect below, so the grant can be checked.
      resubscribe: false,
      reconnectPeriod: this.#options.reconnectPeriodMs ?? 1_000,
      connectTimeout: 5_000,
      manualConnect: true,
    };
    const client = mqtt.connect(this.#options.url, options);
    this.#client = client;
    client.handleMessage = (packet, callback) => {
      if (this.#client !== client || this.#stopping) return; // never acknowledged
      let entry: InboxEntry | undefined;
      const payload =
        typeof packet.payload === 'string' ? packet.payload : packet.payload.toString('utf8');
      const parsed = parseEquipmentTopic(packet.topic);
      if (parsed?.topicClass !== 'cmd') {
        this.#options.onIgnored?.(packet.topic);
        callback();
        return;
      }
      try {
        entry = this.#options.store.record(parsed.equipment, packet.topic, payload);
      } catch (error) {
        this.#options.onError?.(error);
        this.#suspend(client);
        return;
      }
      this.#received++;
      callback();
      this.#options.onCommand(entry);
    };
    client.on('connect', () => {
      this.#subscribe(client).catch((error: unknown) => {
        this.#options.onError?.(error);
      });
    });
    client.on('close', () => {
      if (this.#client === client) this.#subscribed = false;
    });
    client.on('error', (error) => {
      this.#options.onError?.(error);
    });
    client.connect();
  }

  async #subscribe(client: MqttClient): Promise<void> {
    const topics = commandSubscriptions(this.#options.areas);
    const grants = await client.subscribeAsync(
      Object.fromEntries(topics.map((topic) => [topic, { qos: 1 as const }])),
    );
    const refused = grants.filter((grant) => grant.qos !== 1);
    if (refused.length > 0) {
      throw new Error(`command subscriptions refused: ${refused.map((g) => g.topic).join(', ')}`);
    }
    if (this.#client === client) this.#subscribed = true;
  }

  /** Drops the session without acknowledging, and resumes it after a pause. */
  #suspend(client: MqttClient): void {
    if (this.#client !== client) return;
    this.#client = undefined;
    this.#subscribed = false;
    void client.endAsync(true).finally(() => {
      this.#retryTimer = setTimeout(() => {
        this.#connect();
      }, this.#options.retryMs ?? 1_000);
    });
  }
}
