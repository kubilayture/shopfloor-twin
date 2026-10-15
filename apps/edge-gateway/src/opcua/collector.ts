import {
  Deduplicator,
  OPCUA_EVENT_FIELDS,
  OPCUA_EVENT_TYPES,
  OPCUA_VARIABLES,
  SHOPFLOOR_NAMESPACE_URI,
  UNS_TELEMETRY,
  alarmTopic,
  cycleTopic,
  opcuaEndpoint,
  opcuaEventTypeId,
  opcuaNodeId,
  stateTopic,
  telemetryTopic,
  toIndexedNodeId,
  type Alarm,
  type CycleComplete,
  type EquipmentPath,
  type MachineState,
  type StateCurrent,
  type Telemetry,
} from '@shopfloor/contracts';
import {
  AttributeIds,
  OPCUAClient,
  StatusCodes,
  TimestampsToReturn,
  constructEventFilter,
  resolveNodeId,
  type ClientSession,
  type OPCUACertificateManager,
  type ClientSubscription,
  type DataValue,
  type NodeId,
  type Variant,
} from 'node-opcua';
import type { TopicSequences } from '../identity.ts';
import type { IncidentReporter } from '../incidents.ts';
import type { Publisher, UnsPublication } from '../publisher.ts';

export interface OpcuaMachine {
  readonly id: string;
  readonly port: number;
  readonly kind: 'machine-tool' | 'station';
}

export interface OpcuaCollectorOptions {
  readonly machine: OpcuaMachine;
  readonly path: EquipmentPath;
  readonly host: string;
  readonly portOffset?: number;
  readonly publisher: Publisher;
  readonly sequences: TopicSequences;
  readonly incidents: IncidentReporter;
  readonly now?: () => number;
  /** How often telemetry is sampled, wall ms (plan section 5: telemetry may be decimated). */
  readonly telemetrySamplingMs?: number;
  /** After a reconnect, how long events from the repaired subscription may still trickle in. */
  readonly resyncGraceMs?: number;
  readonly onError?: (error: unknown) => void;
  /**
   * The gateway's own client certificate store, shared by all its collectors. Without it node-opcua
   * uses a store in the user's home folder, which a killed process can leave locked.
   */
  readonly certificateManager?: OPCUACertificateManager;
}

/** Event fields, in select-clause order. */
const FIELDS = [
  ...OPCUA_EVENT_FIELDS.common,
  ...OPCUA_EVENT_FIELDS.stateChange,
  ...OPCUA_EVENT_FIELDS.cycleComplete,
  ...OPCUA_EVENT_FIELDS.alarm,
] as const;
const STANDARD_FIELDS = ['EventType', 'Time', 'Severity'] as const;

type Field = (typeof FIELDS)[number] | (typeof STANDARD_FIELDS)[number];

const TELEMETRY = {
  'spindle-load': { variable: OPCUA_VARIABLES.spindleLoad, kinds: ['machine-tool'] },
  'coolant-temperature': { variable: OPCUA_VARIABLES.coolantTemperature, kinds: ['machine-tool'] },
  'leak-rate': { variable: OPCUA_VARIABLES.leakRate, kinds: [] },
} as const;

const quality = (statusCode: DataValue['statusCode']): Telemetry['quality'] =>
  statusCode.isGood() ? 'good' : statusCode.isGoodish() ? 'uncertain' : 'bad';

/**
 * One OPC UA machine → UNS (ADR-0009, ADR-0015). Device facts (state changes, cycles, alarm
 * transitions) come as events with the machine's `Sequence`; after every (re)connect the collector
 * reads `Epoch`, `Sequence` and the current state, publishes a snapshot, and reports any facts that
 * never arrived as a sequence-gap incident.
 */
export class OpcuaCollector {
  readonly machineId: string;
  readonly endpoint: string;
  readonly #options: OpcuaCollectorOptions;
  readonly #now: () => number;
  readonly #client: OPCUAClient;
  #session: ClientSession | undefined;
  #subscription: ClientSubscription | undefined;
  #eventTypes = new Map<string, keyof typeof OPCUA_EVENT_TYPES>();
  #namespaces: string[] = [];
  #epoch: number | undefined;
  #dedup = new Deduplicator();
  /** Highest device sequence handled in the current epoch. */
  #highest = 0;
  #upperLimit = Number.NaN;
  #resync: Promise<void> | undefined;
  #facts = 0;
  #closed = false;

