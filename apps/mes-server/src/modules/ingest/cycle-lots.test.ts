import { resolve } from 'node:path';
import { cycleTopic, type CycleComplete } from '@shopfloor/contracts';
import { sql, type Kysely } from 'kysely';
import { Registry } from 'prom-client';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../db/database.ts';
import { migrate } from '../../db/migrate.ts';
import { startDatabase } from '../../testing.ts';
import { Ingest } from './index.ts';

/**
 * Lots and operator on cycle facts (UNS contract 1.4, #197, ADR-0033): validated, stored in the
 * payload as delivered, read back by `Ingest.cycleFacts`, and found by lot through the expression
 * index `ingest.equipment_event_cycle_lots`. Messages go through `Ingest.deliver`, the store path
 * without a broker.
 */

const MIGRATIONS = resolve(import.meta.dirname, '../../../../../db/migrations');
const EPOCH = 1_760_000_000;
const CNC = { area: 'machining', workCenter: 'cell-m1', equipment: 'cnc-01' } as const;
const ASM = { area: 'assembly', workCenter: 'line-a1', equipment: 'asm-01' } as const;
const WSH = { area: 'assembly', workCenter: 'line-a1', equipment: 'wsh-01' } as const;

let container: StartedTestContainer;
let databaseUrl: string;
let testNumber = 0;
const cleanup: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  const database = await startDatabase();
  container = database.container;
  databaseUrl = database.url;
}, 180_000);

afterAll(async () => {
  await container.stop();
});

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup(registry?: Registry): Promise<{ db: Kysely<Database>; ingest: Ingest }> {
  testNumber++;
  const admin = createDatabase(databaseUrl, 1);
  await sql.raw(`CREATE DATABASE lots_${String(testNumber)}`).execute(admin);
  await admin.destroy();
  const db = createDatabase(databaseUrl.replace(/\/shopfloor$/, `/lots_${String(testNumber)}`), 3);
  cleanup.push(() => db.destroy());
  await migrate(db, MIGRATIONS);
  const ingest = new Ingest({
    db,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'unused',
    gapGraceMs: 5_000,
    sweepIntervalMs: 0,
    now: () => Date.parse('2026-10-15T10:00:00Z'),
    ...(registry ? { registry } : {}),
  });
  cleanup.push(() => ingest.stop());
  return { db, ingest };
}

function cycle(
  path: { readonly equipment: string },
  seq: number,
  partId: number,
  trace: Pick<CycleComplete['value'], 'lots' | 'operator'>,
  protocol: 'opcua' | 'modbus' = 'opcua',
): CycleComplete {
  return {
    schema: 'uns.events.cycle-complete/1',
    scope: 'device',
    epoch: EPOCH,
    seq,
    sourceTime: new Date(Date.UTC(2026, 9, 12, 3) + seq * 1000).toISOString(),
    receivedAt: '2026-10-15T10:00:00.000Z',
    quality: 'good',
    source: { id: path.equipment, protocol },
    value: {
      product: 'VB-100',
      partId,
      serial: protocol === 'modbus' ? '' : `VB-100-${String(partId).padStart(6, '0')}`,
      result: 'good',
      reason: null,
      measurement: null,
      ...trace,
    },
  };
}

const BLANK_1 = { material: 'BLANK-100', lot: 'BL100-2610-01' };
const BLANK_2 = { material: 'BLANK-100', lot: 'BL100-2610-02' };
const SK1 = { material: 'SK-1', lot: 'SK1-2610-01' };
const SK2 = { material: 'SK-2', lot: 'SK2-2610-01' };

