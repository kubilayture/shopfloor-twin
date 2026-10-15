# ADR-0014: Store-and-forward buffer in SQLite through `node:sqlite`

- Status: accepted
- Date: 2026-10-15
- Deciders: Claude (spike #71), recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Plan section 5 requires the gateway to buffer to disk while the broker is unreachable, and to replay in order when it returns. Phase 3 also requires that a gateway restart with buffered messages loses nothing. Which storage holds the buffer?

## Considered options

1. SQLite through Node's built-in `node:sqlite`: one table, `AUTOINCREMENT` ids, WAL journal.
2. An append-only file with `fsync`, with segments and compaction for acknowledged entries.
3. A third-party queue library (LevelDB or similar).

## Decision outcome

Chosen option: 1, because spike #71 showed:

- about 14,800 messages per second in durable batches (`synchronous=FULL` with a full flush, 50 messages per transaction), against about 5 events per second from the plant at 60×;
- strict ordering by id;
- no committed row lost when the writer was killed with SIGKILL (this proves process-crash safety only);
- no experimental warning on Node 26.

A single durable commit costs about 3 ms, the same as an `fsync`'d file append (corrected after review: the first measurement had no full flush).

It needs no dependency. Deleting acknowledged rows is a single statement, where an append-only file needs segment management.

Settings and rules for #78:

- WAL journal, `synchronous=FULL`, and `fullfsync=ON` (only matters on macOS);
- **one transaction per flush tick**: messages that arrive within a short window (for example 20 ms, or 100 messages) are committed together, so the blocking cost is about 3 ms per tick, not per message;
- one process and one connection; `busy_timeout` set anyway;
- reads kept short, with a periodic `wal_checkpoint(TRUNCATE)`, so the WAL can't grow without bound.

### Consequences

- Good: no new dependency; a crash-safe, ordered queue in about 50 lines; the buffer is inspectable with any SQLite tool.
- Good: the buffer can also persist small gateway state, such as the WSH-01 ring-buffer counter (#77).
- Bad: `node:sqlite` is synchronous. A durable commit blocks the event loop for about 3 ms, which is why commits are batched per tick. It is measured again on a Docker volume in #79; a worker thread is the fallback if it matters.
- Bad: power-loss durability is not proven by the spike, only process-crash safety.
