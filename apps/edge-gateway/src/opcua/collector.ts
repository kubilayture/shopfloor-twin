import {
  Deduplicator,
  OPCUA_EVENT_FIELDS,
  OPCUA_EVENT_TYPES,
  OPCUA_VARIABLES,
  SHOPFLOOR_NAMESPACE_URI,
  UNS_TELEMETRY,
  alarmSnapshotTopic,
  alarmTopic,
  cycleTopic,
  opcuaAlarmPath,
  opcuaEndpoint,
  opcuaEventTypeId,
  opcuaNodeId,
  stateTopic,
  telemetryTopic,
  toIndexedNodeId,
  type Alarm,
  type AlarmSnapshot,
  type CycleComplete,
  type EquipmentPath,
  type MachineState,
  type StateCurrent,
  type Telemetry,
} from '@shopfloor/contracts';
import {
  AttributeIds,
  OPCUAClient,
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
  /**
   * The alarm codes the machine can raise (its slice of the plant's alarm vocabulary): the
   * `ShopFloor.Alarms.<CODE>.Active` variables the resync reads for the alarm snapshot (#141).
   */
  readonly alarmCodes?: readonly string[];
  readonly now?: () => number;
  /** How often telemetry is sampled, wall ms (plan section 5: telemetry may be decimated). */
  readonly telemetrySamplingMs?: number;
  /** After a reconnect, how long events from the repaired subscription may still trickle in. */
  readonly resyncGraceMs?: number;
  /** Requested OPC UA session timeout; a longer outage needs a new session (tests shorten it). */
  readonly sessionTimeoutMs?: number;
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

/** What one alarm snapshot read found (#141). */
export type AlarmSnapshotRead =
  | {
      readonly deviceEpoch: number;
      readonly asOfSeq: number;
      /** The Sequence's source timestamp: the simulation time of fact asOfSeq, when the server has one. */
      readonly sourceTime: number | undefined;
      /** Active codes, sorted. */
      readonly active: string[];
    }
  | { readonly error: string };

/**
 * Reads `Epoch`, `Sequence` and every `ShopFloor.Alarms.<CODE>.Active` of one machine in one Read
 * call (#141). The server answers a Read from one consistent view, and ADR-0010's server changes a
 * fact's `Sequence` and its alarm variable in the same step, so `asOfSeq` and the bits belong
 * together; separate reads could straddle a fact. A value that isn't Good makes the read an error:
 * nothing is published, and the next resync tries again.
 */
export async function readAlarmSnapshot(
  read: (nodes: { nodeId: NodeId; attributeId: number }[]) => Promise<DataValue[]>,
  nodeIdOf: (path: string) => NodeId,
  alarmCodes: readonly string[],
): Promise<AlarmSnapshotRead> {
  const codes = [...new Set(alarmCodes)].sort();
  const paths = [OPCUA_VARIABLES.epoch, OPCUA_VARIABLES.sequence, ...codes.map(opcuaAlarmPath)];
  const values = await read(
    paths.map((path) => ({ nodeId: nodeIdOf(path), attributeId: AttributeIds.Value })),
  );
  for (const [i, path] of paths.entries()) {
    const value = values[i];
    if (!value?.statusCode.isGood()) {
      return { error: `${path} reads ${value?.statusCode.toString() ?? 'nothing'}` };
    }
  }
  const [epoch, sequence, ...active] = values;
  return {
    deviceEpoch: Number(epoch?.value.value),
    asOfSeq: Number(sequence?.value.value),
    sourceTime: sequence?.sourceTimestamp?.getTime(),
    active: codes.filter((_code, i) => active[i]?.value.value === true),
  };
}

export interface LostRange {
  readonly epoch: number;
  readonly from: number;
  readonly to: number;
}

/**
 * One OPC UA machine → UNS (ADR-0009, ADR-0015). Device facts (state changes, cycles, alarm
 * transitions) come as events with the machine's `Sequence`. Events wait until the epoch they
 * belong to is known: at start-up, and again after every connection loss. After every (re)connect
 * the collector reads `Epoch`, `Sequence` and the current state, publishes a snapshot, and, after
 * a grace period for the repaired subscription, reports facts that never arrived as one
 * sequence-gap incident. A reported number counts as handled: it is never reported twice, and a
 * copy arriving later is dropped, so every fact is either published once or counted lost once.
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
  /** Highest device sequence seen or written off in the current epoch. */
  #highest = 0;
  #upperLimit = Number.NaN;
  /** Events waiting for their epoch; undefined while the epoch is known. */
  #pending: Variant[][] | undefined = [];
  #resyncRunning = false;
  #resyncAgain = false;
  #graceTimer: ReturnType<typeof setTimeout> | undefined;
  #ready = false;
  #facts = 0;
  #closed = false;
  #baselineSequence = 0;
  readonly #lost: LostRange[] = [];

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
      requestedSessionTimeout: options.sessionTimeoutMs ?? 60_000,
      connectionStrategy: { maxRetry: 1_000_000, initialDelay: 250, maxDelay: 2_000 },
      ...(options.certificateManager
        ? { clientCertificateManager: options.certificateManager }
        : {}),
    });
    this.#client.on('connection_lost', () => {
      this.#ready = false;
      this.#pending ??= [];
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

  /** The machine's `Sequence` the collector joined at: facts up to it are history. */
  get baseline(): number {
    return this.#baselineSequence;
  }

  /** Device facts published since start. */
  get facts(): number {
    return this.#facts;
  }

  /** Device sequence ranges reported lost (sequence-gap incidents). */
  get lost(): readonly LostRange[] {
    return this.#lost;
  }

  /** True once the epoch is known and the subscription delivers; false while reconnecting. */
  get connected(): boolean {
    return this.#ready && !this.#closed;
  }

  /** Creates the client certificate if it doesn't exist yet. Call it for one collector at a time. */
  async prepare(): Promise<void> {
    await this.#client.createDefaultCertificate();
  }

  /** Resolves once connected and subscribed; keeps retrying while the server is unreachable. */
  async start(): Promise<void> {
    await this.#client.connect(this.endpoint);
    const session = await this.#client.createSession();
    this.#session = session;
    session.on('session_restored', () => {
      this.#requestResync();
    });
    this.#namespaces = await session.readNamespaceArray();
    for (const [kind, name] of Object.entries(OPCUA_EVENT_TYPES) as [
      keyof typeof OPCUA_EVENT_TYPES,
      string,
    ][]) {
      this.#eventTypes.set(this.#nodeId(opcuaEventTypeId(name)).toString(), kind);
    }
    // Subscribe first, then read the baseline: what the subscription delivers before the read is
    // kept in #pending, so no fact can fall between the two.
    await this.#subscribe(session);
    this.#resyncRunning = true;
    try {
      await this.#resync(false);
    } finally {
      this.#resyncRunning = false;
    }
  }

  async stop(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#graceTimer);
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

  /** Coalesces reconnects: one that happens during a resync runs another resync afterwards. */
  #requestResync(): void {
    if (this.#closed) return;
    if (this.#resyncRunning) {
      this.#resyncAgain = true;
      return;
    }
    this.#resyncRunning = true;
    void this.#resync(true)
      .catch((error: unknown) => {
        this.#options.onError?.(error);
      })
      .finally(() => {
        this.#resyncRunning = false;
        if (this.#resyncAgain) {
          this.#resyncAgain = false;
          this.#requestResync();
        }
      });
  }

  /** ADR-0009's resync rule, with ADR-0015's epoch. */
  async #resync(afterReconnect: boolean): Promise<void> {
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
      this.#upperLimit = Number((await read(OPCUA_VARIABLES.leakUpperLimit)).value.value);
    }
    const serverEpoch = Number(epoch.value.value);
    const serverSequence = Number(sequence.value.value);
    const pending = this.#pending ?? [];
    let epochChanged = false;
    if (this.#epoch === undefined) {
      // First contact: history ends where the subscription's first event begins.
      const first = Math.min(
        ...pending.map((values) => this.#sequenceOf(values)).filter((s) => s > 0),
      );
      this.#baselineSequence = Number.isFinite(first)
        ? Math.min(first - 1, serverSequence)
        : serverSequence;
      this.#startEpoch(serverEpoch, this.#baselineSequence);
    } else if (serverEpoch !== this.#epoch) {
      epochChanged = true;
      this.#options.incidents.report({
        type: 'epoch-change',
        equipment: this.machineId,
        lost: null,
        message: `${this.machineId}: simulator restarted (epoch ${String(this.#epoch)} → ${String(serverEpoch)})`,
      });
      this.#writeOff(this.#dedup.gaps().map((g) => [g.from, g.to] as const)); // the old run's holes
      this.#startEpoch(serverEpoch, 0); // the new run numbers its facts from 1
    }
    this.#pending = undefined;
    for (const values of pending) {
      this.#handleEvent(values);
    }
    const at = state.sourceTimestamp?.getTime() ?? this.#now();
    const topic = stateTopic(this.#options.path);
    const snapshot: StateCurrent = {
      schema: 'uns.state.current/1',
      kind: 'snapshot',
      scope: 'topic',
      epoch: this.#options.sequences.epoch,
      seq: this.#options.sequences.next(topic),
      // The simulator run the state belongs to, so the MES anchors it to the right epoch.
      deviceEpoch: serverEpoch,
      sourceTime: new Date(at).toISOString(),
      receivedAt: new Date(this.#now()).toISOString(),
      quality: quality(state.statusCode),
      source: { id: this.machineId, protocol: 'opcua' },
      value: {
        state: String(state.value.value) as MachineState,
        cause: (typeof cause.value.value === 'string' && cause.value.value) || null,
      },
    };
    this.#send({ topic, message: snapshot, retain: true });
    await this.#alarmSnapshot(session).catch((error: unknown) => {
      this.#options.onError?.(error);
    });
    this.#ready = true;
    if (afterReconnect || epochChanged) {
      await new Promise<void>((resolve) => {
        this.#graceTimer = setTimeout(resolve, this.#options.resyncGraceMs ?? 2_000);
      });
      if (this.#closed) return;
      const missing = this.#dedup.gaps().map((g) => [g.from, g.to] as const);
      if (serverSequence > this.#highest) {
        missing.push([this.#highest + 1, serverSequence]);
      }
      this.#writeOff(missing);
    }
  }

  /** The alarm snapshot (#141), published retained; see `readAlarmSnapshot`. */
  async #alarmSnapshot(session: ClientSession): Promise<void> {
    const read = await readAlarmSnapshot(
      (nodes) => session.read(nodes),
      (path) => this.#nodeId(opcuaNodeId(this.machineId, path)),
      this.#options.alarmCodes ?? [],
    );
    if ('error' in read) {
      this.#options.onError?.(
        new Error(`${this.machineId}: alarm snapshot not published, ${read.error}`),
      );
      return;
    }
    const topic = alarmSnapshotTopic(this.#options.path);
    const message: AlarmSnapshot = {
      schema: 'uns.alarm-snapshot/1',
      kind: 'snapshot',
      scope: 'topic',
      epoch: this.#options.sequences.epoch,
      seq: this.#options.sequences.next(topic),
      deviceEpoch: read.deviceEpoch,
      asOfSeq: read.asOfSeq,
      sourceTime: new Date(read.sourceTime ?? this.#now()).toISOString(),
      receivedAt: new Date(this.#now()).toISOString(),
      quality: 'good',
      source: { id: this.machineId, protocol: 'opcua' },
      value: { active: read.active },
    };
    this.#send({ topic, message, retain: true });
  }

  /** A new epoch: a sentinel 0 plus the history 1..historyUpTo count as handled. */
  #startEpoch(epoch: number, historyUpTo: number): void {
    this.#epoch = epoch;
    this.#dedup = new Deduplicator();
    this.#dedup.accept('device', {
      scope: 'device',
      epoch,
      seq: 0,
      source: { id: this.machineId },
    });
    if (historyUpTo > 0) {
      this.#dedup.acknowledge({ stream: this.#stream, epoch, from: 1, to: historyUpTo });
    }
    this.#highest = historyUpTo;
  }

  get #stream(): string {
    return `device:${this.machineId}`;
  }

  /** Reports ranges as lost, once, and marks them handled so a late copy is dropped. */
  #writeOff(ranges: readonly (readonly [number, number])[]): void {
    const epoch = this.#epoch;
    if (epoch === undefined || ranges.length === 0) return;
    for (const [from, to] of ranges) {
      this.#dedup.acknowledge({ stream: this.#stream, epoch, from, to });
      this.#highest = Math.max(this.#highest, to);
      this.#lost.push({ epoch, from, to });
    }
    const lost = ranges.reduce((sum, [from, to]) => sum + (to - from + 1), 0);
    this.#options.incidents.report({
      type: 'sequence-gap',
      equipment: this.machineId,
      lost,
      message: `${this.machineId}: ${String(lost)} OPC UA events never arrived (${ranges
        .map(([from, to]) => (from === to ? String(from) : `${String(from)}–${String(to)}`))
        .join(', ')})`,
    });
  }

  #sequenceOf(values: Variant[]): number {
    const index = [...FIELDS, ...STANDARD_FIELDS].indexOf('Sequence');
    const value: unknown = values[index]?.value;
    return typeof value === 'number' ? value : 0;
  }

  #onEvent(values: Variant[]): void {
    if (this.#pending) {
      this.#pending.push(values);
      return;
    }
    this.#handleEvent(values);
  }

  #handleEvent(values: Variant[]): void {
    const field = (name: Field): unknown => {
      const index = [...FIELDS, ...STANDARD_FIELDS].indexOf(name);
      return values[index]?.value as unknown;
    };
    const text = (name: Field): string => {
      const value = field(name);
      return typeof value === 'string' ? value : '';
    };
    const epoch = this.#epoch;
    if (field('MachineId') !== this.machineId || epoch === undefined) {
      return; // Machinery TransitionEvents and other standard events carry no MachineId
    }
    const kind = this.#eventTypes.get(String(field('EventType')));
    const seq = Number(field('Sequence'));
    if (!kind || !(seq > 0)) return;
    const identity = { scope: 'device' as const, epoch, seq, source: { id: this.machineId } };
    if (this.#dedup.accept('device', identity).status === 'duplicate') return;
    this.#highest = Math.max(this.#highest, seq);
    const common = {
      scope: 'device' as const,
      epoch,
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
      case 'job':
        // Orders-mode job facts (#172, simulator only so far): their select clause and their
        // `events/job` topic come with the command path (#173). Until then a job event's sequence
        // number is seen (dedup, highest) but not published.
        break;
    }
  }

  #onTelemetry(name: keyof typeof TELEMETRY, dataValue: DataValue): void {
    const value: unknown = dataValue.value.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || dataValue.statusCode.isBad()) {
      return; // before the run starts the server reports Uncertain without a value
    }
    const topic = telemetryTopic(this.#options.path, name);
    // The server's epoch, read by the resync of this connection. After a connection loss it is
    // unknown until that resync ran (a restarted simulator's samples may come first), so the
    // sample goes out without one: the MES then never credits it to an epoch.
    const deviceEpoch = this.#pending === undefined ? this.#epoch : undefined;
    const message: Telemetry = {
      schema: 'uns.telemetry/1',
      scope: 'topic',
      epoch: this.#options.sequences.epoch,
      seq: this.#options.sequences.next(topic),
      ...(deviceEpoch === undefined ? {} : { deviceEpoch }),
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
