import {
  ALARM_SNAPSHOT_NAME,
  CYCLE_TRACE_FIELDS,
  SYS_SEGMENT,
  UNS_ROOT,
  parseEquipmentTopic,
  parseUnsCommandMessage,
  parseUnsMessage,
  streamKey,
  unsName,
  type Alarm,
  type AlarmSnapshot,
  type CommandResult,
  type CycleComplete,
  type Incident,
  type JobEvent,
  type StateCurrent,
  type Status,
  type Telemetry,
  type UnsMessage,
  type UnsSchemaName,
} from '@shopfloor/contracts';
import { z } from 'zod';
import type { RejectReason } from './tables.ts';

export type StateEvent = Extract<StateCurrent, { kind: 'event' }>;

/** What one delivery is, after validation against its topic (docs/contracts/uns.md). */
export type Classified =
  | { readonly kind: 'rejected'; readonly reason: RejectReason; readonly detail: string }
  | {
      readonly kind: 'event';
      readonly stream: string;
      readonly equipment: string;
      readonly eventType: 'state' | 'cycle' | 'alarm' | 'job';
      readonly message: StateEvent | CycleComplete | Alarm | JobEvent;
      /**
       * A cycle stored without trace fields it carried but the contract refuses (UNS contract 1.4,
       * #197): what was dropped and the delivery as received, recorded as `trace-dropped` in the
       * fact's own transaction. The cycle itself is a fact, so the device sequence keeps no gap.
       */
      readonly traceDropped?: { readonly detail: string; readonly payload: string };
    }
  /**
   * The gateway's answer to a command delivery (`cmd-res`, UNS contract 1.3, #174): a
   * topic-scoped stream (the gateway's counter per topic), deduplicated like telemetry.
   */
  | {
      readonly kind: 'command-result';
      readonly stream: string;
      readonly equipment: string;
      readonly message: CommandResult;
    }
  | {
      readonly kind: 'telemetry';
      readonly stream: string;
      readonly equipment: string;
      readonly name: string;
      readonly message: Telemetry;
    }
  | { readonly kind: 'anchor'; readonly equipment: string; readonly message: StateCurrent }
  /** A retained alarm delivery (#141): the device's last fact for its code, never a fact here. */
  | { readonly kind: 'alarm-anchor'; readonly equipment: string; readonly message: Alarm }
  /** The gateway's alarm snapshot (#141), retained or not: never a fact. */
  | { readonly kind: 'alarm-snapshot'; readonly equipment: string; readonly message: AlarmSnapshot }
  | {
      readonly kind: 'incident';
      readonly stream: string;
      readonly instance: string;
      readonly message: Incident;
    }
  | {
      readonly kind: 'status';
      readonly component: string;
      readonly instance: string;
      readonly message: Status;
    }
  /** A retained copy of a fact topic (telemetry, cycle, incident): current value, not a fact. */
  | { readonly kind: 'retained'; readonly detail: string };

const SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type TopicInfo =
  | {
      readonly type: 'equipment';
      readonly equipment: string;
      readonly name: string;
      readonly expected: UnsSchemaName;
    }
  /** `cmd-res/load-order` (#174): validated with the command registry, not the fact schemas. */
  | { readonly type: 'command-result'; readonly equipment: string }
  | {
      readonly type: 'sys';
      readonly component: string;
      readonly instance: string;
      readonly expected: UnsSchemaName;
    };

