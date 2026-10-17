import { z } from 'zod';

// The MES's `quality` API, SPC part (#200, Phase 8 plan "SPC", ADR-0032): the characteristics of
// `quality.yaml`, their measurements, limit versions (version 1 automatic, later ones by a
// quality user), the I-MR and X̄-R charts with every point and subgroup, signal episodes with
// their finality, withdrawal and acknowledgement, and the `quality` push topic. Shared by
// `mes-server`, which serves it, and `web`, which parses it (ADR-0020); `mes-api` re-exports it.

/** A time in a response: ISO 8601 UTC with milliseconds. */
const time = z.iso.datetime();
const int = z.number().int();
const IDENTIFIER = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const QUALITY_LIMITS = {
  /** Characters of a limit write's or an acknowledgement's comment. */
  comment: 500,
  /** Signals one `GET /quality/signals` answers at most (newest first); more sets `truncated`. */
  signals: 500,
  /** Measurements one `GET /quality/characteristics/{id}/measurements` answers at most. */
  measurements: 5_000,
} as const;

/** The charts of a characteristic, as `spc-core` names them. */
export const SPC_CHART_NAMES = ['I', 'MR', 'Xbar', 'R'] as const;
export type SpcChartName = (typeof SPC_CHART_NAMES)[number];

/**
 * A signal episode's status (ADR-0032, plan "Finality and late facts"):
 * - `provisional`: the leak tester is not final through its triggering point yet; a late reading
 *   can still move it (it then disappears, unless acknowledged, or changes);
 * - `final`: the tester is final through its triggering point; only a fact from a written-off gap
 *   can still change it, and then it is `withdrawn`;
 * - `withdrawn`: re-derived away (a final one by a fact from a written-off gap, a provisional one
 *   that was acknowledged); kept with its reason and acknowledgement (orphaned).
 */
export const SIGNAL_STATUSES = ['provisional', 'final', 'withdrawn'] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export const characteristicId = z
  .string()
  .regex(IDENTIFIER)
  .describe('A characteristic id of quality.yaml, e.g. leak-rate');

/**
 * A chart value: `value` in the characteristic's unit (a double, for display), `steps` the exact
 * value in whole steps of the instrument's resolution as a fraction `numerator/denominator`
 * (`oee-core`'s `formatFraction`), what the ground truth compares.
 */
export const spcValueSchema = z.object({
  value: z.number().describe('In the characteristic’s unit'),
  steps: z
    .string()
    .regex(/^-?\d+\/\d+$/)
    .describe('Exact, in resolution steps: numerator/denominator'),
});

export const spcPositionSchema = z
  .object({
    epoch: int.describe('The device epoch of the tester'),
    at: time.describe('Plant time'),
    seq: int.describe('The fact in the tester’s device sequence'),
  })
  .describe('Where a reading sits on the chart: (epoch, plant time, seq), compared in that order');

const limitsSchema = z.object({
  lower: spcValueSchema,
  centre: spcValueSchema,
  upper: spcValueSchema,
});

export const limitVersionSchema = z
  .object({
    version: int.min(1),
    createdAt: time.describe(
      'Plant time it was created; version 1: its baseline window’s last reading (ADR-0032)',
    ),
    createdBy: z.string().describe('`system` for version 1, else the quality user'),
    comment: z.string().nullable(),
    from: spcPositionSchema
      .nullable()
      .describe('The first position it applies to; null: from the first reading (version 1)'),
    until: spcPositionSchema.nullable().describe('The first position it no longer applies to'),
    endedAt: time.nullable().describe('Plant time it was ended; null while open'),
    endedBy: z.string().nullable(),
    window: z
      .object({ from: spcPositionSchema, to: spcPositionSchema })
      .describe('The readings it was estimated from, both ends inclusive'),
    subgroupSize: int,
    counts: z.object({ readings: int, movingRanges: int, subgroups: int }),
    statistics: z
      .object({
        mean: spcValueSchema,
        movingRange: spcValueSchema,
        grandMean: spcValueSchema,
        range: spcValueSchema,
      })
      .describe('X̄, M̄R, X̿ and R̄ of the window'),
    charts: z.object({ I: limitsSchema, MR: limitsSchema, Xbar: limitsSchema, R: limitsSchema }),
    capability: z
      .object({
        sigma: spcValueSchema.describe('σ̂ = R̄/d2'),
        cpu: z.number(),
        cpk: z.number().describe('Equal to Cpu: the specification is one-sided'),
      })
      .nullable()
      .describe('Against the upper specification limit; shown, not reconciled; null when R̄ = 0'),
  })
  .describe('A frozen set of control limits (append-only, never re-derived)');

