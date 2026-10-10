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

export function equipmentTopic(topic: EquipmentTopic): string {
  const segments = [topic.area, topic.workCenter, topic.equipment, topic.topicClass, topic.name];
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) {
      throw new RangeError(`Invalid UNS topic segment: "${segment}"`);
    }
  }
  return [UNS_ROOT, ...segments].join('/');
}
