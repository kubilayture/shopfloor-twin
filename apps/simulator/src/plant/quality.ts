import type { PlantConfig } from '@shopfloor/plant-config';
import { normal, type RandomStream, type SimTime } from '@shopfloor/sim-core';

type ToolConfig = PlantConfig['process']['tool'];
type LeakConfig = PlantConfig['process']['leakTest'];

const DAY = 24 * 3_600_000;

export function interpolate(curve: ToolConfig['defectProbability'], wear: number): number {
  const x = Math.min(1, Math.max(0, wear));
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (a && b && x <= b.wear) {
      return a.probability + ((x - a.wear) / (b.wear - a.wear)) * (b.probability - a.probability);
    }
  }
  return curve.at(-1)?.probability ?? 0;
}

export class ToolWear {
  readonly #config: ToolConfig;
  #cycles = 0;

  constructor(config: ToolConfig) {
    this.#config = config;
  }

  get cycles(): number {
    return this.#cycles;
  }

  get needsChange(): boolean {
    return this.#cycles >= this.#config.lifeCycles;
  }

  defectProbability(): number {
    return interpolate(this.#config.defectProbability, this.#cycles / this.#config.lifeCycles);
  }

  recordCycle(): void {
    this.#cycles++;
  }

  change(): void {
    this.#cycles = 0;
  }
}

export interface LeakReading {
  readonly value: number;
  readonly drift: number;
  readonly pass: boolean;
}

export class LeakTester {
  readonly #config: LeakConfig;
  readonly #stream: RandomStream;
  #calibratedAt: SimTime;

  readonly #decimals: number;

  constructor(config: LeakConfig, stream: RandomStream, calibratedAt: SimTime) {
    this.#config = config;
    this.#decimals = Math.max(0, Math.ceil(-Math.log10(config.resolution) - 1e-9));
    this.#stream = stream;
    this.#calibratedAt = calibratedAt;
  }

  get calibratedAt(): SimTime {
    return this.#calibratedAt;
  }

  calibrationDue(now: SimTime): boolean {
    return now - this.#calibratedAt >= this.#config.calibrationIntervalDays * DAY;
  }

  calibrate(now: SimTime): void {
    this.#calibratedAt = now;
  }

  measure(now: SimTime): LeakReading {
    const drift = (this.#config.driftPerDay * (now - this.#calibratedAt)) / DAY;
    const raw = normal(this.#stream, this.#config.mean + drift, this.#config.sigma);
    const steps = Math.round(raw / this.#config.resolution);
    const value = Number((steps * this.#config.resolution).toFixed(this.#decimals));
    return { value, drift, pass: value <= this.#config.upperLimit };
  }
}