function topicInfo(topic: string): TopicInfo | string {
  const parsed = parseEquipmentTopic(topic);
  if (parsed) {
    const { equipment, name } = parsed;
    switch (parsed.topicClass) {
      case 'state':
        return name === 'current'
          ? { type: 'equipment', equipment, name, expected: 'uns.state.current/1' }
          : `no state topic "${name}" (only state/current)`;
      case 'telemetry':
        return { type: 'equipment', equipment, name, expected: 'uns.telemetry/1' };
      case 'events':
        // Job facts (`events/job`, UNS contract 1.3) are device facts like cycles (#174,
        // ADR-0017 note).
        return name === 'cycle-complete'
          ? { type: 'equipment', equipment, name, expected: 'uns.events.cycle-complete/1' }
          : name === 'job'
            ? { type: 'equipment', equipment, name, expected: 'uns.events.job/1' }
            : `no event topic "${name}" (only events/cycle-complete and events/job)`;
      case 'alarms':
        return name === ALARM_SNAPSHOT_NAME
          ? { type: 'equipment', equipment, name, expected: 'uns.alarm-snapshot/1' }
          : { type: 'equipment', equipment, name, expected: 'uns.alarms/1' };
      case 'cmd-res':
        return name === 'load-order'
          ? { type: 'command-result', equipment }
          : `no command result topic "${name}" (only cmd-res/load-order)`;
      case 'cmd':
      case 'mes':
        return `class "${parsed.topicClass}" is not ingested`;
    }
  }
  const parts = topic.split('/');
  const [, , sys, component = '', instance = '', name] = parts;
  if (
    topic.startsWith(`${UNS_ROOT}/`) &&
    parts.length === 6 &&
    sys === SYS_SEGMENT &&
    SEGMENT.test(component) &&
    SEGMENT.test(instance) &&
    (name === 'status' || name === 'incidents')
  ) {
    return {
      type: 'sys',
      component,
      instance,
      expected: name === 'status' ? 'uns.sys.status/1' : 'uns.sys.incident/1',
    };
  }
  return 'not a UNS equipment or _sys topic';
}

/** Timestamps outside these years are certainly wrong, and PostgreSQL can't store some of them. */
export const TIME_RANGE = { from: Date.UTC(1970, 0, 1), to: Date.UTC(2200, 0, 1) } as const;

/** Strings the database can't store: NUL characters (text, jsonb) and lone surrogates (jsonb). */
function badString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    if (value.includes('\u0000')) return 'a string contains a NUL character';
    if (!value.isWellFormed()) return 'a string contains a lone surrogate (not well-formed UTF-16)';
    return undefined;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const problem = badString(key) ?? badString(item);
      if (problem) return problem;
    }
  }
  return undefined;
}

/** A valid message the database could still not store, or that has an absurd timestamp. */
function storableProblem(message: UnsMessage | CommandResult): string | undefined {
  const times: [string, string][] =
    message.schema === 'uns.cmd-res/1'
      ? [
          ['respondedAt', message.respondedAt],
          ['expiresAt', message.value.expiresAt],
        ]
      : [
          ['sourceTime', message.sourceTime],
          ['receivedAt', message.receivedAt],
        ];
  if (message.schema === 'uns.sys.status/1') times.push(['startedAt', message.value.startedAt]);
  if (
    message.schema === 'uns.cmd-res/1' &&
    (message.value.result === 'accepted' || message.value.result === 'duplicate')
  ) {
    times.push(['acceptedAt', message.value.acceptedAt]);
  }
  for (const [field, time] of times) {
    const ms = Date.parse(time);
    if (!(ms >= TIME_RANGE.from && ms < TIME_RANGE.to)) {
      return `${field} ${time} is outside the years 1970 to 2199`;
    }
  }
  return badString(message);
}

type TraceField = keyof typeof CYCLE_TRACE_FIELDS;
const TRACE_FIELDS = Object.keys(CYCLE_TRACE_FIELDS) as TraceField[];

/**
 * A cycle delivery whose only schema problems are in its trace fields (UNS contract 1.4, #197):
 * the same JSON without each of `lots` and `operator` that fails its own schema, with what was
 * wrong. Undefined when no trace field fails (the delivery is invalid for another reason, or
 * valid).
 */
