/**
 * Scopes and priorities (ADR-0024). Until operators log in (Phase 7), an operator position is a
 * configured set of work centers; the plant is every position together.
 */
import type { Occurrence, Priority } from './occurrences.ts';

export interface Position {
  readonly id: string;
  /** The equipment of the position's work centers. */
  readonly equipment: readonly string[];
}

/** The occurrences of the plant (`plant`) and of each position, keyed by scope id. */
export function scopeOccurrences<T extends Pick<Occurrence, 'equipment'>>(
  occurrences: readonly T[],
  positions: readonly Position[],
): Map<string, T[]> {
  const scopes = new Map<string, T[]>([['plant', [...occurrences]]]);
  for (const position of positions) {
    if (position.id === 'plant') {
      throw new RangeError('"plant" is the scope of every position, not a position id');
    }
    const equipment = new Set(position.equipment);
    scopes.set(
      position.id,
      occurrences.filter((occurrence) => equipment.has(occurrence.equipment)),
    );
  }
  return scopes;
}

/**
 * The priority of a code without a definition (another device, new firmware), from its wire
 * severity 1–1000: at least 667 high, at least 334 medium, else low.
 */
export function priorityFromSeverity(severity: number): Priority {
  if (!Number.isSafeInteger(severity) || severity < 1 || severity > 1000) {
    throw new RangeError(`severity must be an integer 1–1000, got ${String(severity)}`);
  }
  return severity >= 667 ? 'high' : severity >= 334 ? 'medium' : 'low';
}
