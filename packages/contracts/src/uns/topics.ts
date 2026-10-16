import {
  ALARM_SNAPSHOT_NAME,
  UNS_CLASSES,
  UNS_ROOT,
  equipmentTopic,
  type EquipmentTopic,
  type UnsClass,
} from '../uns-topic.ts';

/** Classes whose last message the broker keeps for new subscribers (plan section 5). */
export const RETAINED_CLASSES: ReadonlySet<UnsClass> = new Set([
  'state',
  'telemetry',
  'alarms',
  'mes',
]);

export const isRetained = (topicClass: UnsClass): boolean => RETAINED_CLASSES.has(topicClass);

export const SYS_SEGMENT = '_sys';

export type SysName = 'status' | 'incidents';

const SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `orbis/gebze/_sys/{component}/{instance}/{name}`: component health and data-quality incidents. */
export function sysTopic(component: string, instance: string, name: SysName): string {
  for (const segment of [component, instance]) {
    if (!SEGMENT.test(segment)) {
      throw new RangeError(`Invalid UNS topic segment: "${segment}"`);
    }
  }
  return [UNS_ROOT, SYS_SEGMENT, component, instance, name].join('/');
}

/** Status is retained (with the last will "offline"); incidents are not. */
export const isSysRetained = (name: SysName): boolean => name === 'status';

/** UNS names are kebab-case: `SPINDLE-OVERLOAD` → `spindle-overload`. */
export const unsName = (code: string): string => code.toLowerCase();

export interface EquipmentPath {
  readonly area: string;
  readonly workCenter: string;
  readonly equipment: string;
}

export const stateTopic = (at: EquipmentPath): string =>
  equipmentTopic({ ...at, topicClass: 'state', name: 'current' });

export const telemetryTopic = (at: EquipmentPath, name: string): string =>
  equipmentTopic({ ...at, topicClass: 'telemetry', name });

export const cycleTopic = (at: EquipmentPath): string =>
  equipmentTopic({ ...at, topicClass: 'events', name: 'cycle-complete' });

export const alarmTopic = (at: EquipmentPath, code: string): string =>
  equipmentTopic({ ...at, topicClass: 'alarms', name: unsName(code) });

/** The gateway's alarm snapshot of one equipment (`uns.alarm-snapshot/1`, retained, #141). */
export const alarmSnapshotTopic = (at: EquipmentPath): string =>
  equipmentTopic({ ...at, topicClass: 'alarms', name: ALARM_SNAPSHOT_NAME });

export interface ParsedTopic extends EquipmentTopic {
  readonly topic: string;
}

/** The inverse of `equipmentTopic`; undefined for anything else (including `_sys`). */
export function parseEquipmentTopic(topic: string): ParsedTopic | undefined {
  const prefix = `${UNS_ROOT}/`;
  if (!topic.startsWith(prefix)) return undefined;
  const parts = topic.slice(prefix.length).split('/');
  if (parts.length !== 5 || parts[0] === SYS_SEGMENT) return undefined;
  if (!(UNS_CLASSES as readonly string[]).includes(parts[3] ?? '')) return undefined;
  const [area = '', workCenter = '', equipment = '', topicClass = '', name = ''] = parts;
  try {
    if (
      equipmentTopic({ area, workCenter, equipment, topicClass: topicClass as UnsClass, name }) !==
      topic
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { topic, area, workCenter, equipment, topicClass: topicClass as UnsClass, name };
}
