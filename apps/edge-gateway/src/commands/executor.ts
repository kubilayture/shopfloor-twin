import {
  OPCUA_METHODS,
  OPCUA_VARIABLES,
  commandResultTopic,
  parseUnsCommandMessage,
  type CommandResult,
  type CommandResultKind,
  type CommandResultValue,
  type EquipmentPath,
  type LoadOrderCommand,
} from '@shopfloor/contracts';
import type { CallMethodResult, DataValue, VariantOptions } from 'node-opcua';
import type { TopicSequences } from '../identity.ts';
import type { ResultPublisher } from '../publisher.ts';
import {
  answeredFields,
  interpretLoadOrder,
  interpretSettleCall,
  jobKey,
  loadOrderArguments,
  type CallOutcome,
} from './load-order.ts';
import type { CommandStore, InboxEntry } from './store.ts';

/** The OPC UA side of one CNC, as the collector offers it (#173). */
export interface CommandMachine {
  readonly machineId: string;
  /** The device epoch while the session is ready (connected, subscribed, resync done). */
  readonly deviceEpoch: number | undefined;
  readVariable(path: string, deadlineMs: number): Promise<DataValue>;
  callMethod(
    path: string,
    inputArguments: VariantOptions[],
    deadlineMs: number,
  ): Promise<CallMethodResult>;
}

export interface CommandExecutorOptions {
  readonly store: CommandStore;
  /** The outbox: a result resolves once it is durably stored there. */
  readonly publisher: ResultPublisher;
  readonly sequences: TopicSequences;
  /** Every equipment's UNS path (a command may name any of them). */
  readonly paths: ReadonlyMap<string, EquipmentPath>;
  /** The machines that execute `load-order` (the CNCs). */
  readonly machines: ReadonlyMap<string, CommandMachine>;
  /** Application-level deadline per OPC UA request (`GATEWAY_CALL_DEADLINE_MS`). */
  readonly callDeadlineMs: number;
  /** Pause between attempts before `expiresAt`. */
  readonly retryMs?: number;
  /** Pause between settle attempts of an `unknown` outcome. */
  readonly settleRetryMs?: number;
  /** Clock allowance after `expiresAt` before the settle call. */
  readonly clockAllowanceMs?: number;
  /**
   * How long a settle attempt waits for the session to become ready (after a restart or a
   * reconnect) before it reports `unknown`.
   */
  readonly settleReadyWaitMs?: number;
  readonly now?: () => number;
  /** Every result published (logs and metrics). */
  readonly onResult?: (value: CommandResultValue, equipment: string) => void;
  /** A delivery that is not a valid `load-order` command: acknowledged and dropped. */
  readonly onInvalid?: (entry: InboxEntry, error: string) => void;
  readonly onError?: (error: unknown) => void;
}

interface Delivery {
  readonly entry: InboxEntry;
  readonly command: LoadOrderCommand;
  readonly equipment: string;
  readonly expiresAt: number;
  readonly job: string;
}

type Final = Extract<CallOutcome, { kind: 'final' }>;

/**
 * Executes `cmd/load-order` deliveries on the CNCs (#173, plan B2, ADR-0029):
 *
 * - one delivery at a time per equipment, in arrival order; every OPC UA request of an equipment
 *   (calls, epoch and sequence reads) runs under one lock;
 * - a stored definitive answer for the command id (or the device's `expired` for this
 *   `expiresAt`) answers a redelivery or resend without calling;
 * - otherwise the gateway calls `LoadOrder` only on a ready session, with a deadline, and before
 *   every retry re-reads `ShopFloor.Epoch` (a changed epoch is `rejected`, `epoch-mismatch`,
 *   without calling); it retries until `expiresAt`;
 * - without a definitive answer by then, the outcome is settled after `expiresAt` plus the clock
 *   allowance: `ShopFloor.Sequence` is read (`seqAfterExpiry`) and one more call is made. Until
 *   that answers, `unknown` is published (not stored) and settling continues in the background,
 *   so the equipment's next command isn't held up. The gateway never answers `expired` or `failed`
 *   on its own.
 *
 * A delivery is removed from the inbox only after its answer is in the outbox, so a crash at any
 * point processes it again: the device's dedup makes the repeated call safe.
 */
