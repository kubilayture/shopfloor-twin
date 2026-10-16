import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACK,
  episode,
  hourKpi,
  kpiBucket,
  occurrence,
  point,
  shelf,
} from '../test/alarm-fixtures.ts';
import { socketFactory } from '../test/fake-socket.ts';
import {
  LIVE_ALARM_LIMIT,
  applyMessage,
  connectLiveToCache,
  liveKeys,
  setLiveQueryDefaults,
  upsertOccurrence,
  type LiveAlarmKpi,
  type LiveAlarms,
} from './live-cache.ts';
import { LiveClient } from './live-client.ts';

function liveQueryClient(): QueryClient {
  const queryClient = new QueryClient();
  setLiveQueryDefaults(queryClient);
  return queryClient;
}

const alarms = (queryClient: QueryClient) => queryClient.getQueryData<LiveAlarms>(liveKeys.alarms);

describe('alarm messages', () => {
  it('upserts occurrences by id and never takes one back to an earlier step', () => {
    const queryClient = liveQueryClient();
    const raised = occurrence(1);
    const acked = occurrence(1, { state: 'acked-active', acknowledged: ACK });
    applyMessage(queryClient, { type: 'alarm', event: 'raised', occurrence: raised });
    applyMessage(queryClient, { type: 'alarm', event: 'acknowledged', occurrence: acked });
    expect(alarms(queryClient)?.occurrences[raised.id]).toEqual(acked);
    // A write's answer that arrives after the push of a later step is ignored.
    upsertOccurrence(queryClient, raised);
    expect(alarms(queryClient)?.occurrences[raised.id]).toEqual(acked);
    expect(alarms(queryClient)?.seq).toBe(3);
    const commented = { ...acked, comments: 1 };
    applyMessage(queryClient, { type: 'alarm', event: 'commented', occurrence: commented });
    expect(alarms(queryClient)?.occurrences[raised.id]?.comments).toBe(1);
  });

  it('keeps the point with the higher shelf version', () => {
    const queryClient = liveQueryClient();
    const shelved = point({ shelf: shelf({ shelved: true, version: 2 }) });
    applyMessage(queryClient, { type: 'alarm-point', event: 'shelved', point: shelved });
    applyMessage(queryClient, {
      type: 'alarm-point',
      event: 'unshelved',
      point: point({ shelf: shelf({ version: 1 }) }),
    });
    expect(alarms(queryClient)?.points['cnc-01/COOLANT-PRESSURE']).toEqual(shelved);
    const expired = point({ shelf: shelf({ version: 3 }) });
    applyMessage(queryClient, { type: 'alarm-point', event: 'expire', point: expired });
    expect(alarms(queryClient)?.points['cnc-01/COOLANT-PRESSURE']).toEqual(expired);
  });

  it('keeps only the newest occurrences beyond the limit', () => {
    const queryClient = liveQueryClient();
    for (let seq = 0; seq <= LIVE_ALARM_LIMIT; seq += 1) {
      upsertOccurrence(queryClient, occurrence(seq));
    }
    const kept = alarms(queryClient)?.occurrences ?? {};
    expect(Object.keys(kept)).toHaveLength(LIVE_ALARM_LIMIT);
    expect(kept[occurrence(0).id]).toBeUndefined();
  });

  it('keeps the alarm KPIs of a topic and reads REST again when the clock moves on', () => {
    const queryClient = liveQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const hour = hourKpi('2026-10-15T05:00:00.000Z');
    applyMessage(queryClient, {
      type: 'snapshot',
      topic: 'alarm-kpi:position:cell-m1',
      hour,
      shift: kpiBucket(),
      floods: [episode()],
    });
    const key = liveKeys.alarmKpi('position:cell-m1');
    expect(queryClient.getQueryData<LiveAlarmKpi>(key)?.floods).toHaveLength(1);
    applyMessage(queryClient, {
      type: 'alarm-kpi',
      topic: 'alarm-kpi:position:cell-m1',
      hour: { ...hour, raises: 15 },
      shift: kpiBucket(),
      floods: [],
    });
    expect(queryClient.getQueryData<LiveAlarmKpi>(key)?.hour?.raises).toBe(15);
    expect(invalidate).not.toHaveBeenCalled();
    applyMessage(queryClient, {
      type: 'alarm-kpi',
      topic: 'alarm-kpi:position:cell-m1',
      hour: hourKpi('2026-10-15T06:00:00.000Z'),
      shift: kpiBucket(),
      floods: [],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['alarm-kpi'] });
  });
});

describe('alarms after a reconnect', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the pushed alarms again from the REST reads', () => {
    vi.useFakeTimers();
    const queryClient = liveQueryClient();
    const factory = socketFactory();
    const client = new LiveClient({
      url: 'ws://x',
      createSocket: factory.create,
      random: () => 0.5,
    });
    connectLiveToCache(client, queryClient);
    client.start();
    factory.last.open();
    factory.last.receive({ type: 'alarm', event: 'raised', occurrence: occurrence(1) });
    expect(Object.keys(alarms(queryClient)?.occurrences ?? {})).toHaveLength(1);
    factory.last.drop();
    vi.advanceTimersByTime(1_000);
    factory.last.open();
    expect(alarms(queryClient)?.occurrences).toEqual({});
    factory.last.receive({ type: 'alarm', event: 'raised', occurrence: occurrence(2) });
    expect(Object.keys(alarms(queryClient)?.occurrences ?? {})).toEqual([occurrence(2).id]);
  });
});
