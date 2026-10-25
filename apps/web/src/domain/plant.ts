import type { EquipmentDto } from '@shopfloor/contracts/mes-api';

export interface WorkCenterGroup {
  readonly id: string;
  readonly name: string;
  readonly equipment: EquipmentDto[];
}

export interface AreaGroup {
  readonly id: string;
  readonly name: string;
  readonly workCenters: WorkCenterGroup[];
}

/** Equipment by area and work center, each in line order (`position`). */
export function groupEquipment(equipment: readonly EquipmentDto[]): AreaGroup[] {
  const areas = new Map<string, { name: string; centers: Map<string, WorkCenterGroup> }>();
  for (const item of [...equipment].sort((a, b) => a.position - b.position)) {
    let area = areas.get(item.area.id);
    if (!area) {
      area = { name: item.area.name, centers: new Map() };
      areas.set(item.area.id, area);
    }
    let center = area.centers.get(item.workCenter.id);
    if (!center) {
      center = { id: item.workCenter.id, name: item.workCenter.name, equipment: [] };
      area.centers.set(item.workCenter.id, center);
    }
    center.equipment.push(item);
  }
  return [...areas].map(([id, area]) => ({
    id,
    name: area.name,
    workCenters: [...area.centers.values()],
  }));
}

/**
 * A code of the plant model as words (design system 6.4, names before codes): `NO-ORDER` is
 * "No order", `coolant-temperature` "Coolant temperature". The plant model's codes are English
 * words joined by hyphens, and the API carries no display names for them, so the words are made
 * from the code; screens show the code beside them in `ink-secondary` monospace.
 */
export function codeWords(code: string): string {
  const words = code.trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The cause vocabulary's parameterised forms (docs/simulation-model.md "Causes"). */
const MATERIAL_PREFIX = 'MATERIAL:';
const CHANGEOVER_PREFIX = 'CHANGEOVER ';

/**
 * A state's cause as words (O-02): `NO-ORDER` is "No order", `MATERIAL:BLANK-VB` "Material
 * missing: BLANK-VB", `CHANGEOVER none→VB-100` "Changeover from none to VB-100". Material and
 * product ids stay as they are: they are identifiers, not words.
 */
export function causeWords(cause: string): string {
  if (cause.startsWith(MATERIAL_PREFIX)) {
    return `Material missing: ${cause.slice(MATERIAL_PREFIX.length)}`;
  }
  if (cause.startsWith(CHANGEOVER_PREFIX)) {
    const [from, to] = cause.slice(CHANGEOVER_PREFIX.length).split('→');
    return to === undefined
      ? `Changeover ${from ?? ''}`.trim()
      : `Changeover from ${from ?? ''} to ${to}`;
  }
  return codeWords(cause);
}

/** A telemetry metric's name (M-02): `coolant-temperature` is "Coolant temperature". */
export function metricName(metric: string): string {
  return codeWords(metric);
}
