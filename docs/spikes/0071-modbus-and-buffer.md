# Spike #71: Modbus library and store-and-forward storage

Date: 2026-10-15. Node.js 26.11.1, `modbus-serial` 8.0.25, SQLite 3.53.4 (`node:sqlite`). Code: `apps/simulator/spikes/modbus.ts` and `store-forward.ts` (experimental). The gateway app doesn't exist yet, so the storage spike lives next to the Modbus one.

## Modbus TCP with `modbus-serial`

One process ran the server (the simulator side) and clients (the gateway side) on loopback.

| #   | Check                                                            | Result                                                                                                                         |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 2000 reads of a 64-register block (FC03) while the values change | median 1.4 ms, p99 2.3 ms; values and 32-bit pairs (high word first) intact                                                    |
| 2   | Read past the end of the register map                            | exception 2 (illegal data address), reported to the client as `modbusCode` 2                                                   |
| 3   | Coils (FC01)                                                     | correct                                                                                                                        |
| 4   | Silent device: the server never answers                          | client error "Timed out" after the configured 500 ms; the next read on the same connection works                               |
| 5   | Server closed, then restarted                                    | the client sees `close` and `isOpen = false`; reads fail at once with "Port Not Open"; a new client connects after the restart |
| 6   | Two clients at once                                              | both served                                                                                                                    |

What must be known:

- The server's vector has two forms:
  - **Synchronous:** `getMultipleHoldingRegisters(addr, len, unit)` must return an _array_. Returning a Promise yields exception 4 (slave device failure), not a delayed answer.
  - **Callback:** add a fourth parameter, `cb`. It is the form for a "silent" device, which simply never calls back, and for asynchronous answers.
- Throwing, or calling back with `{ modbusErrorCode: n }`, produces exception `n`.
- After the server closes, the client does not reconnect by itself. The poller must create a new client (or call `connectTCP` again) with backoff.
- The optional dependency `serialport` needs a native build. The workspace ignores it (`ignoredOptionalDependencies`), because only TCP is used. `index.js` loads the serial modules inside try/catch, so only `getPorts()` would fail at runtime. The repo's `skipLibCheck` hides the missing `serialport` types.
- **Imports:** the `.d.ts` declares `export default` in a CommonJS package. Under our module settings, TypeScript therefore needs `import Modbus, { ServerTCP } from 'modbus-serial'` and `const ModbusRTU = Modbus.default`, which also works at runtime. The spike scripts type-check with this form.
- **Found by the review, outside the scripts:**
  - FC04 reads work;
  - ten concurrent requests on one client are matched by transaction id;
  - a late answer after a timeout doesn't corrupt the next read;
  - connecting to no server fails at once with ECONNREFUSED.

  Things to handle in #74 and #77:
  - the server answers up to 126 registers, so the poller must keep requests to the standard maximum of 125 itself;
  - a wrong unit id is dropped silently, which looks like a timeout;
  - a listen failure surfaces as `serverError`, which needs a handler.

- The library is ISC-licensed, depends only on `debug`, and was last released in March 2026. That is mature rather than fast-moving, which suits a single legacy device.

The alternative, `jsmodbus` 5.0.0 (September 2026), was not tried. Its first release in three years is a major version, and `modbus-serial` showed no gap that would justify a second spike.

## Store-and-forward storage

| #   | Check                                              | `node:sqlite` (WAL)                                                                       | Append-only file                                                  |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | Write one message per transaction, about 400 bytes | 44,600/s with `synchronous=NORMAL`; 18,300/s with `FULL`                                  | 335/s with `fsync` per message                                    |
| 2   | Replay in order, delete each after acknowledgement | 57,000/s (`NORMAL`), 21,900/s (`FULL`); strictly in insertion order by `AUTOINCREMENT` id | needs segment files and compaction to delete acknowledged entries |
| 4   | Writer killed with SIGKILL after about 1 s         | every committed row present: 36,806 reported, 36,806 found, ids contiguous                | not tested                                                        |
| 5   | Experimental warning on Node 26                    | none                                                                                      | n/a                                                               |

The plant emits about 5 events per second at 60×, plus telemetry. Even `synchronous=FULL`, which also survives a power loss rather than only a process crash, is three orders of magnitude above that.
