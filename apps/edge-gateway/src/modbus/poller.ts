import {
  ENTRY_SIZE,
  MODBUS_MAX_READ,
  MODBUS_UNIT_ID,
  REGISTERS,
  RING_CAPACITY,
  SNAPSHOT_LENGTH,
  UNS_TELEMETRY,
  alarmSnapshotTopic,
  alarmTopic,
  cycleTopic,
  decodeActiveAlarms,
  decodeEntry,
  i16,
  MACHINE_STATES,
  ringSlot,
  stateTopic,
  telemetryTopic,
  u32,
  u64,
  type Alarm,
  type AlarmSnapshot,
  type CycleComplete,
  type EquipmentPath,
  type ModbusTables,
  type RingEntry,
  type StateCurrent,
  type Telemetry,
} from '@shopfloor/contracts';
import Modbus from 'modbus-serial';
import type { TopicSequences } from '../identity.ts';
import type { IncidentReporter } from '../incidents.ts';
import type { Publisher, UnsPublication } from '../publisher.ts';

const ModbusRTU = Modbus.default;

/** Decimal places of a resolution such as 0.1 or 0.25. */
const decimalsOf = (resolution: number): number => String(resolution).split('.')[1]?.length ?? 0;

/** Reads holding registers (function 3); rejects on timeout, exception or a closed connection. */
export interface RegisterReader {
  read(address: number, length: number): Promise<number[]>;
  close(): Promise<void>;
}

/** Where the poller remembers the last ring entry it handled, so a restart neither repeats nor skips. */
export interface CursorStore {
  get(machineId: string): { readonly epoch: number; readonly seq: number } | undefined;
  set(machineId: string, cursor: { readonly epoch: number; readonly seq: number }): void;
}

export class MemoryCursorStore implements CursorStore {
  readonly #cursors = new Map<string, { epoch: number; seq: number }>();

  get(machineId: string): { epoch: number; seq: number } | undefined {
    return this.#cursors.get(machineId);
  }

  set(machineId: string, cursor: { epoch: number; seq: number }): void {
    this.#cursors.set(machineId, { ...cursor });
  }
}