const readingRef = z.object({
  epoch: int,
  partId: int,
  pass: int,
  at: time,
  seq: int,
});

export const spcSignalSchema = z
  .object({
    id: int,
    characteristic: z.string(),
    chart: z.enum(SPC_CHART_NAMES),
    rule: int.min(1).max(8),
    ruleText: z.string(),
    version: int.describe('The limit version it is judged by'),
    first: readingRef.describe(
      'The triggering point: its reading (I), the later reading (MR), the subgroup’s last (X̄, R)',
    ),
    last: readingRef.describe('The episode’s last triggering point'),
    points: int.describe('Triggering points in it'),
    closedBy: readingRef.nullable().describe('The point that ended it; null while open'),
    baseline: z
      .boolean()
      .describe('Its first point lies in its version’s window: created with the version'),
    status: z.enum(SIGNAL_STATUSES),
    detectedAt: time.describe('Wall time the MES first stored it'),
    detectedPlantAt: time.nullable().describe('The plant clock then'),
    finalAt: time.nullable().describe('Wall time it became final'),
    withdrawnAt: time.nullable(),
    withdrawnReason: z.string().nullable(),
    acknowledged: z
      .object({
        by: z.string(),
        at: time.describe('Wall time'),
        plantAt: time.nullable(),
        comment: z.string(),
      })
      .nullable(),
    orphaned: z.boolean().describe('Acknowledged, then withdrawn'),
    rowVersion: int.min(1).describe('The version an acknowledgement must name'),
  })
  .describe('A signal episode: consecutive points of one chart and run firing one rule');

export const spcSignalListSchema = z.object({
  signals: z.array(spcSignalSchema),
  truncated: z.boolean(),
});

export const characteristicSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    equipment: z.string(),
    operation: z.string(),
    unit: z.string(),
    resolution: z.number().describe('One step, in the unit'),
    upperSpec: z.number().describe('The upper specification limit (process.yaml upperLimit)'),
    subgroupSize: int,
    baselineSubgroups: int,
    rules: z.object({
      I: z.array(int),
      MR: z.array(int),
      Xbar: z.array(int),
      R: z.array(int),
    }),
    version: int.min(1).describe('The version a limit write must name (409 limits-stale)'),
    currentLimits: int.nullable().describe('The highest limit version, null before version 1'),
    baseline: z
      .object({
        needed: int.describe('First-pass readings of the baseline (subgroups × size)'),
        final: int.describe('Final first-pass readings so far'),
      })
      .describe('Version 1 is estimated once the baseline’s readings are final'),
    notice: z
      .object({
        kind: z.literal('baseline-changed'),
        at: time.describe('Wall time'),
        detail: z.string(),
      })
      .nullable()
      .describe(
        'A late reading inside version 1’s window (a written-off gap): version 1 is not re-derived; a quality user decides on a new version',
      ),
    signals: z.object({
      open: int.describe('Not withdrawn and not closed'),
      unacknowledged: int.describe('Not withdrawn and not acknowledged'),
    }),
  })
  .describe('An SPC characteristic (quality.yaml)');

export const characteristicListSchema = z.object({
  characteristics: z.array(characteristicSchema),
});

export const spcPointSchema = z.object({
  partId: int,
  pass: int,
  epoch: int,
  at: time,
  seq: int,
  segment: int.describe('The device epoch’s segment, from 0'),
  value: spcValueSchema,
  version: int.nullable().describe('The limit version judging it; null: not judged'),
  baseline: z.boolean(),
  rules: z.array(int).describe('Enabled rules firing at it'),
  final: z.boolean().describe('The tester is final through it'),
});

export const spcMeasurementSchema = z
  .object({
    epoch: int,
    partId: int,
    pass: int.describe('1 for a part’s first test; a retest after rework 2'),
    at: time,
    seq: int,
    value: z.number().describe('As reported, in the unit'),
    steps: int.describe('In whole resolution steps'),
    upperLimit: z.number(),
    result: z.enum(['good', 'scrap', 'rework']),
    final: z.boolean(),
  })
  .describe('One reading of a characteristic from a cycle fact');