export class CommandExecutor {
  readonly #options: CommandExecutorOptions;
  readonly #now: () => number;
  readonly #queues = new Map<string, InboxEntry[]>();
  readonly #running = new Set<string>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #settling = new Set<Promise<void>>();
  readonly #stop = new AbortController();
  #calls = 0;
  readonly #results = new Map<CommandResultKind, number>();

  constructor(options: CommandExecutorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** `LoadOrder` calls made (settle calls included). */
  get calls(): number {
    return this.#calls;
  }

  /** Results published, by kind. */
  get results(): ReadonlyMap<CommandResultKind, number> {
    return this.#results;
  }

  /** Deliveries waiting or in progress, and outcomes being settled. */
  get pending(): { readonly queued: number; readonly settling: number } {
    let queued = this.#running.size;
    for (const queue of this.#queues.values()) queued += queue.length;
    return { queued, settling: this.#settling.size };
  }

  /** Picks up what a previous run left in the inbox (call once, before new deliveries). */
  start(): void {
    for (const entry of this.#options.store.pending()) this.submit(entry);
  }

  /** A recorded delivery (its PUBACK is on its way). */
  submit(entry: InboxEntry): void {
    if (this.#stop.signal.aborted) return;
    const queue = this.#queues.get(entry.equipment) ?? [];
    queue.push(entry);
    this.#queues.set(entry.equipment, queue);
    if (!this.#running.has(entry.equipment)) {
      this.#running.add(entry.equipment);
      void this.#drain(entry.equipment);
    }
  }

  /** Stops waiting and calling; what is unanswered stays in the inbox for the next start. */
  async stop(): Promise<void> {
    this.#stop.abort();
    await Promise.allSettled([...this.#settling]);
  }

  /** A method, not a getter: it changes while a loop awaits, which narrowing can't see. */
  #stopped(): boolean {
    return this.#stop.signal.aborted;
  }

  async #drain(equipment: string): Promise<void> {
    const queue = this.#queues.get(equipment) ?? [];
    try {
      for (let entry = queue.shift(); entry && !this.#stopped(); entry = queue.shift()) {
        await this.#process(entry).catch((error: unknown) => {
          this.#options.onError?.(error);
        });
      }
    } finally {
      this.#running.delete(equipment);
    }
  }

  async #process(entry: InboxEntry): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(entry.payload);
    } catch (error) {
      this.#invalid(entry, error instanceof Error ? error.message : String(error));
      return;
    }
    const parsed = parseUnsCommandMessage(json);
    if (!parsed.ok || parsed.message.schema !== 'uns.cmd.load-order/1') {
      this.#invalid(
        entry,
        parsed.ok ? `schema ${parsed.message.schema} on a command topic` : parsed.error,
      );
      return;
    }
    const command = parsed.message;
    const delivery: Delivery = {
      entry,
      command,
      equipment: entry.equipment,
      expiresAt: Date.parse(command.expiresAt),
      job: jobKey(entry.equipment, command),
    };
    const machine = this.#options.machines.get(entry.equipment);
    if (!machine) {
      await this.#finish(delivery, {
        result: 'rejected',
        ...answeredFields(command, null),
        code: 'unsupported-equipment',
      });
      return;
    }
    if (await this.#answerFromTable(delivery)) return;
    const outcome = await this.#attempts(delivery, machine);
    if (outcome) {
      await this.#finish(delivery, outcome.value);
      return;
    }
    if (this.#stopped()) return;
    const settling = this.#settle(delivery, machine).catch((error: unknown) => {
      this.#options.onError?.(error);
    });
    this.#settling.add(settling);
    void settling.finally(() => this.#settling.delete(settling));
  }

  #invalid(entry: InboxEntry, error: string): void {
    this.#options.onInvalid?.(entry, error);
    this.#options.store.done(entry.id);
  }

  /** A stored definitive answer for this delivery, published again without calling. */
  async #answerFromTable(delivery: Delivery): Promise<boolean> {
    const { command, job } = delivery;
    const stored =
      this.#options.store.result(command.value.commandId) ??
      this.#options.store.expired(command.value.commandId, command.expiresAt);
    // Another job under the same id goes to the device, which answers `command-conflict`.
    if (stored?.job !== job) return false;
    await this.#finish(delivery, { ...stored.value, expiresAt: command.expiresAt }, false);
    return true;
  }

  /** Calls until a definitive answer or `expiresAt`; undefined when there was none by then. */
  async #attempts(delivery: Delivery, machine: CommandMachine): Promise<Final | undefined> {
    let called = false;
    while (!this.#stopped() && this.#now() < delivery.expiresAt) {
      if (!(await this.#whenReady(machine, delivery.expiresAt))) break;
      const outcome = await this.#locked(delivery.equipment, async (): Promise<CallOutcome> => {
        if (called) {
          const epoch = await this.#readEpoch(machine);
          if (epoch === undefined) {
            return { kind: 'unknown', reason: 'epoch not readable', statusCode: null };
          }
          if (epoch !== delivery.command.value.deviceEpoch) return this.#epochEnded(delivery);
        }
        called = true;
        return this.#call(delivery, machine, (result) =>
          interpretLoadOrder(delivery.command, result),
        );
      });
      if (outcome.kind === 'final') return outcome;
      await this.#sleep(Math.min(this.#options.retryMs ?? 1_000, delivery.expiresAt - this.#now()));
    }
    return undefined;
  }

  /**
   * After `expiresAt` + the allowance: read `Sequence`, then one call. Repeated until definitive,
   * publishing `unknown` meanwhile (again only when `seqAfterExpiry` was read for the first time).
   */
  async #settle(delivery: Delivery, machine: CommandMachine): Promise<void> {
    const allowance = this.#options.clockAllowanceMs ?? 1_000;
    await this.#sleep(delivery.expiresAt + allowance - this.#now());
    let published: { seqAfterExpiry: number | null } | undefined;
    while (!this.#stopped()) {
      if (await this.#answerFromTable(delivery)) return;
      await this.#whenReady(machine, this.#now() + (this.#options.settleReadyWaitMs ?? 10_000));
      if (this.#stopped()) return;
      const { outcome, seqAfterExpiry } = await this.#locked(
        delivery.equipment,
        async (): Promise<{ outcome: CallOutcome; seqAfterExpiry: number | null }> => {
          const unknown = (reason: string, seq: number | null = null) => ({
            outcome: { kind: 'unknown', reason, statusCode: null } as const,
            seqAfterExpiry: seq,
          });
          if (machine.deviceEpoch === undefined) return unknown('OPC UA session not ready');
          const epoch = await this.#readEpoch(machine);
          if (epoch === undefined) return unknown('epoch not readable');
          if (epoch !== delivery.command.value.deviceEpoch) {
            return { outcome: this.#epochEnded(delivery), seqAfterExpiry: null };
          }
          const sequence = await this.#readNumber(machine, OPCUA_VARIABLES.sequence);
          if (sequence === undefined) return unknown('sequence not readable');
          const called = await this.#call(delivery, machine, (result) =>
            interpretSettleCall(delivery.command, result, sequence),
          );
          return { outcome: called, seqAfterExpiry: sequence };
        },
      );
      if (outcome.kind === 'final') {
        await this.#finish(delivery, outcome.value);
        return;
      }
      if (this.#stopped()) return;
      if (!published || (published.seqAfterExpiry === null && seqAfterExpiry !== null)) {
        published = { seqAfterExpiry };
        await this.#publish(delivery.equipment, {
          result: 'unknown',
          ...answeredFields(delivery.command, outcome.statusCode),
          seqAfterExpiry,
          reason: outcome.kind === 'unknown' ? outcome.reason : `answered ${outcome.statusCode}`,
        });
      }
      await this.#sleep(this.#options.settleRetryMs ?? 5_000);
    }
  }

  #epochEnded(delivery: Delivery): Final {
    return {
      kind: 'final',
      value: {
        result: 'rejected',
        ...answeredFields(delivery.command, null),
        code: 'epoch-mismatch',
      },
    };
  }

  async #call(
    delivery: Delivery,
    machine: CommandMachine,
    interpret: (result: CallMethodResult) => CallOutcome,
  ): Promise<CallOutcome> {
    this.#calls++;
    try {
      const result = await machine.callMethod(
        OPCUA_METHODS.loadOrder,
        loadOrderArguments(delivery.command),
        this.#options.callDeadlineMs,
      );
      return interpret(result);
    } catch (error) {
      return {
        kind: 'unknown',
        reason: error instanceof Error ? error.message : String(error),
        statusCode: null,
      };
    }
  }

  async #readEpoch(machine: CommandMachine): Promise<number | undefined> {
    return this.#readNumber(machine, OPCUA_VARIABLES.epoch);
  }

  async #readNumber(machine: CommandMachine, path: string): Promise<number | undefined> {
    try {
      const value = await machine.readVariable(path, this.#options.callDeadlineMs);
      const number: unknown = value.value.value;
      return value.statusCode.isGood() && typeof number === 'number' ? number : undefined;
    } catch {
      return undefined;
    }
  }

  /** Stores a definitive answer (unless it came from the table), publishes it, closes the delivery. */
  async #finish(delivery: Delivery, value: CommandResultValue, store = true): Promise<void> {
    if (store && value.result !== 'unknown') this.#options.store.saveResult(delivery.job, value);
    await this.#publish(delivery.equipment, value);
    this.#options.store.done(delivery.entry.id);
  }

  /** Into the outbox; retried until it is durably stored there (or the executor stops). */
  async #publish(equipment: string, value: CommandResultValue): Promise<void> {
    const path = this.#options.paths.get(equipment);
    if (!path) throw new Error(`${equipment} is not in the plant configuration`);
    const topic = commandResultTopic(path, 'load-order');
    for (;;) {
      const message: CommandResult = {
        schema: 'uns.cmd-res/1',
        scope: 'topic',
        epoch: this.#options.sequences.epoch,
        seq: this.#options.sequences.next(topic),
        source: { id: equipment, protocol: 'opcua' },
        respondedAt: new Date(this.#now()).toISOString(),
        value,
      };
      try {
        await this.#options.publisher.publish({ topic, message, retain: false });
        this.#results.set(value.result, (this.#results.get(value.result) ?? 0) + 1);
        this.#options.onResult?.(value, equipment);
        return;
      } catch (error) {
        this.#options.onError?.(error);
        if (this.#stopped()) throw error;
        await this.#sleep(this.#options.retryMs ?? 1_000);
      }
    }
  }

  /** Waits until the machine's session is ready, at most until `until` (wall ms). */
  async #whenReady(machine: CommandMachine, until: number): Promise<boolean> {
    while (machine.deviceEpoch === undefined) {
      if (this.#stopped() || this.#now() >= until) return false;
      await this.#sleep(Math.min(100, until - this.#now()));
    }
    return !this.#stopped();
  }

  /** One OPC UA request sequence at a time per equipment. */
  async #locked<T>(equipment: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(equipment) ?? Promise.resolve();
    const run = previous.then(action, action);
    this.#locks.set(
      equipment,
      run.catch(() => undefined),
    );
    return run;
  }

  async #sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.#stopped()) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      const signal = this.#stop.signal;
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done);
    });
  }
}
