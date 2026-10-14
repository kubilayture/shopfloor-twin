import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EventQueue, type QueuedEvent } from './event-queue.ts';

const drain = <E>(queue: EventQueue<E>): QueuedEvent<E>[] => {
  const out: QueuedEvent<E>[] = [];
  for (let next = queue.pop(); next; next = queue.pop()) {
    out.push(next);
  }
  return out;
};

const inOrder = <E>(events: QueuedEvent<E>[]): boolean =>
  events.every((event, i) => {
    const previous = events[i - 1];
    return (
      !previous ||
      previous.time < event.time ||
      (previous.time === event.time && previous.sequence < event.sequence)
    );
  });

describe('EventQueue', () => {
  it('pops events in time order, and in insertion order at equal times', () => {
    const queue = new EventQueue<string>();
    queue.push(20, 'c');
    queue.push(10, 'a');
    queue.push(20, 'd');
    queue.push(10, 'b');
    expect(drain(queue).map((e) => e.event)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is empty when nothing was pushed', () => {
    const queue = new EventQueue<string>();
    expect(queue.size).toBe(0);
    expect(queue.peek()).toBeUndefined();
    expect(queue.pop()).toBeUndefined();
  });

  it('skips cancelled events and reports cancellation once', () => {
    const queue = new EventQueue<string>();
    const first = queue.push(1, 'first');
    queue.push(2, 'second');
    expect(queue.cancel(first)).toBe(true);
    expect(queue.cancel(first)).toBe(false);
    expect(queue.size).toBe(1);
    expect(queue.peek()?.event).toBe('second');
    expect(drain(queue).map((e) => e.event)).toEqual(['second']);
  });

  it('cannot cancel an event that was already popped', () => {
    const queue = new EventQueue<string>();
    const handle = queue.push(1, 'x');
    queue.pop();
    expect(queue.cancel(handle)).toBe(false);
  });

  it('property: any insertion order drains in (time, sequence) order', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 50 }), { maxLength: 300 }), (times) => {
        const queue = new EventQueue<number>();
        times.forEach((time, index) => queue.push(time, index));
        const drained = drain(queue);
        expect(drained).toHaveLength(times.length);
        expect(inOrder(drained)).toBe(true);
      }),
    );
  });

  it('property: cancelling any subset removes exactly that subset', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 50 }), fc.boolean()), { maxLength: 300 }),
        (items) => {
          const queue = new EventQueue<number>();
          const handles = items.map(([time], index) => queue.push(time, index));
          items.forEach(([, cancel], index) => {
            const handle = handles[index];
            if (cancel && handle) {
              queue.cancel(handle);
            }
          });
          const kept = items.flatMap(([, cancel], index) => (cancel ? [] : [index]));
          expect(queue.size).toBe(kept.length);
          const drained = drain(queue);
          expect(inOrder(drained)).toBe(true);
          expect(drained.map((e) => e.event).sort((a, b) => a - b)).toEqual(kept);
        },
      ),
    );
  });

  it('property: interleaved pushes and pops never go back in time', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.integer({ min: 0, max: 20 }), fc.constant('pop' as const)), {
          maxLength: 300,
        }),
        (operations) => {
          const queue = new EventQueue<number>();
          let now = 0;
          for (const operation of operations) {
            if (operation === 'pop') {
              const next = queue.pop();
              if (next) {
                expect(next.time).toBeGreaterThanOrEqual(now);
                now = next.time;
              }
            } else {
              queue.push(now + operation, operation);
            }
          }
        },
      ),
    );
  });
});
