import type { PlantConfig } from '@shopfloor/plant-config';
import { MINUTE, SECOND, hashedStandardNormal, type SimTime } from '@shopfloor/sim-core';
import type { PlantEvent } from './line.ts';
import type { MachineState } from './machine-state.ts';

type ProcessValuesConfig = PlantConfig['process']['processValues'];

export interface ProcessValueReading {
  readonly spindleLoadPercent: number;
  readonly coolantCelsius: number;
}

interface MachineTrack {
  state: MachineState;
  anchorAt: SimTime;
  anchorCelsius: number;
}

const roundTo = (value: number, resolution: number): number => {
  const decimals = Math.max(0, Math.ceil(-Math.log10(resolution) - 1e-9));
  return Number((Math.round(value / resolution) * resolution).toFixed(decimals));
};

export class ProcessValues {
  readonly #config: ProcessValuesConfig;
  readonly #seed: number;
  readonly #machines = new Map<string, MachineTrack>();

  constructor(config: ProcessValuesConfig, seed: number, startTime: SimTime) {
    this.#config = config;
    this.#seed = seed;
    for (const machine of config.machines) {
      this.#machines.set(machine, {
        state: 'Off',
        anchorAt: startTime,
        anchorCelsius: config.coolant.ambientCelsius,
      });
    }
  }

  get machines(): readonly string[] {
    return this.#config.machines;
  }

  record(event: PlantEvent): void {
    if (event.type !== 'state') {
      return;
    }
    const track = this.#machines.get(event.machineId);
    if (!track) {
      return;
    }
    track.anchorCelsius = this.#coolantAt(track, event.at);
    track.anchorAt = event.at;
    track.state = event.to;
  }

  read(machineId: string, now: SimTime): ProcessValueReading | undefined {
    const track = this.#machines.get(machineId);
    if (!track) {
      return undefined;
    }
    if (now < track.anchorAt) {
      throw new RangeError(`${machineId}: cannot read process values before the last state change`);
    }
    const { spindleLoad, coolant } = this.#config;
    const second = Math.floor(now / SECOND);
    const load =
      track.state === 'Running'
        ? spindleLoad.meanPercent +
          spindleLoad.sigmaPercent *
            hashedStandardNormal(this.#seed, `${machineId}/spindle-load`, second)
        : 0;
    return {
      spindleLoadPercent: roundTo(Math.min(100, Math.max(0, load)), spindleLoad.resolution),
      coolantCelsius: roundTo(this.#coolantAt(track, now), coolant.resolution),
    };
  }

  #coolantAt(track: MachineTrack, at: SimTime): number {
    const { coolant } = this.#config;
    const target = track.state === 'Running' ? coolant.runningCelsius : coolant.ambientCelsius;
    const elapsed = at - track.anchorAt;
    return (
      target + (track.anchorCelsius - target) * Math.exp(-elapsed / (coolant.tauMinutes * MINUTE))
    );
  }
}