describe('ingest: lots and operator on cycle facts (#197)', () => {
  it('stores them as delivered and reads them back; [] and null stay apart from absent', async () => {
    const { db, ingest } = await setup();
    const messages = [
      cycle(CNC, 1, 1, { lots: [BLANK_1], operator: null }),
      cycle(CNC, 2, 2, { lots: [BLANK_2], operator: null }),
      cycle(ASM, 1, 1, { lots: [SK1, SK2], operator: 'OP-07' }),
      // A rework pass at ASM-01 that took nothing reports none, and so no operator.
      cycle(ASM, 2, 1, { lots: [], operator: null }),
      // A cycle of an older gateway (contract before 1.4): neither field.
      cycle(CNC, 3, 3, {}),
      // WSH-01 on Modbus sends neither.
      cycle(WSH, 1, 1, {}, 'modbus'),
    ];
    for (const message of messages) {
      const path =
        message.source.id === 'cnc-01' ? CNC : message.source.id === 'asm-01' ? ASM : WSH;
      await ingest.deliver(cycleTopic(path), JSON.stringify(message));
    }
    const facts = await ingest.cycleFacts({ epoch: EPOCH });
    expect(facts.map((f) => [f.equipment, f.seq, f.lots, f.operator])).toEqual([
      ['asm-01', 1, [SK1, SK2], 'OP-07'],
      ['asm-01', 2, [], null],
      ['cnc-01', 1, [BLANK_1], null],
      ['cnc-01', 2, [BLANK_2], null],
      ['cnc-01', 3, undefined, undefined],
      ['wsh-01', 1, undefined, undefined],
    ]);
    // Absent fields stay absent: not reported is not "none".
    expect(facts.filter((f) => !('lots' in f) && !('operator' in f))).toHaveLength(2);
    const rejected = await db.selectFrom('ingest.rejected_message').selectAll().execute();
    expect(rejected).toEqual([]);
  });

  it('finds the cycles that consumed a lot, across machines, through the lot index', async () => {
    const { db, ingest } = await setup();
    await ingest.deliver(cycleTopic(CNC), JSON.stringify(cycle(CNC, 1, 1, { lots: [BLANK_1] })));
    await ingest.deliver(cycleTopic(CNC), JSON.stringify(cycle(CNC, 2, 2, { lots: [BLANK_2] })));
    await ingest.deliver(
      cycleTopic(ASM),
      JSON.stringify(cycle(ASM, 1, 1, { lots: [SK1, SK2], operator: 'OP-07' })),
    );
    await ingest.deliver(
      cycleTopic(ASM),
      JSON.stringify(cycle(ASM, 2, 2, { lots: [SK1, SK2], operator: 'OP-07' })),
    );
    await ingest.deliver(cycleTopic(CNC), JSON.stringify(cycle(CNC, 3, 3, {})));
    const of = async (lot: string, epoch = EPOCH) =>
      (await ingest.cycleFacts({ epoch, lot })).map((f) => `${f.equipment}#${String(f.partId)}`);
    expect(await of('BL100-2610-01')).toEqual(['cnc-01#1']);
    expect(await of('BL100-2610-02')).toEqual(['cnc-01#2']);
    expect(await of('SK2-2610-01')).toEqual(['asm-01#1', 'asm-01#2']);
    expect(await of('NO-SUCH-LOT')).toEqual([]);
    // A material code is not a lot id.
    expect(await of('SK-1')).toEqual([]);
    expect(await of('SK1-2610-01', EPOCH + 1)).toEqual([]);
    // The index spans epochs: a later run's cycle of the same lot, found with no epoch given.
    await ingest.deliver(
      cycleTopic(CNC),
      JSON.stringify({ ...cycle(CNC, 1, 9, { lots: [BLANK_1] }), epoch: EPOCH + 2 }),
    );
    expect(
      (await ingest.cycleFacts({ lot: 'BL100-2610-01' })).map((f) => [f.epoch, f.partId]),
    ).toEqual([
      [EPOCH, 1],
      [EPOCH + 2, 9],
    ]);
    // With other filters.
    expect(
      (await ingest.cycleFacts({ epoch: EPOCH, lot: 'SK1-2610-01', partIds: [2] })).map(
        (f) => f.seq,
      ),
    ).toEqual([2]);

    // At scale the planner takes the index: 20,000 more cycles of a later epoch, 100 per lot,
    // inserted directly, then analysed. The query is the containment `cycleFacts` sends.
    await sql`
      INSERT INTO ingest.equipment_event
        (equipment, epoch, seq, source_time, event_type, topic, quality, source_protocol,
         received_at, payload)
      SELECT 'cnc-01', ${EPOCH + 1}, n, '2026-10-13T00:00:00Z'::timestamptz + n * interval '1 s',
        'cycle', ${cycleTopic(CNC)}, 'good', 'opcua', now(),
        jsonb_build_object('value', jsonb_build_object('partId', n, 'lots',
          jsonb_build_array(jsonb_build_object('material', 'BLANK-100', 'lot', 'L-' || (n % 200)))))
      FROM generate_series(1, 20000) AS n`.execute(db);
    await sql`ANALYZE ingest.equipment_event`.execute(db);
    const explained = await sql<{ 'QUERY PLAN': string }>`
      EXPLAIN SELECT seq FROM ingest.equipment_event
      WHERE event_type = 'cycle' AND epoch = ${EPOCH + 1}
        AND payload -> 'value' -> 'lots' @> ${JSON.stringify([{ lot: 'L-7' }])}::jsonb`.execute(db);
    const plan = explained.rows.map((row) => row['QUERY PLAN']).join('\n');
    expect(await of('L-7', EPOCH + 1)).toHaveLength(100);
    expect(plan).toContain('equipment_event_cycle_lots');
  });

  it.each([
    [
      'lots on a Modbus cycle',
      cycle(WSH, 1, 1, { lots: [] }, 'modbus'),
      {},
      /lots come from OPC UA only/,
    ],
    [
      'an operator on a Modbus cycle',
      cycle(WSH, 1, 1, { operator: null }, 'modbus'),
      {},
      /operator come from OPC UA only/,
    ],
    [
      'an operator on a cycle that consumed nothing',
      cycle(ASM, 1, 1, { lots: [], operator: 'OP-07' }),
      { lots: [] },
      /consumed nothing/,
    ],
    [
      'an empty lot id',
      cycle(CNC, 1, 1, { lots: [{ material: 'BLANK-100', lot: '' }], operator: null }),
      { operator: null },
      /^lots: /,
    ],
    [
      'more than 64 lots',
      cycle(CNC, 1, 1, { lots: Array.from({ length: 65 }, () => BLANK_1), operator: null }),
      { operator: null },
      /^lots: /,
    ],
    [
      'an empty operator',
      cycle(ASM, 1, 1, { lots: [SK1], operator: '' }),
      { lots: [SK1] },
      /^operator: /,
    ],
    [
      'both fields malformed',
      cycle(ASM, 1, 1, {
        lots: 'SK1' as unknown as [],
        operator: 7 as unknown as string,
      }),
      {},
      /^lots: .*; operator: /,
    ],
    [
      'a lot with a NUL character',
      cycle(CNC, 1, 1, { lots: [{ material: 'BLANK-100', lot: 'BL\u0000' }], operator: null }),
      { operator: null },
      /lots: a string contains a NUL character/,
    ],
  ])(
    'keeps the cycle without its refused trace field(s) on %s, and records trace-dropped',
    async (_label, message, kept, detail) => {
      const { db, ingest } = await setup();
      const path =
        message.source.id === 'cnc-01' ? CNC : message.source.id === 'asm-01' ? ASM : WSH;
      const text = JSON.stringify(message);
      await ingest.deliver(cycleTopic(path), text);
      // The cycle is stored (no gap in the device sequence), with only the valid trace fields.
      const facts = await ingest.cycleFacts({ epoch: EPOCH });
      expect(facts).toHaveLength(1);
      const fact = facts[0];
      expect({ lots: fact?.lots, operator: fact?.operator }).toEqual({
        lots: undefined,
        operator: undefined,
        ...kept,
      });
      const stored = await db
        .selectFrom('ingest.equipment_event')
        .select('payload')
        .executeTakeFirstOrThrow();
      const value = (stored.payload as CycleComplete).value;
      expect(Object.keys(value).filter((k) => k === 'lots' || k === 'operator')).toEqual(
        Object.keys(kept),
      );
      const rows = await db
        .selectFrom('ingest.rejected_message')
        .select(['reason', 'detail', 'payload', 'retained'])
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ reason: 'trace-dropped', payload: text, retained: false });
      expect(rows[0]?.detail).toMatch(detail);
      // A duplicate delivery stores nothing more and records nothing more.
      await ingest.deliver(cycleTopic(path), text);
      expect(await ingest.cycleFacts({ epoch: EPOCH })).toHaveLength(1);
      expect(await db.selectFrom('ingest.rejected_message').selectAll().execute()).toHaveLength(1);
    },
  );

  it('counts the cycles kept without trace fields per equipment', async () => {
    const registry = new Registry();
    const { ingest } = await setup(registry);
    await ingest.deliver(
      cycleTopic(ASM),
      JSON.stringify(cycle(ASM, 1, 1, { lots: [], operator: 'OP-07' })),
    );
    await ingest.deliver(cycleTopic(ASM), JSON.stringify(cycle(ASM, 2, 2, { lots: [SK1] })));
    const metric = await registry.getSingleMetric('mes_ingest_cycle_trace_dropped_total')?.get();
    expect(metric?.values).toEqual([{ value: 1, labels: { equipment: 'asm-01' } }]);
  });

  it('ignores a retained copy of a cycle, trace fields or not, before judging them', async () => {
    const { db, ingest } = await setup();
    const message = cycle(ASM, 1, 1, { lots: [], operator: 'OP-07' });
    await ingest.deliver(cycleTopic(ASM), JSON.stringify(message), true);
    expect(await ingest.cycleFacts({ epoch: EPOCH })).toEqual([]);
    expect(await db.selectFrom('ingest.rejected_message').selectAll().execute()).toEqual([]);
  });

  it('still refuses a cycle that is invalid apart from its trace fields', async () => {
    const { db, ingest } = await setup();
    const message = cycle(CNC, 1, 1, { lots: [{ material: '', lot: '' }] });
    const broken = { ...message, value: { ...message.value, partId: 0 } };
    await ingest.deliver(cycleTopic(CNC), JSON.stringify(broken));
    expect(await ingest.cycleFacts({ epoch: EPOCH })).toEqual([]);
    const rows = await db.selectFrom('ingest.rejected_message').select('reason').execute();
    expect(rows).toEqual([{ reason: 'invalid-payload' }]);
  });
});
