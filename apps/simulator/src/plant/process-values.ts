import type { PlantConfig } from '@shopfloor/plant-config';
import { MINUTE, SECOND, hashedStandardNormal, type SimTime } from '@shopfloor/sim-core';
import type { PlantEvent } from './line.ts';
import type { MachineState } from './machine-state.ts';

type ProcessValuesConfig = PlantConfig['process']['processValues'];

export interface ProcessValueReading {
  readonly spindleLoadPercent: number;
  readonly coolantCelsius: number;
}

export interface WasherReading {
  readonly bathCelsius: number;
  /** 0 unless the washer is Running. */
  readonly conveyorMetresPerMinute: number;
  readonly heaterOn: boolean;
}

interface WasherTrack {
  state: MachineState;
  cause: string | undefined;
  anchorAt: SimTime;
  anchorCelsius: number;
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
  readonly #washer: WasherTrack;

  constructor(config: ProcessValuesConfig, seed: number, startTime: SimTime) {
    this.#config = config;
    this.#seed = seed;
    // The bath starts at its setpoint: the heater ran before the simulated week began.
    this.#washer = {
      state: 'Off',
      cause: undefined,
      anchorAt: startTime,
      anchorCelsius: config.washer.bath.setpointCelsius,
    };
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
    if (event.machineId === this.#config.washer.machine) {
      const washer = this.#washer;
      washer.anchorCelsius = this.#bathAt(washer, event.at);
      washer.anchorAt = event.at;
      washer.state = event.to;
      washer.cause = event.cause;
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
      return undefined;
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

  get washerMachine(): string {
    return this.#config.washer.machine;
  }

  /**
   * Bath temperature: a first-order lag towards the setpoint while the heater is on, and towards
   * ambient while it is off (line Off, or the heater has failed). Conveyor speed: constant while
   * Running, 0 otherwise. Noise is a pure function of (seed, quantity, second).
   */
  readWasher(now: SimTime): WasherReading | undefined {
    const washer = this.#washer;
    if (now < washer.anchorAt) {
      return undefined;
    }
    const { bath, conveyor } = this.#config.washer;
    const second = Math.floor(now / SECOND);
    const machine = this.#config.washer.machine;
    const bathCelsius =
      this.#bathAt(washer, now) +
      bath.sigmaCelsius * hashedStandardNormal(this.#seed, `${machine}/bath`, second);
    const speed =
      washer.state === 'Running'
        ? conveyor.metresPerMinute +
          conveyor.sigma * hashedStandardNormal(this.#seed, `${machine}/conveyor`, second)
        : 0;
    return {
      bathCelsius: roundTo(bathCelsius, bath.resolution),
      conveyorMetresPerMinute: roundTo(Math.max(0, speed), conveyor.resolution),
      heaterOn: this.#heaterOn(washer),
    };
  }

  #heaterOn(washer: WasherTrack): boolean {
    const failed = washer.state === 'Down' && washer.cause === this.#config.washer.heaterFaultCode;
    return washer.state !== 'Off' && !failed;
  }

  #bathAt(washer: WasherTrack, at: SimTime): number {
    const { bath } = this.#config.washer;
    const on = this.#heaterOn(washer);
    const target = on ? bath.setpointCelsius : bath.ambientCelsius;
    const tau = (on ? bath.heatTauMinutes : bath.coolTauMinutes) * MINUTE;
    return target + (washer.anchorCelsius - target) * Math.exp(-(at - washer.anchorAt) / tau);
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
