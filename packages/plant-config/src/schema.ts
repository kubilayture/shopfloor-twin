import { z } from 'zod';
import { alarmsSchema } from './alarms.ts';
import { reasonsSchema } from './reasons.ts';

const id = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lower-case kebab-case id');
const code = z.string().regex(/^[A-Z0-9]+(-[A-Z0-9]+)*$/, 'upper-case code');
const operation = z.string().regex(/^OP\d{2}$/, 'operation like OP10');
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time of day as HH:MM');
const positive = z.number().positive();
const probability = z.number().min(0).max(1);

const equipment = z.strictObject({
  id,
  name: z.string().min(1),
  operation,
  interface: z.enum(['opcua', 'modbus']),
  requiresOperator: z.boolean().default(false),
});

export const plantSchema = z.strictObject({
  enterprise: z.strictObject({ id, name: z.string().min(1) }),
  site: z.strictObject({ id, name: z.string().min(1) }),
  areas: z
    .array(
      z.strictObject({
        id,
        name: z.string().min(1),
        workCenters: z
          .array(
            z.strictObject({ id, name: z.string().min(1), equipment: z.array(equipment).min(1) }),
          )
          .min(1),
      }),
    )
    .min(1),
  buffers: z.array(
    z.strictObject({ from: operation, to: operation, capacity: z.number().int().positive() }),
  ),
  maintenanceTechnicians: z.number().int().nonnegative(),
});

export const productsSchema = z.strictObject({
  operations: z.array(operation).min(1),
  changeoverMinutes: positive,
  componentsOperation: operation,
  products: z
    .array(
      z.strictObject({
        id: code,
        name: z.string().min(1),
        blank: code,
        idealCycleSeconds: z.record(operation, positive),
        components: z.array(code),
        reworkComponents: z.array(code).default([]),
      }),
    )
    .min(1),
});

export const shiftsSchema = z.strictObject({
  timeZone: z.string().min(1),
  workdays: z
    .array(z.enum(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']))
    .min(1),
  shifts: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Z]$/, 'single capital letter'),
        start: clockTime,
        end: clockTime,
        break: z
          .strictObject({ start: clockTime, minutes: z.number().int().positive() })
          .optional(),
      }),
    )
    .min(1),
});

export const operatorsSchema = z.strictObject({
  operators: z.array(
    z.strictObject({
      id,
      shift: z.string(),
      skills: z.array(id).min(1),
      speedFactor: positive,
    }),
  ),
  absenceProbabilityPerShift: probability,
});

const failureMode = z.strictObject({
  code,
  weibullShape: positive,
  weibullScaleHours: positive,
  repairMedianMinutes: positive,
  repairSpread: positive,
});

export const failuresSchema = z.strictObject({
  equipment: z.record(
    id,
    z.strictObject({
      failureModes: z.array(failureMode),
      minorStops: z.strictObject({
        ratePerHour: z.number().nonnegative(),
        meanSeconds: positive,
        causes: z.array(code).min(1),
      }),
    }),
  ),
});

const processValues = z.strictObject({
  machines: z.array(id).min(1),
  spindleLoad: z.strictObject({
    meanPercent: positive.max(100),
    sigmaPercent: positive,
    resolution: positive,
  }),
  coolant: z.strictObject({
    ambientCelsius: z.number(),
    runningCelsius: z.number(),
    tauMinutes: positive,
    resolution: positive,
  }),
  washer: z.strictObject({
    machine: id,
    bath: z.strictObject({
      setpointCelsius: z.number(),
      ambientCelsius: z.number(),
      heatTauMinutes: positive,
      coolTauMinutes: positive,
      sigmaCelsius: z.number().nonnegative(),
      resolution: positive,
    }),
    conveyor: z.strictObject({
      metresPerMinute: positive,
      sigma: z.number().nonnegative(),
      resolution: positive,
    }),
    heaterFaultCode: code,
  }),
});

export const processSchema = z.strictObject({
  cycleTimeCv: z.record(operation, z.number().nonnegative()),
  tool: z.strictObject({
    lifeCycles: z.number().int().positive(),
    changeMinutes: positive,
    defectProbability: z.array(z.strictObject({ wear: probability, probability })).min(2),
  }),
  leakTest: z.strictObject({
    operation,
    reworkOperation: operation,
    unit: z.string().min(1),
    resolution: positive,
    mean: positive,
    sigma: positive,
    upperLimit: positive,
    driftPerDay: z.number(),
    calibrationIntervalDays: positive,
    calibrationMinutes: positive,
  }),
  processValues,
});

export const stockSchema = z.strictObject({
  lots: z.array(
    z.strictObject({ id: code, material: code, quantity: z.number().int().nonnegative() }),
  ),
});

export const scheduleSchema = z.strictObject({
  machines: z.record(
    id,
    z.array(z.strictObject({ product: code, quantity: z.number().int().positive() })).min(1),
  ),
});

/**
 * OEE configuration (ADR-0021): the micro-stop threshold and the scheduled-time rule. It is not a
 * simulation input, so the simulator's run header does not hash it (see `SIMULATION_FILES`).
 */
export const oeeSchema = z.strictObject({
  microStopThresholdMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /**
   * `shift-calendar` (Phases 1–6): every shift in the calendar is scheduled. `orders` (Phase 7,
   * #172): as `shift-calendar`, except that an `Idle` interval with cause `NO-ORDER` is excluded
   * from planned busy time (ADR-0021 amendment).
   */
  scheduledTime: z.enum(['shift-calendar', 'orders']),
});

/** The files the simulation reads. The run header's `configSha256` hashes exactly these. */
export const SIMULATION_FILES = {
  plant: plantSchema,
  products: productsSchema,
  shifts: shiftsSchema,
  operators: operatorsSchema,
  failures: failuresSchema,
  process: processSchema,
  stock: stockSchema,
  schedule: scheduleSchema,
} as const;

/** Every file of `config/plant`: the simulation files plus the files only the analysis reads. */
export const PLANT_FILES = {
  ...SIMULATION_FILES,
  oee: oeeSchema,
  reasons: reasonsSchema,
  alarms: alarmsSchema,
} as const;

export type PlantFiles = typeof PLANT_FILES;

export type PlantConfig = { [K in keyof PlantFiles]: z.infer<PlantFiles[K]> };

export type SimulationSection = keyof typeof SIMULATION_FILES;

export type SimulationConfig = Pick<PlantConfig, SimulationSection>;

/**
 * Ideal cycle times in integer milliseconds per product and operation, as `oee-core` takes them.
 * Exact: the cross-check refuses values with more than three decimals of a second.
 */
export function idealCycleMs(config: PlantConfig): Record<string, Record<string, number>> {
  return Object.fromEntries(
    config.products.products.map((product) => [
      product.id,
      Object.fromEntries(
        Object.entries(product.idealCycleSeconds).map(([op, s]) => [op, Math.round(s * 1000)]),
      ),
    ]),
  );
}

/** Only the simulation sections of a configuration: what the simulator's config hash covers. */
export function simulationSections(config: PlantConfig): SimulationConfig {
  const sections = Object.keys(SIMULATION_FILES) as SimulationSection[];
  return Object.fromEntries(sections.map((key) => [key, config[key]])) as SimulationConfig;
}
