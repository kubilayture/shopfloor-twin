import { z } from 'zod';

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
  products: z
    .array(
      z.strictObject({
        id: code,
        name: z.string().min(1),
        blank: code,
        idealCycleSeconds: z.record(operation, positive),
        components: z.array(code),
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

export const processSchema = z.strictObject({
  cycleTimeCv: z.record(operation, z.number().nonnegative()),
  tool: z.strictObject({
    lifeCycles: z.number().int().positive(),
    changeMinutes: positive,
    defectProbability: z.array(z.strictObject({ wear: probability, probability })).min(2),
  }),
  leakTest: z.strictObject({
    unit: z.string().min(1),
    mean: positive,
    sigma: positive,
    upperLimit: positive,
    driftPerDay: z.number(),
    calibrationIntervalDays: positive,
    calibrationMinutes: positive,
  }),
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

export const PLANT_FILES = {
  plant: plantSchema,
  products: productsSchema,
  shifts: shiftsSchema,
  operators: operatorsSchema,
  failures: failuresSchema,
  process: processSchema,
  stock: stockSchema,
  schedule: scheduleSchema,
} as const;

export type PlantFiles = typeof PLANT_FILES;

export type PlantConfig = { [K in keyof PlantFiles]: z.infer<PlantFiles[K]> };
