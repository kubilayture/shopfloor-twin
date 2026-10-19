import mqtt, { type MqttClient } from 'mqtt';

/**
 * Where the command outbox publishes (#174): the UNS through the MES's own MQTT connection, or a
 * recording sink in tests. `publish` resolves once the broker acknowledged (QoS 1).
 */
export interface CommandPublisher {
  /** Connected now: the outbox doesn't publish otherwise (a delivery would wait in MQTT.js). */
  readonly connected: boolean;
  publish(topic: string, payload: string): Promise<void>;
}

export interface MqttPublisherOptions {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  /** `{MQTT_CLIENT_ID}-cmd`: never the ingest session's client id (no takeover). */
  readonly clientId: string;
  readonly reconnectPeriodMs?: number;
  readonly log?: { warn(object: object, message: string): void };
}

/**
 * The MES's command connection (#174): a second MQTT 5 connection, as the broker user `mes-cmd`
 * (`MQTT_CMD_USERNAME`; the `mes` role, which may write `…/cmd/#`, ADR-0029), with its own client id
 * `mes-server-cmd` (bound to that user, ADR-0039) so it never takes over ingest's persistent
 * session. Clean: the transactional outbox, not the broker, keeps what must be sent.
 */
export class MqttCommandPublisher implements CommandPublisher {
  readonly #client: MqttClient;

  constructor(options: MqttPublisherOptions) {
    this.#client = mqtt.connect(options.url, {
      clientId: options.clientId,
      username: options.username,
      password: options.password,
      protocolVersion: 5,
      clean: true,
      reconnectPeriod: options.reconnectPeriodMs ?? 1_000,
      connectTimeout: 5_000,
      // A publish while disconnected is refused, not queued: the outbox retries it.
      queueQoSZero: false,
    });
    this.#client.on('error', (error) => {
      options.log?.warn({ err: error.message }, 'MQTT error (command connection)');
    });
  }

  get connected(): boolean {
    return this.#client.connected;
  }

  async publish(topic: string, payload: string): Promise<void> {
    if (!this.#client.connected) throw new Error('command connection not connected');
    await this.#client.publishAsync(topic, payload, { qos: 1, retain: false });
  }

  async close(): Promise<void> {
    await this.#client.endAsync(true);
  }
}