export const spcChartSchema = z
  .object({
    characteristic: characteristicSchema,
    limits: z.array(limitVersionSchema),
    finalThrough: spcPositionSchema
      .nullable()
      .describe('The tester’s final-through in its newest epoch; older epochs are final'),
    readings: z.object({ firstPass: int, retests: int }),
    points: z.object({
      I: z.array(spcPointSchema),
      MR: z.array(spcPointSchema),
      Xbar: z.array(spcPointSchema),
      R: z.array(spcPointSchema),
    }),
    subgroups: z.object({
      complete: int,
      pending: int.describe('The last segment’s readings waiting for their subgroup'),
      dropped: int.describe('Earlier segments’ trailing readings that never fill one'),
    }),
    retests: z.array(spcMeasurementSchema).describe('Shown apart, never charted'),
    signals: z.array(spcSignalSchema).describe('Every episode, withdrawn ones included'),
  })
  .describe('The I-MR and X̄-R charts of a characteristic, derived from its readings on read');

export const measurementListSchema = z.object({
  measurements: z.array(spcMeasurementSchema),
  truncated: z.boolean(),
});

const comment = z.string().trim().min(1).max(QUALITY_LIMITS.comment);
const writeVersion = int.min(1).describe('The version read; 409 when it is not the current one');
const isoInput = z.iso.datetime({ offset: true });

export const limitsCreateRequestSchema = z
  .strictObject({
    version: writeVersion.describe(
      'The characteristic’s version read (409 urn:shopfloor:limits-stale)',
    ),
    from: isoInput.describe('The window’s first plant time (inclusive)'),
    to: isoInput.describe('The window’s last plant time (inclusive)'),
    comment,
  })
  .describe(
    'Estimates a new limit version from the first-pass readings in the window; it applies from the plant clock on',
  );

export const limitsEndRequestSchema = z
  .strictObject({
    version: writeVersion.describe(
      'The characteristic’s version read (409 urn:shopfloor:limits-stale)',
    ),
    comment,
  })
  .describe('Ends a limit version at the plant clock: later points are not judged by it');

export const signalAckRequestSchema = z
  .strictObject({
    version: writeVersion.describe(
      'The signal’s `rowVersion` read (409 urn:shopfloor:signal-stale)',
    ),
    comment,
  })
  .describe('Acknowledges a signal episode, once');

export const limitsWriteResultSchema = z.object({
  characteristic: characteristicSchema,
  limits: limitVersionSchema,
});

export const QUALITY_TOPIC = 'quality';

/**
 * Push messages of the `quality` topic: signals upserted by id; a characteristic's summary when
 * its readings, limits or notice changed (a client then reads its chart again). A client reads
 * `GET /quality/characteristics` and the chart first, then applies these; it resets on
 * (re)subscribe (Phase 6 lesson).
 */
export const qualityPushMessages = [
  z.object({
    type: z.literal('spc-signal'),
    event: z
      .enum(['opened', 'updated', 'final', 'withdrawn', 'removed', 'acknowledged'])
      .describe(
        'What happened to the episode since the last message about it; `removed`: a provisional, unacknowledged episode a late reading re-derived away (deleted)',
      ),
    signal: spcSignalSchema,
  }),
  z.object({
    type: z.literal('spc-characteristic'),
    event: z
      .enum(['readings', 'limits', 'notice'])
      .describe('New or changed readings (its chart changed), a limit version, or a notice'),
    characteristic: characteristicSchema,
  }),
] as const;

export type SpcValueDto = z.infer<typeof spcValueSchema>;
export type SpcPositionDto = z.infer<typeof spcPositionSchema>;
export type LimitVersionDto = z.infer<typeof limitVersionSchema>;
export type SpcSignalDto = z.infer<typeof spcSignalSchema>;
export type SpcSignalList = z.infer<typeof spcSignalListSchema>;
export type CharacteristicDto = z.infer<typeof characteristicSchema>;
export type CharacteristicList = z.infer<typeof characteristicListSchema>;
export type SpcPointDto = z.infer<typeof spcPointSchema>;
export type SpcMeasurementDto = z.infer<typeof spcMeasurementSchema>;
export type SpcChartDto = z.infer<typeof spcChartSchema>;
export type MeasurementList = z.infer<typeof measurementListSchema>;
export type LimitsCreateRequest = z.infer<typeof limitsCreateRequestSchema>;
export type LimitsEndRequest = z.infer<typeof limitsEndRequestSchema>;
export type SignalAckRequest = z.infer<typeof signalAckRequestSchema>;
export type LimitsWriteResult = z.infer<typeof limitsWriteResultSchema>;