/** A modbus-serial TCP client per connection; a failed connection is replaced, not reused. */
export async function connectModbus(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<RegisterReader> {
  const client = new ModbusRTU();
  // modbus-serial's close() calls back on the socket's next 'close' event only, so it never settles
  // for a socket the device has closed already (a simulator recreated, #272). destroy() clears
  // pending requests' timers (an in-flight read then never settles), destroys the socket and
  // calls back at once, whatever the socket's state.
  const destroy = () =>
    new Promise<void>((resolve) => {
      client.destroy(() => {
        resolve();
      });
    });
  try {
    await client.connectTCP(host, { port, timeout: timeoutMs });
  } catch (error) {
    // A connect that timed out leaves its socket connecting: never leave it behind.
    await destroy();
    throw error;
  }
  client.setID(MODBUS_UNIT_ID);
  client.setTimeout(timeoutMs);
  return {
    read: async (address, length) => (await client.readHoldingRegisters(address, length)).data,
    close: destroy,
  };
}

export interface ModbusPollerOptions {
  readonly machineId: string;
  readonly path: EquipmentPath;
  readonly tables: ModbusTables;
  /** Register units: the bath and conveyor resolutions of the register map. */
  readonly scaling: { readonly bath: number; readonly conveyor: number };
  /** Alarm severity (the washer's alarms are failure codes: 700, as on OPC UA). */
  readonly alarmSeverity: number;
  readonly connect: () => Promise<RegisterReader>;
  readonly publisher: Publisher;
  readonly sequences: TopicSequences;
  readonly incidents: IncidentReporter;
  readonly cursors?: CursorStore;
  readonly now?: () => number;
  /** Wall ms between polls. */
  readonly pollMs?: number;
  /** Failed polls in a row before the device counts as silent. */
  readonly silentAfter?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * WSH-01 → UNS over Modbus TCP (docs/contracts/modbus-register-map.md). Every poll reads the
 * snapshot block, publishes telemetry, and walks the event ring from the last handled entry to the
 * counter, so a polled device loses nothing unless more than 64 facts happen between two polls.
 */
export class ModbusPoller {
  readonly machineId: string;
  readonly #options: ModbusPollerOptions;
  readonly #now: () => number;
  readonly #cursors: CursorStore;
  #reader: RegisterReader | undefined;
  #epoch: number | undefined;
  #handled = 0;
  #failures = 0;
  #silent = false;
  #snapshotDue = true;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  /** poll() works without start() (tests); after stop() it does nothing more. */
  #started = false;
  #facts = 0;
  #polls = 0;

  constructor(options: ModbusPollerOptions) {
    this.#options = options;
    this.machineId = options.machineId;
    this.#now = options.now ?? Date.now;
    this.#cursors = options.cursors ?? new MemoryCursorStore();
  }

  get facts(): number {
    return this.#facts;
  }

  get connected(): boolean {
    return this.#reader !== undefined && !this.#silent;
  }

  get polls(): number {
    return this.#polls;
  }

  start(): void {
    this.#running = true;
    this.#started = true;
    this.#schedule(0);
  }

  /**
   * Stops polling and closes the connection. Doesn't wait for a poll in flight: a read pending when
   * the connection is destroyed never settles (#272), and nothing awaits that poll.
   */
  async stop(): Promise<void> {
    this.#running = false;
    this.#started = true;
    clearTimeout(this.#timer);
    await this.#closeReader();
  }

  async #closeReader(): Promise<void> {
    const reader = this.#reader;
    this.#reader = undefined;
    await reader?.close().catch(() => undefined);
  }

  /** One poll; exposed for tests. Resolves after everything it read was handed to the publisher. */
  async poll(): Promise<void> {
    if (this.#started && !this.#running) return;
    if (!this.#started) this.#running = true;
    try {
      this.#reader ??= await this.#options.connect();
      if (!this.#running) {
        await this.#closeReader(); // stopped while connecting
        return;
      }
      const snapshot = await this.#reader.read(0, SNAPSHOT_LENGTH);
      await this.#handle(this.#reader, snapshot);
      this.#polls++;
      if (this.#silent) {
        this.#silent = false;
        this.#report('device-recovered', null, `${this.machineId}: Modbus device answers again`);
      }
      this.#failures = 0;
    } catch (error) {
      this.#failures++;
      // Dropped at once and its close not awaited: a connection the device closed may never finish
      // closing, and the next poll must connect again rather than wait for it (#272).
      const reader = this.#reader;
      this.#reader = undefined;
      void reader?.close().catch(() => undefined);
      if (!this.#silent && this.#failures >= (this.#options.silentAfter ?? 3)) {
        this.#silent = true;
        this.#snapshotDue = true;
        this.#report(
          'device-silent',
          null,
          `${this.machineId}: no Modbus answer for ${String(this.#failures)} polls (${String(error)})`,
        );
      }
      this.#options.onError?.(error);
    }
  }

  #schedule(delay: number): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      void this.poll().finally(() => {
        this.#schedule(this.#options.pollMs ?? 250);
      });
    }, delay);
  }

  async #handle(reader: RegisterReader, snapshot: number[]): Promise<void> {
    const epoch = u32(snapshot, REGISTERS.epoch);
    const counter = u32(snapshot, REGISTERS.eventCounter);
    const simTime = u64(snapshot, REGISTERS.simTime);
    if (epoch !== this.#epoch) {
      const stored = this.#cursors.get(this.machineId);
      if (this.#epoch !== undefined) {
        this.#report(
          'epoch-change',
          null,
          `${this.machineId}: device restarted (epoch ${String(this.#epoch)} → ${String(epoch)})`,
        );
        this.#handled = 0; // a new run numbers its facts from 1 again
      } else if (stored?.epoch === epoch) {
        this.#handled = stored.seq; // a gateway restart resumes where it stopped
      } else {
        this.#handled = counter; // facts before the gateway first saw this run are history
      }
      this.#epoch = epoch;
      this.#snapshotDue = true;
    }
    this.#telemetry(snapshot, simTime);
    if (counter < this.#handled) {
      // The cursor is ahead of the device: another run started within the same epoch second.
      this.#report(
        'epoch-change',
        null,
        `${this.machineId}: counter ${String(counter)} is behind the cursor ${String(this.#handled)}: a new run`,
      );
      this.#handled = 0;
    }
    if (counter - this.#handled > RING_CAPACITY) {
      const lost = counter - this.#handled - RING_CAPACITY;
      this.#report(
        'ring-overrun',
        lost,
        `${this.machineId}: ${String(lost)} facts overwritten in the ring before they were read`,
      );
      // A lost fact may be an alarm clear: the snapshot of this read tells the MES (#141).
      this.#snapshotDue = true;
      this.#handled = counter - RING_CAPACITY;
    }
    let overwritten = 0;
    const undecodable: number[] = [];
    for (let seq = this.#handled + 1; seq <= counter;) {
      const untilRingEnd = RING_CAPACITY - ((seq - 1) % RING_CAPACITY);
      const count = Math.min(
        Math.floor(MODBUS_MAX_READ / ENTRY_SIZE),
        counter - seq + 1,
        untilRingEnd,
      );
      const words = await reader.read(ringSlot(seq), count * ENTRY_SIZE);
      for (let i = 0; i < count; i++) {
        const expected = seq + i;
        const entry = decodeEntry(
          words.slice(i * ENTRY_SIZE, (i + 1) * ENTRY_SIZE),
          this.#options.tables,
        );
        if (entry === undefined) {
          undecodable.push(expected);
        } else if (entry.seq !== expected) {
          overwritten++; // the ring wrapped between reading the counter and reading the entry
        } else {
          this.#publishFact(epoch, entry);
        }
        this.#handled = expected;
        this.#cursors.set(this.machineId, { epoch, seq: expected });
      }
      seq += count;
    }
    if (overwritten > 0) {
      this.#snapshotDue = true;
      this.#report(
        'ring-overrun',
        overwritten,
        `${this.machineId}: ${String(overwritten)} facts were overwritten while the ring was being read`,
      );
    }
    if (undecodable.length > 0) {
      this.#snapshotDue = true;
      this.#report(
        'sequence-gap',
        undecodable.length,
        `${this.machineId}: ring entries ${undecodable.join(', ')} could not be decoded (register map or tables out of step?)`,
      );
    }
    // After the ring loop, so the snapshot (consistent with `counter`) follows the facts up to it
    // that this poll published. Due on first contact, after a silence or an epoch change, and
    // after any fact this poll lost (overrun, undecodable): every lost number is at or below
    // `counter`, so the snapshot of this read covers it (#141).
    if (this.#snapshotDue) {
      this.#snapshotDue = false;
      // Until a snapshot is accepted (the broker may not be connected yet), try again next poll.
      this.#snapshot(snapshot, simTime).catch(() => {
        this.#snapshotDue = true;
      });
    }
  }

  #common(at: number) {
    return {
      receivedAt: new Date(this.#now()).toISOString(),
      sourceTime: new Date(at).toISOString(),
      quality: 'good' as const,
      source: { id: this.machineId, protocol: 'modbus' as const },
    };
  }

  #publishFact(epoch: number, entry: RingEntry): void {
    const common = { ...this.#common(entry.at), scope: 'device' as const, epoch, seq: entry.seq };
    this.#facts++;
    switch (entry.type) {
      case 'state': {
        const message: StateCurrent = {
          ...common,
          schema: 'uns.state.current/1',
          kind: 'event',
          value: { state: entry.state, cause: entry.cause },
        };
        this.#send({ topic: stateTopic(this.#options.path), message, retain: true });
        break;
      }
      case 'cycle': {
        // A legacy washer reads no serial numbers (register map), and makes no measurement.
        const message: CycleComplete = {
          ...common,
          schema: 'uns.events.cycle-complete/1',
          value: {
            product: entry.product,
            partId: entry.partId,
            serial: '',
            result: entry.result,
            reason: null,
            measurement: null,
          },
        };
        this.#send({ topic: cycleTopic(this.#options.path), message, retain: false });
        break;
      }
      case 'alarm': {
        const message: Alarm = {
          ...common,
          schema: 'uns.alarms/1',
          value: {
            code: entry.code,
            transition: entry.transition,
            severity: this.#options.alarmSeverity,
          },
        };
        this.#send({ topic: alarmTopic(this.#options.path, entry.code), message, retain: true });
        break;
      }
    }
  }

  /** The state snapshot and the alarm snapshot (#141), both from the same register read. */
  async #snapshot(snapshot: number[], simTime: number): Promise<void> {
    await Promise.all([
      this.#stateSnapshot(snapshot, simTime),
      this.#alarmSnapshot(snapshot, simTime),
    ]);
  }

  /**
   * The alarm snapshot (#141): the `activeAlarms` bits and the ring head `eventCounter` come from
   * one read of the snapshot block, and the device writes both in the same step (map version 2),
   * so `asOfSeq` and the bits belong together. Topic-scoped and retained; never a fact.
   */
  #alarmSnapshot(snapshot: number[], simTime: number): Promise<void> {
    const topic = alarmSnapshotTopic(this.#options.path);
    const message: AlarmSnapshot = {
      ...this.#common(simTime),
      schema: 'uns.alarm-snapshot/1',
      kind: 'snapshot',
      scope: 'topic',
      epoch: this.#options.sequences.epoch,
      seq: this.#options.sequences.next(topic),
      deviceEpoch: u32(snapshot, REGISTERS.epoch),
      asOfSeq: u32(snapshot, REGISTERS.eventCounter),
      value: {
        active: decodeActiveAlarms(
          snapshot[REGISTERS.activeAlarms] ?? 0,
          this.#options.tables,
        ).sort(),
      },
    };
    return this.#options.publisher.publish({ topic, message, retain: true });
  }

  #stateSnapshot(snapshot: number[], simTime: number): Promise<void> {
    const state = MACHINE_STATES[snapshot[REGISTERS.state] ?? -1];
    if (!state) return Promise.resolve();
    const topic = stateTopic(this.#options.path);
    const message: StateCurrent = {
      ...this.#common(simTime),
      schema: 'uns.state.current/1',
      kind: 'snapshot',
      scope: 'topic',
      epoch: this.#options.sequences.epoch,
      seq: this.#options.sequences.next(topic),
      deviceEpoch: u32(snapshot, REGISTERS.epoch),
      // The register map carries no cause for the current state; the next state change does.
      value: { state, cause: null },
    };
    return this.#options.publisher.publish({ topic, message, retain: true });
  }

  #telemetry(snapshot: number[], simTime: number): void {
    const values = {
      'bath-temperature':
        i16(snapshot[REGISTERS.bathTemperature] ?? 0) * this.#options.scaling.bath,
      'conveyor-speed': (snapshot[REGISTERS.conveyorSpeed] ?? 0) * this.#options.scaling.conveyor,
    } as const;
    for (const [name, raw] of Object.entries(values) as [keyof typeof values, number][]) {
      const topic = telemetryTopic(this.#options.path, name);
      const decimals =
        name === 'bath-temperature' ? this.#options.scaling.bath : this.#options.scaling.conveyor;
      const message: Telemetry = {
        ...this.#common(simTime),
        schema: 'uns.telemetry/1',
        scope: 'topic',
        epoch: this.#options.sequences.epoch,
        seq: this.#options.sequences.next(topic),
        // The epoch register of the same snapshot read as the values and simTime.
        deviceEpoch: u32(snapshot, REGISTERS.epoch),
        unit: UNS_TELEMETRY[name].unit,
        value: Number(raw.toFixed(decimalsOf(decimals))),
      };
      this.#send({ topic, message, retain: true });
    }
  }

  #report(
    type: 'device-silent' | 'device-recovered' | 'epoch-change' | 'ring-overrun' | 'sequence-gap',
    lost: number | null,
    message: string,
  ): void {
    this.#options.incidents.report({ type, equipment: this.machineId, lost, message });
  }

  #send(publication: UnsPublication): void {
    this.#options.publisher.publish(publication).catch((error: unknown) => {
      this.#options.onError?.(error);
    });
  }
}
