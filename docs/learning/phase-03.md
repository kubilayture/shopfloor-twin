# Phase 03 – Edge gateway and UNS: learning notes

Phase 3 built the edge layer: everything between the machines and the MES. These notes explain the ideas and give a reading order, questions _with answers_, and an exercise. They are reference material; the learning step is optional, as in earlier phases.

## 1. Concepts

### Unified Namespace (UNS)

One MQTT topic tree, shaped like the plant (`orbis/gebze/{area}/{workcenter}/{equipment}/{class}/{name}`). Every system publishes what it knows there, and anything that needs data subscribes. There are no point-to-point integrations: a new consumer, say a dashboard or an AI model, subscribes without changing any producer. **Retained** messages give a newcomer the current state at once.

### At-least-once delivery and dedup

MQTT QoS 1 guarantees that a message arrives, not that it arrives once. Reconnects and replays re-send. Correctness therefore lives at the consumer, which recognises what it has seen. A recognisable message needs an identity: (stream, `epoch`, `seq`) from ADR-0015.

### Epochs

A counter restarts at 1 when its owner restarts. Without an epoch, "seq 5 again" could be a duplicate or a fresh fact. The epoch (the owner's start time) makes every number unique.

### Polling a legacy device without loss

A register-based device only shows "now". To still see every fact, the device keeps a small ring of numbered events (many PLCs have an event log). The poller remembers the last number it handled and reads the difference. More than 64 facts between two polls is an **overrun**, which is detectable, not silent.

### Transactional outbox (store-and-forward)

Write to durable storage first, send afterwards, delete on acknowledgement. Any crash leaves each message stored, delivered, or both (hence dedup). Group commit (many messages per flush) gives throughput without weakening durability.

### Broker security

- Per-client users and topic ACLs (least privilege).
- A **last will**: the broker publishes `offline` for a client that vanished.
- A retained status: everyone sees the gateway's health, even late subscribers.

### Proving completeness

"No data lost" is proven against an independent ground truth (the simulator's own event stream), as an equation: published ∪ reported-lost = emitted, with no overlap.

## 2. Reading order

| #   | File                                             | Look for                                                            |
| --- | ------------------------------------------------ | ------------------------------------------------------------------- |
| 1   | `docs/contracts/uns.md`                          | Topics, envelope, identity rules, sources, store-and-forward        |
| 2   | `docs/adr/0015-uns-identity-epochs-and-dedup.md` | Why epochs and scopes                                               |
| 3   | `packages/contracts/src/uns/dedup.ts`            | The consumer rule in about 120 lines                                |
| 4   | `docs/contracts/modbus-register-map.md`          | A legacy device's map and the ring                                  |
| 5   | `apps/edge-gateway/src/opcua/collector.ts`       | Baseline, buffering until the epoch is known, resync, gap write-off |
| 6   | `apps/edge-gateway/src/modbus/poller.ts`         | Walking the ring, overruns, silence                                 |
| 7   | `apps/edge-gateway/src/buffer/outbox.ts`         | Group commit, ordered sending, back-off, bounded size               |
| 8   | `apps/edge-gateway/src/e2e.test.ts`              | How the whole edge is proven                                        |

## 3. Questions, with answers

**1. Why can't the MES deduplicate by (equipment, seq) alone?**

Sequences restart at 1 when the simulator (or a real controller) restarts. With the same seed, facts of the new run would carry numbers already seen and be dropped as duplicates. With the epoch in the key, (epoch 200, seq 5) is new even though (epoch 100, seq 5) was seen.

**2. A consumer starts fresh and receives retained `state/current` (seq 50) and a retained alarm (seq 48). Why must it not treat 48 as a duplicate?**

Retained messages are the latest per topic, not a contiguous stream. Topics of the same device hold facts with unrelated numbers. Treating the first one as a high-water mark would drop the active alarm. The rule passes retained messages with `{ retained: true }`: they restore state, but don't start the stream or create gaps.

**3. Why does the OPC UA collector subscribe first and read `Sequence` afterwards?**

If it read first and subscribed later, a fact raised in between would be neither history nor delivered: lost without trace. Subscribing first and buffering events until the read means every fact is either before the first delivered event (history) or delivered.

**4. After a reconnect, the collector waits 2 s before reporting gaps. Why?**

A repaired OPC UA session republishes what its subscription kept, so missing numbers may still arrive. Reporting at once would call facts lost that arrive a moment later. After the grace period, the missing numbers are written off: reported once, and a late copy is dropped, so nothing is both published and counted lost.

**5. Why does WSH-01's register map need a ring buffer at all? Polling every 250 ms seems fast.**

At 60×, 250 ms is 15 s of plant time, and a minor stop or a short state can come and go in between. Cycles and alarm transitions would be merged or missed too. The ring holds the last 64 facts with numbers, so the poller reads exactly what happened, as long as fewer than 64 facts fall between two polls.

**6. The outbox resolves `publish()` after the commit, not after the PUBACK. Why?**

The collectors must not wait for the network. Once stored, the message survives a crash and is sent whenever the broker is up. Waiting for the PUBACK would stall data collection during every broker outage, which is exactly when buffering matters.

**7. A message is refused by the broker with reason 0x87. Why drop it rather than retry?**

0x87 means "not authorized", and it will be refused forever. The outbox sends in order, so retrying would block every message behind it. Transient codes (server busy, quota) are retried after a pause instead.

**8. Why does the gateway publish its own `_sys/…/status` directly, not through the outbox?**

Status describes _now_. Replayed from a buffer after an outage, an old `online` could arrive after a newer `offline`, and consumers would believe a dead gateway alive. The last will and the status therefore bypass the buffer.

**9. In the end-to-end test the plant is paused before the gateway is killed. Isn't that cheating?**

It isolates what the test proves: that **buffered** messages survive a crash. With the plant running, OPC UA facts raised while no gateway exists are lost by design, since OPC UA keeps no event history (ADR-0009). That is a different property, documented as a known limit and counted as a gap when a gateway reconnects.

**10. What does `published ∪ lost = emitted, with no overlap` prove that "published count = emitted count" doesn't?**

A count can balance by accident: one fact lost and another duplicated. The set equation checks each fact individually: everything is accounted for, nothing twice, and nothing counted as lost that was in fact delivered.

## 4. Hands-on exercise

Watch the edge survive failures.

1. `pnpm stack:up`, then `docker compose exec broker mosquitto_sub -u dev -P <MQTT_DEV_PASSWORD> -t 'orbis/gebze/+/+/+/state/current' -v`.
2. Look at `curl -s localhost:4900/metrics | grep gateway_`: every machine connected, buffer at 0.
3. `docker compose stop broker` for 30 s. The `gateway_buffer_messages` metric grows (`curl localhost:4900/metrics`; the gateway's HTTP port stays up).
4. `docker compose start broker`, restart the subscriber: the buffer drains, and the states continue without a gap.
5. Make the washer silent: `curl -s -X POST localhost:4800/api/v1/faults/modbus -H 'content-type: application/json' -d '{"silent": true}'`. Subscribe to `orbis/gebze/_sys/edge-gateway/gw-01/incidents` and see `device-silent`. Then set it back to `false`: you get `device-recovered`, and no washer fact is lost.

## 5. Owner's answers and notes

_Optional; to be filled in by the owner._
