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

- 18,000 durable writes per second even with `synchronous=FULL`, against about 5 events per second from the plant at 60×;
- strict ordering by id;
- no committed row lost when the writer was killed with SIGKILL;
- no experimental warning on Node 26.

It needs no dependency. Deleting acknowledged rows is a single statement, where an append-only file needs segment management.

Settings: WAL journal, `synchronous=FULL` (survives a power loss, not just a process crash, at a cost that doesn't matter here), one writer.

### Consequences

- Good: no new dependency; a crash-safe, ordered queue in about 50 lines; the buffer is inspectable with any SQLite tool.
- Good: the buffer can also persist small gateway state, such as the WSH-01 ring-buffer counter (#77).
- Bad: `node:sqlite` is synchronous, so a slow disk blocks the event loop briefly. At these rates that is microseconds per message; it is measured again in #79.