  constructor(options: OpcuaCollectorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.machineId = options.machine.id;
    this.endpoint = opcuaEndpoint(options.host, options.machine.port + (options.portOffset ?? 0));
    this.#client = OPCUAClient.create({
      // One name for every machine's client: they share one client certificate, whose subject
      // alternative name must match the application URI derived from it.
      applicationName: 'shopfloor-twin-edge-gateway',
      endpointMustExist: false,
      keepSessionAlive: true,
      requestedSessionTimeout: 60_000,
      connectionStrategy: { maxRetry: 1_000_000, initialDelay: 250, maxDelay: 2_000 },
      ...(options.certificateManager
        ? { clientCertificateManager: options.certificateManager }
        : {}),
    });
    this.#client.on('connection_lost', () => {
      this.#options.incidents.report({
        type: 'disconnected',
        equipment: this.machineId,
        lost: null,
        message: `${this.machineId}: OPC UA connection to ${this.endpoint} lost; reconnecting`,
      });
    });
    this.#client.on('connection_reestablished', () => {
      this.#options.incidents.report({
        type: 'reconnected',
        equipment: this.machineId,
        lost: null,
        message: `${this.machineId}: OPC UA connection re-established`,
      });
    });
  }

  #baselineSequence = 0;

  /** The machine's `Sequence` when this collector subscribed: facts up to it are history. */
  get baseline(): number {
    return this.#baselineSequence;
  }

  /** Device facts published since start. */
  get facts(): number {
    return this.#facts;
  }

  get connected(): boolean {
    return this.#session !== undefined && !this.#closed && !this.#client.isReconnecting;
  }

  async start(): Promise<void> {
    await this.#client.connect(this.endpoint);
    const session = await this.#client.createSession();
    this.#session = session;
    session.on('session_restored', () => {
      this.#scheduleResync(true);
    });
    this.#namespaces = await session.readNamespaceArray();
    for (const [kind, name] of Object.entries(OPCUA_EVENT_TYPES) as [
      keyof typeof OPCUA_EVENT_TYPES,
      string,
    ][]) {
      this.#eventTypes.set(this.#nodeId(opcuaEventTypeId(name)).toString(), kind);
    }
    await this.#baseline(session);
    await this.#subscribe(session);
    await this.#resyncNow(false);
  }

  /**
   * Epoch and Sequence before subscribing: later events are new, earlier ones are history. The
   * baseline number counts as seen, so a fact raised before the subscription became active shows up
   * as a hole after it, not as silence.
   */
  async #baseline(session: ClientSession): Promise<void> {
    const [epoch, sequence] = await Promise.all(
      [OPCUA_VARIABLES.epoch, OPCUA_VARIABLES.sequence].map((path) =>
        session.read({
          nodeId: this.#nodeId(opcuaNodeId(this.machineId, path)),
          attributeId: AttributeIds.Value,
        }),
      ),
    );
    this.#epoch = Number(epoch?.value.value);
    this.#highest = Number(sequence?.value.value);
    this.#baselineSequence = this.#highest;
    if (this.#highest > 0) {
      this.#dedup.accept('device', {
        scope: 'device',
        epoch: this.#epoch,
        seq: this.#highest,
        source: { id: this.machineId },
      });
    }
  }

  async stop(): Promise<void> {
    this.#closed = true;
    await this.#subscription?.terminate().catch(() => undefined);
    await this.#session?.close().catch(() => undefined);
    await this.#client.disconnect();
  }

  #nodeId(expanded: string): NodeId {
    return resolveNodeId(toIndexedNodeId(expanded, this.#namespaces));
  }

  async #subscribe(session: ClientSession): Promise<void> {
    const subscription = await session.createSubscription2({
      requestedPublishingInterval: 100,
      requestedMaxKeepAliveCount: 20,
      requestedLifetimeCount: 600,
      maxNotificationsPerPublish: 0,
      publishingEnabled: true,
      priority: 1,
    });
    this.#subscription = subscription;
    const ns = String(this.#namespaces.indexOf(SHOPFLOOR_NAMESPACE_URI));
    const filter = constructEventFilter([...FIELDS.map((f) => `${ns}:${f}`), ...STANDARD_FIELDS]);
    const events = await subscription.monitor(
      { nodeId: resolveNodeId('i=2253'), attributeId: AttributeIds.EventNotifier },
      { samplingInterval: 0, queueSize: 5_000, discardOldest: false, filter },
      TimestampsToReturn.Both,
    );
    events.on('changed', (values: unknown) => {
      this.#onEvent(values as Variant[]);
    });
    for (const [name, telemetry] of Object.entries(TELEMETRY)) {
      const applies =
        (telemetry.kinds as readonly string[]).includes(this.#options.machine.kind) ||
        (name === 'leak-rate' && this.machineId === 'lkt-01');
      if (!applies) continue;
      const item = await subscription.monitor(
        {
          nodeId: this.#nodeId(opcuaNodeId(this.machineId, telemetry.variable)),
          attributeId: AttributeIds.Value,
        },
        {
          samplingInterval: this.#options.telemetrySamplingMs ?? 1_000,
          queueSize: 1,
          discardOldest: true,
        },
        TimestampsToReturn.Both,
      );
      item.on('changed', (dataValue: DataValue) => {
        this.#onTelemetry(name as keyof typeof TELEMETRY, dataValue);
      });
    }
  }

  #scheduleResync(afterReconnect: boolean): void {
    if (this.#closed || this.#resync) return;
    this.#resync = this.#resyncNow(afterReconnect)
      .catch((error: unknown) => {
        this.#options.onError?.(error);
      })
      .finally(() => {
        this.#resync = undefined;
      });
  }

  /** ADR-0009's resync rule, with ADR-0015's epoch. */
  async #resyncNow(afterReconnect: boolean): Promise<void> {
    const session = this.#session;
    if (!session) return;
    const read = async (path: string) =>
      session.read({
        nodeId: this.#nodeId(opcuaNodeId(this.machineId, path)),
        attributeId: AttributeIds.Value,
      });
    const [epoch, sequence, state, cause] = await Promise.all([
      read(OPCUA_VARIABLES.epoch),
      read(OPCUA_VARIABLES.sequence),
      read(OPCUA_VARIABLES.state),
      read(OPCUA_VARIABLES.stateCause),
    ]);
    if (this.machineId === 'lkt-01') {
      const limit = await read(OPCUA_VARIABLES.leakUpperLimit);
      this.#upperLimit = Number(limit.value.value);
    }
    const serverEpoch = Number(epoch.value.value);
    const serverSequence = Number(sequence.value.value);
    if (this.#epoch !== undefined && serverEpoch !== this.#epoch) {
      this.#options.incidents.report({
        type: 'epoch-change',
        equipment: this.machineId,
        lost: null,
        message: `${this.machineId}: simulator restarted (epoch ${String(this.#epoch)} → ${String(serverEpoch)})`,
      });
    }
    if (serverEpoch !== this.#epoch) {
      this.#epoch = serverEpoch;
      this.#dedup = new Deduplicator();
      // Facts before the first read are history this gateway joined after, not losses.
      this.#highest = afterReconnect ? 0 : serverSequence;
    }
    const at = state.sourceTimestamp?.getTime() ?? this.#now();
    const snapshot: StateCurrent = {
      schema: 'uns.state.current/1',
      kind: 'snapshot',
      scope: 'topic',
      epoch: this.#options.sequences.epoch,
      seq: this.#options.sequences.next(stateTopic(this.#options.path)),
      sourceTime: new Date(at).toISOString(),
      receivedAt: new Date(this.#now()).toISOString(),
      quality: quality(state.statusCode),
      source: { id: this.machineId, protocol: 'opcua' },
      value: {
        state: String(state.value.value) as MachineState,
        cause: String(cause.value.value) || null,
      },
    };
    this.#send({ topic: stateTopic(this.#options.path), message: snapshot, retain: true });
    if (afterReconnect) {
      await new Promise((resolve) => setTimeout(resolve, this.#options.resyncGraceMs ?? 2_000));
      this.#reportGaps(serverSequence);
    }
  }

  #reportGaps(serverSequence: number): void {
    const missing: [number, number][] = this.#dedup.gaps().map((g) => [g.from, g.to]);
    if (serverSequence > this.#highest) {
      missing.push([this.#highest + 1, serverSequence]);
    }
    for (const gap of this.#dedup.gaps()) {
      this.#dedup.acknowledge(gap);
    }
    const lost = missing.reduce((sum, [from, to]) => sum + (to - from + 1), 0);
    if (lost > 0) {
      this.#highest = Math.max(this.#highest, serverSequence);
      this.#options.incidents.report({
        type: 'sequence-gap',
        equipment: this.machineId,
        lost,
        message: `${this.machineId}: ${String(lost)} OPC UA events never arrived (${missing
          .map(([from, to]) => (from === to ? String(from) : `${String(from)}–${String(to)}`))
          .join(', ')})`,
      });
    }
  }

  #onEvent(values: Variant[]): void {
    const field = (name: Field): unknown => {
      const index = [...FIELDS, ...STANDARD_FIELDS].indexOf(name);
      return values[index]?.value as unknown;
    };
    const text = (name: Field): string => {
      const value = field(name);
      return typeof value === 'string' ? value : '';
    };
    if (field('MachineId') !== this.machineId || this.#epoch === undefined) {
      return; // Machinery TransitionEvents and other standard events carry no MachineId
    }
    const kind = this.#eventTypes.get(String(field('EventType')));
    const seq = Number(field('Sequence'));
    if (!kind || !(seq > 0)) return;
    const identity = {
      scope: 'device' as const,
      epoch: this.#epoch,
      seq,
      source: { id: this.machineId },
    };
    if (this.#dedup.accept('device', identity).status === 'duplicate') return;
    this.#highest = Math.max(this.#highest, seq);
    const common = {
      scope: 'device' as const,
      epoch: this.#epoch,
      seq,
      sourceTime: (field('Time') as Date).toISOString(),
      receivedAt: new Date(this.#now()).toISOString(),
      quality: 'good' as const,
      source: { id: this.machineId, protocol: 'opcua' as const },
    };
    this.#facts++;
    switch (kind) {
      case 'stateChange': {
        const message: StateCurrent = {
          ...common,
          schema: 'uns.state.current/1',
          kind: 'event',
          value: {
            state: text('ToState') as MachineState,
            cause: text('Cause') || null,
          },
        };
        this.#send({ topic: stateTopic(this.#options.path), message, retain: true });
        break;
      }
      case 'cycleComplete': {
        const measurement = Number(field('MeasurementValue'));
        const message: CycleComplete = {
          ...common,
          schema: 'uns.events.cycle-complete/1',
          value: {
            product: text('Product'),
            partId: Number(field('PartId')),
            serial: text('Serial'),
            result: text('Result') as CycleComplete['value']['result'],
            reason: text('Reason') || null,
            measurement: Number.isNaN(measurement)
              ? null
              : {
                  characteristic: 'leak-rate',
                  value: measurement,
                  unit: UNS_TELEMETRY['leak-rate'].unit,
                  upperLimit: this.#upperLimit,
                },
          },
        };
        this.#send({ topic: cycleTopic(this.#options.path), message, retain: false });
        break;
      }
      case 'alarm': {
        const code = text('AlarmCode');
        const message: Alarm = {
          ...common,
          schema: 'uns.alarms/1',
          value: {
            code,
            transition: text('Transition') as Alarm['value']['transition'],
            severity: Number(field('Severity')),
          },
        };
        this.#send({ topic: alarmTopic(this.#options.path, code), message, retain: true });
        break;
      }
    }
  }

  #onTelemetry(name: keyof typeof TELEMETRY, dataValue: DataValue): void {
    const value: unknown = dataValue.value.value;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      dataValue.statusCode !== StatusCodes.Good
    ) {
      return; // before the run starts the server reports Uncertain without a value
    }
    const topic = telemetryTopic(this.#options.path, name);
    const message: Telemetry = {
      schema: 'uns.telemetry/1',
      scope: 'topic',
      epoch: this.#options.sequences.epoch,
      seq: this.#options.sequences.next(topic),
      sourceTime: (dataValue.sourceTimestamp ?? new Date(this.#now())).toISOString(),
      receivedAt: new Date(this.#now()).toISOString(),
      quality: quality(dataValue.statusCode),
      source: { id: this.machineId, protocol: 'opcua' },
      unit: UNS_TELEMETRY[name].unit,
      value,
    };
    this.#send({ topic, message, retain: true });
  }

  #send(publication: UnsPublication): void {
    this.#options.publisher.publish(publication).catch((error: unknown) => {
      this.#options.onError?.(error);
    });
  }
}
