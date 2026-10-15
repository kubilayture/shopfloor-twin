// Spike #71: storage for the gateway's store-and-forward buffer. node:sqlite versus an append-only file.
// Run: node apps/simulator/spikes/store-forward.ts  (the gateway app doesn't exist yet, so it lives here)
import { spawn } from 'node:child_process';
import { closeSync, fsyncSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'sf-spike-'));
const payload = JSON.stringify({
  schema: 'uns.events.cycle-complete/1',
  source: { equipment: 'cnc-01', protocol: 'opcua' },
  epoch: 1_791_774_000,
  seq: 1234,
  sourceTime: '2026-10-12T06:01:02.345Z',
  receivedAt: '2026-10-15T14:00:00.000Z',
  quality: 'good',
  value: { serial: 'VB100-2610-000123', result: 'good', product: 'VB-100' },
});

function open(file: string, synchronous: 'NORMAL' | 'FULL'): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = ${synchronous};
    CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL,
      payload TEXT NOT NULL, retain INTEGER NOT NULL)`);
  return db;
}

// 1. Throughput: one transaction per message, as the gateway writes each message as it arrives.
for (const synchronous of ['NORMAL', 'FULL'] as const) {
  const db = open(join(dir, `t-${synchronous}.db`), synchronous);
  const insert = db.prepare('INSERT INTO outbox (topic, payload, retain) VALUES (?, ?, ?)');
  const n = 5_000;
  const t = performance.now();
  for (let i = 0; i < n; i++)
    insert.run('orbis/gebze/machining/cell-m1/cnc-01/events/cycle-complete', payload, 0);
  const ms = performance.now() - t;
  // 2. Ordered replay and delete-after-ack.
  const next = db.prepare('SELECT id, topic, payload FROM outbox ORDER BY id LIMIT ?');
  const remove = db.prepare('DELETE FROM outbox WHERE id = ?');
  const t2 = performance.now();
  let previous = 0;
  for (let batch = next.all(100); batch.length > 0; batch = next.all(100)) {
    for (const row of batch) {
      const id = Number(row.id);
      if (id !== previous + 1)
        throw new Error(`out of order: ${String(id)} after ${String(previous)}`);
      previous = id;
      remove.run(id);
    }
  }
  console.log(
    `1/2. sqlite WAL synchronous=${synchronous}: ${String(Math.round(n / (ms / 1000)))} inserts/s; replay+delete ${String(Math.round(n / ((performance.now() - t2) / 1000)))}/s, in order`,
  );
  db.close();
}

// 1b. The fair comparison on macOS: SQLite only does a full flush (like fsyncSync) with fullfsync=ON.
// Single-message transactions, then one transaction per batch of 50 (one flush tick).
{
  const db = open(join(dir, 't-fullfsync.db'), 'FULL');
  db.exec('PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON');
  const insert = db.prepare('INSERT INTO outbox (topic, payload, retain) VALUES (?, ?, ?)');
  const n = 500;
  let t = performance.now();
  for (let i = 0; i < n; i++) insert.run('t', payload, 0);
  const single = n / ((performance.now() - t) / 1000);
  t = performance.now();
  for (let batch = 0; batch < 100; batch++) {
    db.exec('BEGIN');
    for (let i = 0; i < 50; i++) insert.run('t', payload, 0);
    db.exec('COMMIT');
  }
  const batched = 5_000 / ((performance.now() - t) / 1000);
  console.log(
    `1b. sqlite FULL + fullfsync: ${String(Math.round(single))} single-message commits/s (${(1000 / single).toFixed(1)} ms each, blocking); ${String(Math.round(batched))} messages/s in batches of 50`,
  );
  db.close();
}

// 3. Append-only file with fsync per message, for comparison.
{
  const file = join(dir, 'outbox.log');
  const fd = openSync(file, 'a');
  const n = 5_000;
  const t = performance.now();
  for (let i = 0; i < n; i++) {
    writeSync(fd, `${payload}\n`);
    fsyncSync(fd);
  }
  closeSync(fd);
  console.log(
    `3. append-only file + fsync: ${String(Math.round(n / ((performance.now() - t) / 1000)))} appends/s (deleting acknowledged entries needs segments and compaction)`,
  );
}

// 4. Crash safety: a child inserts and reports each committed id, then is killed with SIGKILL.
{
  const file = join(dir, 'crash.db');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(${JSON.stringify(file)});
       db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT)");
       const insert = db.prepare('INSERT INTO outbox (payload) VALUES (?)');
       for (;;) { const r = insert.run('x'.repeat(400)); process.stdout.write(String(r.lastInsertRowid) + '\\n'); }`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let lastReported = 0;
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().trim().split('\n');
    lastReported = Number(lines.at(-1));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await new Promise((r) => setTimeout(r, 1_000));
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
  const db = new DatabaseSync(file);
  const { count, max } = db
    .prepare('SELECT count(*) AS count, max(id) AS max FROM outbox')
    .get() as {
    count: number;
    max: number;
  };
  db.close();
  console.log(
    `4. SIGKILL after ~1 s: reported ${String(lastReported)}, found ${String(count)} rows (max id ${String(max)}), contiguous ${String(count === max)}, none reported lost ${String(count >= lastReported)}`,
  );
  // 5. Does node:sqlite print an experimental warning?
  console.log(`5. child stderr (warnings): ${stderr.trim() === '' ? 'none' : stderr.trim()}`);
}

rmSync(dir, { recursive: true, force: true });
