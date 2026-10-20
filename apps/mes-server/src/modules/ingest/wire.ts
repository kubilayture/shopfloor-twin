/**
 * What the ingest session has received from the broker and not yet committed (#245,
 * `mes_ingest_pending_messages`). MQTT.js hands the MES one PUBLISH at a time (`handleMessage`, the
 * next only after the acknowledgement), so the deliveries waiting for the MES are on the socket
 * and in MQTT.js's parser, not in the MES's queue: this counter reads the packet boundaries of the
 * raw byte stream (MQTT's fixed header: a type nibble and a variable-length "remaining length") and
 * counts the PUBLISH packets that arrived. Pending is those arrivals minus the deliveries the MES
 * finished (stored and acknowledged, or dropped with the session).
 *
 * The broker sends a QoS 1 session at most its receive maximum (100, `Ingest`'s connect options) of
 * unacknowledged deliveries, so the figure is bounded by it; and the socket is read only while
 * MQTT.js's parser keeps up (stream backpressure), so part of those may still wait in the kernel's
 * socket buffer, uncounted. A backlog beyond that waits in the broker, whose queue Mosquitto
 * doesn't report per client (`$SYS` has no such figure). The lag histogram covers both (Phase 9
 * plan "Performance", ADR-0040).
 */
export class PublishCounter {
  #stage: 'type' | 'length' | 'body' = 'type';
  #publish = false;
  #length = 0;
  #multiplier = 1;
  #skip = 0;

  /** Reads one chunk of the stream; returns how many PUBLISH packets began in it. */
  push(chunk: Uint8Array): number {
    let found = 0;
    let i = 0;
    while (i < chunk.length) {
      if (this.#stage === 'body') {
        const n = Math.min(this.#skip, chunk.length - i);
        i += n;
        this.#skip -= n;
        if (this.#skip === 0) this.#stage = 'type';
        continue;
      }
      const byte = chunk[i++] ?? 0;
      if (this.#stage === 'type') {
        this.#publish = byte >> 4 === 3;
        this.#length = 0;
        this.#multiplier = 1;
        this.#stage = 'length';
        continue;
      }
      this.#length += (byte & 0x7f) * this.#multiplier;
      this.#multiplier *= 128;
      if ((byte & 0x80) === 0) {
        if (this.#publish) found++;
        this.#skip = this.#length;
        this.#stage = this.#skip === 0 ? 'type' : 'body';
      }
    }
    return found;
  }
}
