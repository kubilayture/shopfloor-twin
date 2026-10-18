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
  /**
   * First-pass readings whose points `GET …/chart` answers by default: the most recent ones;
   * `all=true` (or a `from`/`to` range) answers more.
   */
  chartRecent: 500,
  /** Holds one `GET /quality/holds` answers at most (newest first); more sets `truncated`. */
  holds: 500,
  /** Units of a hold's scope one `GET /quality/holds/{id}` lists at most. */
  holdUnits: 5_000,
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
    extentFinal: z
      .boolean()
      .describe(
        'The tester is final through its closing point (open: its last point): `last`, `points` and `closedBy` stay as they are but for a fact from a written-off gap',
      ),
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
    pointsFrom: time
      .nullable()
      .describe(
        'Points before this plant time were left out (the default recent window, or `from`); null: every point up to `to`',
      ),
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

// ---- Quality holds (#201, plan "Quality holds", ADR-0035) ----

/** What a hold is on; its scope is derived through the genealogy and grows with facts. */
export const HOLD_SUBJECT_KINDS = ['lot', 'serial', 'carton', 'order'] as const;
export type HoldSubjectKind = (typeof HOLD_SUBJECT_KINDS)[number];

/**
 * A hold's state: `open`; `released` (use as is); `rejected` (quality wants the units scrapped or
 * reworked outside the MES: quantities don't change, cartons stay held, the ERP is told).
 */
export const HOLD_STATES = ['open', 'released', 'rejected'] as const;
export type HoldState = (typeof HOLD_STATES)[number];

export const HOLD_TRANSITION_KINDS = ['opened', 'commented', 'released', 'rejected'] as const;

/** The transitions a reason of `quality.yaml` can be given for. */
export const HOLD_REASON_USES = ['open', 'release', 'reject'] as const;

// The id formats the ERP accepts for each kind (`@shopfloor/contracts/erp-api`): a lot id, a
// serial or carton id, an ERP order number.
const LOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ORDER_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const HOLD_REASON = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;

export const holdSubjectSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('lot'), id: z.string().regex(LOT_ID) }),
    z.strictObject({ kind: z.literal('serial'), id: z.string().regex(UNIT_ID) }),
    z.strictObject({ kind: z.literal('carton'), id: z.string().regex(UNIT_ID) }),
    z.strictObject({ kind: z.literal('order'), id: z.string().regex(ORDER_NUMBER) }),
  ])
  .describe('A lot, a serial (every unit with it), a carton or an order (its ERP order number)');

const holdReason = z.string().regex(HOLD_REASON).describe('A hold reason code of quality.yaml');

export const holdScopeCountsSchema = z
  .object({
    units: int,
    cartons: int,
    orders: int,
    asOf: time.nullable().describe('Plant time the counts stand at'),
    final: z
      .boolean()
      .describe('Every machine final through `asOf` when written; the scope can still grow'),
  })
  .describe('The scope counts a transition’s ERP notification carried (provisional)');

export const holdSchema = z
  .object({
    id: z.string().describe('A UUID, unique forever'),
    subject: holdSubjectSchema,
    state: z.enum(HOLD_STATES),
    reason: holdReason.describe('The opening’s reason'),
    openedBy: z.string(),
    openedAt: time.describe('Wall time'),
    openedPlantAt: time
      .nullable()
      .describe(
        'The plant clock when it opened: a held lot consumed after it raises held-material-consumed',
      ),
    decidedBy: z.string().nullable(),
    decidedAt: time.nullable().describe('Wall time of the release or rejection'),
    decidedPlantAt: time.nullable(),
    decisionReason: holdReason.nullable(),
    transitions: int.describe('Transitions and comments so far'),
    version: int.min(1).describe('The version a comment, release or rejection must name'),
    scope: z
      .object({ units: int, cartons: int, orders: int })
      .describe('The scope as last derived from the genealogy (it grows with facts)'),
    heldMaterialConsumed: int.describe('held-material-consumed incidents'),
  })
  .describe('A quality hold');

export const holdListSchema = z.object({
  holds: z.array(holdSchema).describe('Newest first'),
  truncated: z.boolean(),
});

export const holdTransitionSchema = z.object({
  n: int.min(1),
  kind: z.enum(HOLD_TRANSITION_KINDS),
  reason: holdReason.nullable(),
  comment: z.string().nullable(),
  by: z.string(),
  at: time.describe('Wall time'),
  plantAt: time.nullable(),
  scope: holdScopeCountsSchema.nullable().describe('Null for a comment (not notified)'),
  notification: z
    .object({
      idempotencyKey: z.string().describe('{holdId}~{transition}~{n}'),
      status: z.string().describe('pending, sent, conflict or refused'),
      attempts: int,
      lastError: z.string().nullable(),
    })
    .nullable()
    .describe('Its quality notification to the ERP (outbox); null for a comment'),
});

