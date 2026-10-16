import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { EPOCH } from '../test/fixtures.ts';
import { SHIFT_KEY } from '../test/oee-fixtures.ts';
import { note, shiftRecord } from '../test/shift-fixtures.ts';
import { instanceKey } from '../domain/shifts.ts';
import {
  applyMessage,
  liveKeys,
  resetLiveShifts,
  upsertNote,
  type LiveShifts,
} from './live-cache.ts';

const shifts = (client: QueryClient) => client.getQueryData<LiveShifts>(liveKeys.shifts);

describe('live shifts', () => {
  it('keeps an instance only when it is newer by the push rule', () => {
    const client = new QueryClient();
    const key = instanceKey(EPOCH, SHIFT_KEY);
    applyMessage(client, { type: 'shift', event: 'created', shift: shiftRecord() });
    applyMessage(client, {
      type: 'shift',
      event: 'status',
      shift: shiftRecord({ status: 'final', final: true }),
    });
    expect(shifts(client)?.instances[key]?.status).toBe('final');
    // An older copy (a write's answer read before the final status) never takes it back.
    applyMessage(client, {
      type: 'shift',
      event: 'revised',
      shift: shiftRecord({ revision: { inputs: 0, content: 1 } }),
    });
    expect(shifts(client)?.instances[key]?.status).toBe('final');
    expect(shifts(client)?.seq).toBe(3);
  });

  it('upserts notes by id with the higher version', () => {
    const client = new QueryClient();
    applyMessage(client, { type: 'handover-note', event: 'created', note: note(1) });
    applyMessage(client, {
      type: 'handover-note',
      event: 'edited',
      note: note(1, { version: 3, text: 'v3' }),
    });
    upsertNote(client, note(1, { version: 2, text: 'v2' }));
    expect(shifts(client)?.notes['1']?.text).toBe('v3');
  });

  it('forgets every pushed instance and note on reset', () => {
    const client = new QueryClient();
    resetLiveShifts(client);
    expect(shifts(client)).toBeUndefined();
    applyMessage(client, { type: 'handover-note', event: 'created', note: note(1) });
    applyMessage(client, { type: 'shift', event: 'created', shift: shiftRecord() });
    resetLiveShifts(client);
    expect(shifts(client)?.notes).toEqual({});
    expect(shifts(client)?.instances).toEqual({});
  });
});
