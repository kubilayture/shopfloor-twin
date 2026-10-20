import { describe, expect, it } from 'vitest';
import { PublishCounter } from './wire.ts';

/** One MQTT packet: its fixed header (type and flags, the remaining length) and `length` bytes. */
function packet(firstByte: number, length: number): Buffer {
  const size: number[] = [];
  let rest = length;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    size.push(byte);
  } while (rest > 0);
  // The body may hold bytes that look like headers: the counter must skip them.
  return Buffer.concat([Buffer.from([firstByte, ...size]), Buffer.alloc(length, 0x32)]);
}

const PUBLISH_QOS1 = 0x32;
const PUBLISH_RETAINED = 0x31;

describe('PublishCounter (#245, mes_ingest_pending_messages)', () => {
  it('counts the PUBLISH packets of a stream whatever its chunking, and no other packet', () => {
    const stream = Buffer.concat([
      packet(0x20, 3), // CONNACK
      packet(PUBLISH_QOS1, 10),
      packet(PUBLISH_QOS1, 300), // a remaining length of two bytes
      packet(PUBLISH_RETAINED, 20_000), // and of three
      packet(0xd0, 0), // PINGRESP: no body
      packet(0x90, 4), // SUBACK
      packet(PUBLISH_QOS1, 2_100_000), // four bytes
    ]);
    expect(new PublishCounter().push(stream)).toBe(4);
    for (const size of [1, 2, 3, 7, 64, 1_000, 65_536]) {
      const counter = new PublishCounter();
      let found = 0;
      for (let at = 0; at < stream.length; at += size) {
        found += counter.push(stream.subarray(at, at + size));
      }
      expect(found).toBe(4);
    }
  });
});
