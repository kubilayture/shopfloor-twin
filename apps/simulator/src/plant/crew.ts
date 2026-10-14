import type { PlantConfig } from '@shopfloor/plant-config';
import { bernoulli, type RandomSource, type RandomStream } from '@shopfloor/sim-core';

export interface Assignment {
  readonly operatorId: string;
  readonly speedFactor: number;
}

export interface ShiftCrew {
  readonly present: readonly string[];
  readonly absent: readonly string[];
  readonly assignments: ReadonlyMap<string, Assignment | undefined>;
}

type Operator = PlantConfig['operators']['operators'][number];

type RosterEntry = Operator & { readonly absence: RandomStream };

export class Crew {
  readonly #operators: readonly RosterEntry[];
  readonly #absenceProbability: number;
  readonly #stations: readonly string[];

  constructor(config: PlantConfig, random: RandomSource) {
    this.#operators = config.operators.operators.map((operator) => ({
      ...operator,
      absence: random.stream(`operators/${operator.id}/absence`),
    }));
    this.#absenceProbability = config.operators.absenceProbabilityPerShift;
    this.#stations = config.plant.areas
      .flatMap((a) => a.workCenters.flatMap((w) => w.equipment))
      .filter((item) => item.requiresOperator)
      .map((item) => item.id);
  }

  get stations(): readonly string[] {
    return this.#stations;
  }

  forShift(shiftId: string): ShiftCrew {
    const present: RosterEntry[] = [];
    const absent: string[] = [];
    for (const operator of this.#operators.filter((op) => op.shift === shiftId)) {
      if (bernoulli(operator.absence, this.#absenceProbability)) {
        absent.push(operator.id);
      } else {
        present.push(operator);
      }
    }
    const taken = new Set<string>();
    const assignments = new Map<string, Assignment | undefined>();
    for (const station of this.#stations) {
      const operator = present.find((op) => !taken.has(op.id) && op.skills.includes(station));
      if (operator) {
        taken.add(operator.id);
      }
      assignments.set(
        station,
        operator && { operatorId: operator.id, speedFactor: operator.speedFactor },
      );
    }
    return { present: present.map((op) => op.id), absent, assignments };
  }
}
