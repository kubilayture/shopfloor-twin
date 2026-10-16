export const UNS_ROOT = 'orbis/gebze';

export const UNS_CLASSES = [
  'state',
  'telemetry',
  'events',
  'alarms',
  'cmd',
  'cmd-res',
  'mes',
] as const;

export type UnsClass = (typeof UNS_CLASSES)[number];

export interface EquipmentTopic {
  area: string;
  workCenter: string;
  equipment: string;
  topicClass: UnsClass;
  name: string;
}

const SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The one name that isn't kebab-case: the gateway's alarm snapshot (`…/alarms/_snapshot`, #141).
 * The underscore keeps it apart from every alarm code's topic name.
 */
export const ALARM_SNAPSHOT_NAME = '_snapshot';

export function equipmentTopic(topic: EquipmentTopic): string {
  const segments = [topic.area, topic.workCenter, topic.equipment, topic.topicClass, topic.name];
  for (const [index, segment] of segments.entries()) {
    const snapshotName =
      index === 4 && topic.topicClass === 'alarms' && segment === ALARM_SNAPSHOT_NAME;
    if (!SEGMENT.test(segment) && !snapshotName) {
      throw new RangeError(`Invalid UNS topic segment: "${segment}"`);
    }
  }
  return [UNS_ROOT, ...segments].join('/');
}
