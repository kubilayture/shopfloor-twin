/**
 * The genealogy module's pure rules (#199, Phase 8 plan "Genealogy", ADR-0034): a unit's trace
 * records and lot links from its operation records and cycle facts, the BOM check, cartons placed
 * on final data by `trace-core`'s packing rule, and the finality of an answer.
 */
import { packCartons, type Carton, type Pack } from '@shopfloor/trace-core';
import type { StoredMeasurement } from './tables.ts';

export interface LotRef {
  readonly material: string;
  readonly lot: string;
}

/** What genealogy reads of a cycle fact (ingest's `CycleFact`). */
export interface TraceFact {
  readonly equipment: string;
  readonly seq: number;
  /** Undefined when the fact didn't carry the field (UNS 1.4: absent, `[]` and a value differ). */
  readonly lots?: readonly LotRef[];
  readonly operator?: string | null;
  /** Null or absent when the cycle measured nothing. */
  readonly measurement?: StoredMeasurement | null;
}

/** An operation record of a unit as the execution module has it. */
export interface UnitOperation {
  readonly operation: string;
  readonly equipment: string;
  readonly pass: number;
  readonly at: Date;
  readonly result: 'good' | 'scrap' | 'rework';
  readonly reason: string | null;
  readonly seq: number;
}

/** A record with what its fact reported for traceability. */
export interface TracedRecord extends UnitOperation {
  /** Null when the fact carried no `lots` field. */
  readonly lots: readonly LotRef[] | null;
  readonly operator: string | null;
  readonly operatorReported: boolean;
  readonly measurement: StoredMeasurement | null;
}

/** One `lot-unit` edge: a lot reference of a record, with its place in the fact's list. */
export interface LotLink {
  readonly lot: string;
  readonly material: string;
  readonly operation: string;
  readonly pass: number;
  readonly equipment: string;
  readonly seq: number;
  readonly position: number;
  readonly at: Date;
}

/**
 * A unit's records with their facts' trace fields, and its lot links. A record whose fact is not
 * in `facts` (it can't be: execution builds records from these facts) reports nothing.
 */
export function traceUnit(
  records: readonly UnitOperation[],
  facts: readonly TraceFact[],
): { records: TracedRecord[]; links: LotLink[] } {
  const byKey = new Map(facts.map((f) => [`${f.equipment}\u0000${String(f.seq)}`, f]));
  const traced: TracedRecord[] = [];
  const links: LotLink[] = [];
  for (const record of records) {
    const fact = byKey.get(`${record.equipment}\u0000${String(record.seq)}`);
    const lots = fact?.lots === undefined ? null : fact.lots.map((l) => ({ ...l }));
    traced.push({
      ...record,
      lots,
      operator: fact?.operator ?? null,
      operatorReported: fact?.operator !== undefined,
      measurement: fact?.measurement ?? null,
    });
    (lots ?? []).forEach((ref, position) => {
      links.push({
        lot: ref.lot,
        material: ref.material,
        operation: record.operation,
        pass: record.pass,
        equipment: record.equipment,
        seq: record.seq,
        position,
        at: record.at,
      });
    });
  }
  return { records: traced, links };
}

/** A BOM line (`orders` BOM or the product's from master data). */
export interface BomLine {
  readonly material: string;
  readonly operation: string;
  readonly usage: 'standard' | 'rework';
}

/** Why a lot link doesn't fit: its material against the BOM, or against the imported lot. */
export interface Mismatch {
  readonly link: LotLink;
  readonly message: string;
}

/**
 * The links whose material the BOM doesn't list for that operation and pass (standard lines on a
 * first pass, rework lines on a later one, as execution backflushes, ADR-0031), or whose lot the
 * ERP lists with another material.
 */