export const holdUnitSchema = z.object({
  epoch: int,
  partId: int,
  serial: z.string().nullable(),
  orderId: z.string().nullable(),
  carton: z.string().nullable(),
  joinedAt: time.describe('Wall time it joined the scope'),
});

export const holdIncidentSchema = z.object({
  id: int,
  type: z.literal('held-material-consumed'),
  lot: z.string(),
  equipment: z.string(),
  epoch: int,
  seq: int,
  partId: int,
  operation: z.string().nullable(),
  pass: int.nullable(),
  consumedAt: time.describe('Plant time of the consuming cycle'),
  message: z.string(),
  detectedAt: time.describe('Wall time'),
});

export const holdDetailSchema = z
  .object({
    hold: holdSchema,
    transitions: z.array(holdTransitionSchema),
    units: z.array(holdUnitSchema).describe('By (epoch, partId)'),
    unitsTruncated: z.boolean(),
    orders: z.array(z.string()),
    cartons: z.array(z.string()),
    incidents: z.array(holdIncidentSchema),
  })
  .describe('A hold with its transitions, its scope as last derived and its incidents');

const holdComment = z.string().trim().min(1).max(QUALITY_LIMITS.comment);

export const holdOpenRequestSchema = z
  .strictObject({ subject: holdSubjectSchema, reason: holdReason, comment: holdComment.optional() })
  .describe('Opens a hold; the scope follows the genealogy from now on');

export const holdCommentRequestSchema = z
  .strictObject({
    version: int.min(1).describe('The hold’s `version` read (409 urn:shopfloor:hold-stale)'),
    comment: holdComment,
  })
  .describe('A comment on a hold (audited, not notified)');

export const holdDecisionRequestSchema = z
  .strictObject({
    version: int.min(1).describe('The hold’s `version` read (409 urn:shopfloor:hold-stale)'),
    reason: holdReason,
    comment: holdComment.optional(),
  })
  .describe('Releases (use as is) or rejects an open hold');

export const holdReasonListSchema = z.object({
  reasons: z.array(
    z.object({ id: z.string(), name: z.string(), for: z.array(z.enum(HOLD_REASON_USES)) }),
  ),
});

export const holdSuggestionSchema = z
  .object({
    signal: int,
    characteristic: z.string(),
    chart: z.enum(SPC_CHART_NAMES),
    rule: int,
    after: spcPositionSchema
      .nullable()
      .describe('The last in-control point before the episode; null: from its segment’s start'),
    from: spcPositionSchema.describe(
      'The window’s first reading: just after `after`, or its segment’s first reading',
    ),
    through: spcPositionSchema.describe('The episode’s last triggering point'),
    readings: int.describe('Readings (every pass) after `after` through `through`'),
    units: z.array(
      z.object({
        epoch: int,
        partId: int,
        serial: z.string().nullable(),
        orderId: z.string().nullable(),
        carton: z.string().nullable(),
      }),
    ),
    orders: z.array(z.string()),
    cartons: z.array(z.string()),
    final: z
      .boolean()
      .describe('The episode’s extent is final (`extentFinal`): the window won’t move'),
  })
  .describe(
    'The units tested since the last in-control point before a signal episode: a suggested scope; no hold is opened by itself',
  );

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
    type: z.literal('quality-hold'),
    event: z
      .enum(['opened', 'commented', 'released', 'rejected', 'scope'])
      .describe('A transition or comment, or its scope or incidents changed (#201)'),
    hold: holdSchema,
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
export type HoldSubjectDto = z.infer<typeof holdSubjectSchema>;
export type HoldDto = z.infer<typeof holdSchema>;
export type HoldList = z.infer<typeof holdListSchema>;
export type HoldTransitionDto = z.infer<typeof holdTransitionSchema>;
export type HoldUnitDto = z.infer<typeof holdUnitSchema>;
export type HoldIncidentDto = z.infer<typeof holdIncidentSchema>;
export type HoldDetailDto = z.infer<typeof holdDetailSchema>;
export type HoldOpenRequest = z.infer<typeof holdOpenRequestSchema>;
export type HoldCommentRequest = z.infer<typeof holdCommentRequestSchema>;
export type HoldDecisionRequest = z.infer<typeof holdDecisionRequestSchema>;
export type HoldReasonList = z.infer<typeof holdReasonListSchema>;
export type HoldSuggestionDto = z.infer<typeof holdSuggestionSchema>;
