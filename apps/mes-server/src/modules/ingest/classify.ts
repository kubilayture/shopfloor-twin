import {
  ALARM_SNAPSHOT_NAME,
  SYS_SEGMENT,
  UNS_ROOT,
  parseEquipmentTopic,
  parseUnsMessage,
  streamKey,
  unsName,
  type Alarm,
  type AlarmSnapshot,
  type CycleComplete,
  type Incident,
  type StateCurrent,
  type Status,
  type Telemetry,
  type UnsMessage,
  type UnsSchemaName,
} from '@shopfloor/contracts';
import type { RejectReason } from './tables.ts';

export type StateEvent = Extract<StateCurrent, { kind: 'event' }>;

/** What one delivery is, after validation against its topic (docs/contracts/uns.md). */
export type Classified =
  | { readonly kind: 'rejected'; readonly reason: RejectReason; readonly detail: string }
  | {
      readonly kind: 'event';
      readonly stream: string;
      readonly equipment: string;
      readonly eventType: 'state' | 'cycle' | 'alarm';
      readonly message: StateEvent | CycleComplete | Alarm;
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
        // Job facts (`events/job`, UNS contract 1.3) are published by the gateway from #173 but
        // ingested only from #174 (ADR-0017 note there); until then they are refused here.
        return name === 'cycle-complete'
          ? { type: 'equipment', equipment, name, expected: 'uns.events.cycle-complete/1' }
          : `no event topic "${name}" (only events/cycle-complete)`;
      case 'alarms':
        return name === ALARM_SNAPSHOT_NAME
          ? { type: 'equipment', equipment, name, expected: 'uns.alarm-snapshot/1' }
          : { type: 'equipment', equipment, name, expected: 'uns.alarms/1' };
      case 'cmd':
      case 'cmd-res':
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
function storableProblem(message: UnsMessage): string | undefined {
  const times: [string, string][] = [
    ['sourceTime', message.sourceTime],
    ['receivedAt', message.receivedAt],
  ];
  if (message.schema === 'uns.sys.status/1') times.push(['startedAt', message.value.startedAt]);
  for (const [field, time] of times) {
    const ms = Date.parse(time);
    if (!(ms >= TIME_RANGE.from && ms < TIME_RANGE.to)) {
      return `${field} ${time} is outside the years 1970 to 2199`;
    }
  }
  return badString(message);
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
  const parsed = parseUnsMessage(json);
  if (!parsed.ok) return rejected('invalid-payload', parsed.error);
  const message: UnsMessage = parsed.message;
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
    case 'uns.sys.status/1':
    case 'uns.sys.incident/1':
      throw new Error('unreachable: checked against the topic above');
  }
}