export function mismatches(
  links: readonly LotLink[],
  bom: readonly BomLine[],
  lotMaterial: (lot: string) => string | undefined,
): Mismatch[] {
  const found: Mismatch[] = [];
  for (const link of links) {
    const usage = link.pass === 1 ? 'standard' : 'rework';
    const allowed = bom
      .filter((b) => b.operation === link.operation && b.usage === usage)
      .map((b) => b.material);
    const listed = lotMaterial(link.lot);
    if (!allowed.includes(link.material)) {
      found.push({
        link,
        message: `${link.material} (lot ${link.lot}) is not a ${usage} material of ${link.operation} (BOM: ${allowed.join(', ') || 'none'})`,
      });
    } else if (listed !== undefined && listed !== link.material) {
      found.push({
        link,
        message: `lot ${link.lot} was reported as ${link.material} but the ERP lists it as ${listed}`,
      });
    }
  }
  return found;
}

/** A good packing cycle and whether its machine is final through it (ADR-0018). */
export interface PlacedPack extends Pack {
  readonly final: boolean;
}

/** The packing rule's order (trace-core's): plant time, then epoch, sequence and part. */
const comparePacks = (a: Pack, b: Pack): number =>
  a.at - b.at || a.unit.epoch - b.unit.epoch || a.seq - b.seq || a.unit.partId - b.unit.partId;

/**
 * An order's cartons on final data (plan "Cartons"): its packs in the packing rule's order up to
 * the first one not final yet are placed (a late earlier pack would shift every later unit by one
 * place); the last carton closes at the order's completion only once every pack is placed.
 * Returns the cartons and whether every pack was placed.
 */
export function placeCartons(
  order: {
    readonly orderId: string;
    readonly product: string;
    readonly completedAt: number | null;
  },
  packs: readonly PlacedPack[],
  capacity: Readonly<Record<string, number>>,
): { cartons: Carton[]; placed: number; complete: boolean } {
  const sorted = [...packs].sort(comparePacks);
  const pending = sorted.findIndex((p) => !p.final);
  const placed = pending < 0 ? sorted : sorted.slice(0, pending);
  const complete = pending < 0;
  const cartons = packCartons(
    [{ ...order, completedAt: complete ? order.completedAt : null }],
    placed.map(({ unit, orderId, at, seq }) => ({ unit, orderId, at, seq })),
    capacity,
  );
  return { cartons, placed: placed.length, complete };
}

/** A machine's progress as finality reads it (`DeviceProgress`). */
export interface Progress {
  readonly epoch: number | null;
  readonly settledSeq: number | null;
  readonly settledTime: Date | null;
}

/**
 * Whether an answer is final (plan "Trace queries"): per device epoch of its records, every
 * machine of the routing has a newer epoch, or is final through the epoch's latest record (its
 * processed final-through time at or after it). Returns the machines that are not.
 */
export function finality(
  records: readonly { readonly epoch: number; readonly at: Date }[],
  machines: readonly string[],
  progress: (machine: string) => Progress | undefined,
): { final: boolean; notFinal: string[] } {
  const latest = new Map<number, number>();
  for (const r of records) {
    latest.set(r.epoch, Math.max(latest.get(r.epoch) ?? Number.NEGATIVE_INFINITY, r.at.getTime()));
  }
  const notFinal = new Set<string>();
  for (const [epoch, at] of latest) {
    for (const machine of machines) {
      const device = progress(machine);
      const final =
        device !== undefined &&
        device.epoch !== null &&
        (device.epoch > epoch ||
          (device.epoch === epoch &&
            device.settledTime !== null &&
            device.settledTime.getTime() >= at));
      if (!final) notFinal.add(machine);
    }
  }
  const list = [...notFinal].sort();
  return { final: list.length === 0, notFinal: list };
}

/** Whether a fact is at or below a machine's final-through (ADR-0018). */
export function finalThrough(
  device: Progress | undefined,
  fact: { readonly epoch: number; readonly seq: number },
): boolean {
  if (device?.epoch === null || device?.epoch === undefined) return false;
  if (device.epoch > fact.epoch) return true;
  return device.epoch === fact.epoch && device.settledSeq !== null && device.settledSeq >= fact.seq;
}

export type { Carton };