function withoutBadTraceFields(json: unknown): { json: unknown; problems: string[] } | undefined {
  if (typeof json !== 'object' || json === null || !('value' in json)) return undefined;
  const value: unknown = json.value;
  if (typeof value !== 'object' || value === null) return undefined;
  const fields: Record<string, unknown> = value as Record<string, unknown>;
  const problems: string[] = [];
  const bad = new Set<string>();
  for (const field of TRACE_FIELDS) {
    if (!(field in fields)) continue;
    const result = CYCLE_TRACE_FIELDS[field].safeParse(fields[field]);
    if (!result.success) {
      problems.push(`${field}: ${z.prettifyError(result.error).replaceAll('\n', ' ')}`);
      bad.add(field);
    }
  }
  const kept = Object.fromEntries(Object.entries(fields).filter(([key]) => !bad.has(key)));
  return problems.length > 0 ? { json: { ...json, value: kept }, problems } : undefined;
}

/**
 * Lots and operator on a cycle (UNS contract 1.4, #197, ADR-0033), beyond the schema: they are
 * OPC UA fields (`LotMaterials`, `LotIds`, `Operator`), so a Modbus cycle (WSH-01, a legacy washer)
 * carries neither; a cycle that consumed nothing has no start, so no operator (`lots: []` with an
 * operator); and they must be storable (no NUL, no lone surrogate). Returns the fields to drop
 * with why. Material and lot pairs may repeat (a BOM can take two of one lot).
 */
function cycleTraceProblems(message: CycleComplete): { field: TraceField; problem: string }[] {
  const { lots, operator } = message.value;
  const present = TRACE_FIELDS.filter((field) => message.value[field] !== undefined);
  if (message.source.protocol !== 'opcua') {
    return present.map((field) => ({
      field,
      problem: `${field} come from OPC UA only, not from a ${message.source.protocol} cycle`,
    }));
  }
  const found: { field: TraceField; problem: string }[] = [];
  for (const field of present) {
    const unstorable = badString(message.value[field]);
    if (unstorable) found.push({ field, problem: `${field}: ${unstorable}` });
  }
  if (
    lots?.length === 0 &&
    typeof operator === 'string' &&
    !found.some((f) => f.field === 'operator')
  ) {
    found.push({
      field: 'operator',
      problem: 'operator on a cycle that consumed nothing (no cycle start is known)',
    });
  }
  return found;
}

const rejected = (reason: RejectReason, detail: string): Classified => ({
  kind: 'rejected',
  reason,
  detail,
});

/**
 * Validates one delivery with `parseUnsMessage` and checks it against its topic. Anything that
 * fails is `rejected` with a reason; nothing is dropped silently. `retained` is the retain flag
 * on delivery: retained copies restore current state and are never facts (ADR-0015).
 */
export function classify(topic: string, text: string, retained: boolean): Classified {
  const info = topicInfo(topic);
  if (typeof info === 'string') return rejected('unexpected-topic', info);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return rejected('invalid-json', error instanceof Error ? error.message : String(error));
  }
  if (info.type === 'command-result') return commandResult(topic, json, retained, info.equipment);
  let parsed = parseUnsMessage(json);
  // A cycle whose only fault is in its trace fields is kept without them (#197): the cycle is a
  // fact in the device sequence, which must not get a gap over lots or an operator.
  const dropped: string[] = [];
  if (!parsed.ok && info.type === 'equipment' && info.expected === 'uns.events.cycle-complete/1') {
    const stripped = withoutBadTraceFields(json);
    const again = stripped && parseUnsMessage(stripped.json);
    if (stripped && again?.ok) {
      parsed = again;
      dropped.push(...stripped.problems);
    }
  }
  if (!parsed.ok) return rejected('invalid-payload', parsed.error);
  let message: UnsMessage = parsed.message;
  if (message.schema === 'uns.events.cycle-complete/1' && !retained) {
    const problems = cycleTraceProblems(message);
    if (problems.length > 0) {
      const drop = new Set<string>(problems.map((p) => p.field));
      const value = Object.fromEntries(
        Object.entries(message.value).filter(([key]) => !drop.has(key)),
      ) as CycleComplete['value'];
      message = { ...message, value };
      dropped.push(...problems.map((p) => p.problem));
    }
  }
  const unstorable = storableProblem(message);
  if (unstorable) return rejected('invalid-payload', unstorable);
  if (message.schema !== info.expected) {
    return rejected('topic-mismatch', `schema ${message.schema} on a topic for ${info.expected}`);
  }
  if (info.type === 'sys') {
    if (message.source.id !== info.instance) {
      return rejected('topic-mismatch', `source ${message.source.id} on ${info.instance}'s topic`);
    }
    if (message.schema === 'uns.sys.status/1') {
      return { kind: 'status', component: info.component, instance: info.instance, message };
    }
    if (message.schema !== 'uns.sys.incident/1') throw new Error('unreachable');
    if (retained) return { kind: 'retained', detail: 'retained incident' };
    return {
      kind: 'incident',
      stream: streamKey(topic, message),
      instance: info.instance,
      message,
    };
  }
  const { equipment } = info;
  if (message.source.id !== equipment) {
    return rejected('topic-mismatch', `source ${message.source.id} on ${equipment}'s topic`);
  }
  switch (message.schema) {
    case 'uns.state.current/1':
      if (retained || message.kind === 'snapshot') return { kind: 'anchor', equipment, message };
      return {
        kind: 'event',
        stream: streamKey(topic, message),
        equipment,
        eventType: 'state',
        message,
      };
    case 'uns.telemetry/1':
      if (retained) return { kind: 'retained', detail: 'retained telemetry' };
      return {
        kind: 'telemetry',
        stream: streamKey(topic, message),
        equipment,
        name: info.name,
        message,
      };
    case 'uns.events.cycle-complete/1':
      if (retained) return { kind: 'retained', detail: 'retained cycle' };
      return {
        kind: 'event',
        stream: streamKey(topic, message),
        equipment,
        eventType: 'cycle',
        message,
        ...(dropped.length > 0
          ? { traceDropped: { detail: dropped.join('; '), payload: text } }
          : {}),
      };
    case 'uns.alarms/1':
      if (unsName(message.value.code) !== info.name) {
        return rejected('topic-mismatch', `alarm ${message.value.code} on alarms/${info.name}`);
      }
      if (retained) return { kind: 'alarm-anchor', equipment, message };
      return {
        kind: 'event',
        stream: streamKey(topic, message),
        equipment,
        eventType: 'alarm',
        message,
      };
    case 'uns.alarm-snapshot/1':
      return { kind: 'alarm-snapshot', equipment, message };
    case 'uns.events.job/1':
      if (retained) return { kind: 'retained', detail: 'retained job fact' };
      return {
        kind: 'event',
        stream: streamKey(topic, message),
        equipment,
        eventType: 'job',
        message,
      };
    case 'uns.sys.status/1':
    case 'uns.sys.incident/1':
      throw new Error('unreachable: checked against the topic above');
  }
}

/** A `cmd-res` delivery (#174): `uns.cmd-res/1` from the equipment its topic names. */
function commandResult(
  topic: string,
  json: unknown,
  retained: boolean,
  equipment: string,
): Classified {
  const parsed = parseUnsCommandMessage(json);
  if (!parsed.ok) return rejected('invalid-payload', parsed.error);
  const message = parsed.message;
  if (message.schema !== 'uns.cmd-res/1') {
    return rejected('topic-mismatch', `schema ${message.schema} on a topic for uns.cmd-res/1`);
  }
  const unstorable = storableProblem(message);
  if (unstorable) return rejected('invalid-payload', unstorable);
  if (message.source.id !== equipment) {
    return rejected('topic-mismatch', `source ${message.source.id} on ${equipment}'s topic`);
  }
  if (retained) return { kind: 'retained', detail: 'retained command result' };
  return { kind: 'command-result', stream: streamKey(topic, message), equipment, message };
}
