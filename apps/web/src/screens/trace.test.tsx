import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.ts';
import { EQUIPMENT, sessionOf } from '../test/fixtures.ts';
import { order } from '../test/order-fixtures.ts';
import { renderApp, settle } from '../test/render-app.tsx';
import { tracePolling } from './trace-common.tsx';
import {
  HOLD_ID,
  cartonTrace,
  hold,
  holdRef,
  lotTrace,
  record,
  serialTrace,
  traceMes,
  traceState,
  unit,
} from '../test/trace-fixtures.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

const subscribed = (app: Awaited<ReturnType<typeof renderApp>>) =>
  app.factory.last.sent.filter((m) => m.type === 'subscribe').map((m) => m.topic);

const SERIAL_PATH = '/api/v1/trace/serials/VB-100-000042';

describe('trace polling', () => {
  it('keeps polling after a failed background read with an answer on screen, not after a 4xx', () => {
    const poll = tracePolling((moving: boolean) => moving);
    expect(poll({ state: { data: true, error: null } })).toBe(5_000);
    expect(poll({ state: { data: false, error: null } })).toBe(30_000);
    expect(poll({ state: { data: true, error: new ApiError('down', 0) } })).toBe(5_000);
    expect(poll({ state: { data: true, error: new ApiError('busy', 503) } })).toBe(5_000);
    expect(poll({ state: { data: true, error: new ApiError('gone', 404) } })).toBe(false);
    expect(poll({ state: { data: undefined, error: new ApiError('down', 0) } })).toBe(false);
  });
});

describe('trace search', () => {
  it('finds serials, lots, cartons and orders by the start of their id and links to each', async () => {
    const server = traceMes(
      traceState({
        search: {
          'VB-100': [
            { kind: 'serial', id: 'VB-100-000042' },
            { kind: 'serial', id: 'VB-100-000043' },
          ],
          PO: [
            { kind: 'order', id: 'PO-1001' },
            { kind: 'carton', id: 'PO-1001-C01' },
          ],
          BL: [{ kind: 'lot', id: 'BL100-2610-01' }],
        },
        serials: { 'VB-100-000042': serialTrace() },
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/trace');
    expect(screen.getByTestId('nav-trace').getAttribute('aria-current')).toBe('page');
    expect(screen.queryByTestId('trace-results')).toBeNull();
    fireEvent.change(screen.getByTestId('trace-query'), { target: { value: '  PO ' } });
    fireEvent.click(screen.getByTestId('trace-submit'));
    const results = await screen.findByTestId('trace-results');
    expect(results.dataset.count).toBe('2');
    expect(app.history.location.search).toContain('q=PO');
    expect(screen.getByTestId('trace-result-order-PO-1001').getAttribute('href')).toBe(
      '/orders/PO-1001',
    );
    expect(screen.getByTestId('trace-result-carton-PO-1001-C01').getAttribute('href')).toBe(
      '/trace/cartons/PO-1001-C01',
    );
    // Another search, then one that finds nothing.
    fireEvent.change(screen.getByTestId('trace-query'), { target: { value: 'BL' } });
    fireEvent.click(screen.getByTestId('trace-submit'));
    expect((await screen.findByTestId('trace-result-lot-BL100-2610-01')).getAttribute('href')).toBe(
      '/trace/lots/BL100-2610-01',
    );
    fireEvent.change(screen.getByTestId('trace-query'), { target: { value: 'ZZ' } });
    fireEvent.click(screen.getByTestId('trace-submit'));
    expect((await screen.findByTestId('trace-no-results')).textContent).toContain('ZZ');
    // Back shows the earlier search in the field and its results.
    await settle(() => {
      app.history.back();
    });
    await screen.findByTestId('trace-result-lot-BL100-2610-01');
    expect(screen.getByTestId<HTMLInputElement>('trace-query').value).toBe('BL');
    // Following a serial opens its backward trace.
    fireEvent.change(screen.getByTestId('trace-query'), { target: { value: 'VB-100' } });
    fireEvent.click(screen.getByTestId('trace-submit'));
    fireEvent.click(await screen.findByTestId('trace-result-serial-VB-100-000042'));
    expect((await screen.findByTestId('trace-serial')).dataset.serial).toBe('VB-100-000042');
  });

  it('takes a query of digits from the URL as text', async () => {
    const server = traceMes(traceState({ search: { '42': [{ kind: 'serial', id: '42-A' }] } }));
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/trace?q=42');
    await screen.findByTestId('trace-result-serial-42-A');
    expect(server.reads).toContain('/api/v1/trace/search?q=42');
  });
});

describe('serial page (backward trace)', () => {
  it('shows the order, blank lot, components per pass, machines, operator, crew, readings and carton', async () => {
    const server = traceMes(traceState({ serials: { 'VB-100-000042': serialTrace() } }));
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/trace/serials/VB-100-000042');
    await app.open();
    const shown = await screen.findByTestId('trace-unit');
    expect(shown.dataset).toMatchObject({
      epoch: '3',
      part: '42',
      status: 'packed',
      order: 'PO-1001',
      carton: 'PO-1001-C01',
      held: 'false',
    });
    expect(subscribed(app)).toEqual(expect.arrayContaining(['quality', 'orders']));
    expect(screen.getByTestId('trace-finality').dataset.final).toBe('true');
    expect(screen.getByTestId('trace-order-PO-1001').getAttribute('href')).toBe('/orders/PO-1001');
    expect(screen.getByTestId('trace-carton-PO-1001-C01').getAttribute('href')).toBe(
      '/trace/cartons/PO-1001-C01',
    );
    // The blank lot is the first operation's; the components come per pass.
    const blank = screen.getByTestId('unit-blank-lots');
    expect(within(blank).getByTestId('lot-link-BL100-2610-01').getAttribute('href')).toBe(
      '/trace/lots/BL100-2610-01',
    );
    expect(screen.getByTestId('unit-components-OP30-1').textContent).toContain('SK1-2610-01');
    expect(screen.getByTestId('unit-components-OP30-1').textContent).toContain('SP100-2610-01');
    expect(screen.getByTestId('unit-components-OP30-2').textContent).toContain('SK1-2610-02');
    // The washer's lots (not reported) stay in the operations table, not among the components.
    expect(screen.queryByTestId('unit-components-OP20-1')).toBeNull();
    expect(screen.getByTestId('trace-records').dataset.count).toBe('6');
    // Lots: not reported (null) and none ([]) are told apart.
    const washer = screen.getByTestId('record-OP20-1');
    expect(washer.dataset.equipment).toBe('WSH-01');
    expect(within(washer).getByTestId('record-lots').dataset.reported).toBe('false');
    expect(within(washer).getByTestId('record-lots').textContent).toBe('Not reported');
    const leak = screen.getByTestId('record-OP40-1');
    // None reported: an em dash with its reason (design system 6.3), not "None".
    const noLots = within(leak).getByTestId('record-lots');
    expect(noLots.dataset).toMatchObject({ reported: 'true', count: '0' });
    expect(noLots.querySelector('[data-missing]')?.textContent).toBe('—No lot consumed');
    expect(within(leak).getByTestId('record-reading').dataset).toMatchObject({
      value: '2.4',
      limit: '2',
      over: 'true',
    });
    expect(leak.dataset.result).toBe('rework');
    expect(
      within(screen.getByTestId('record-OP40-2')).getByTestId('record-reading').dataset.over,
    ).toBe('false');
    // The device operator and the MES crew at the cycle's start; none, and not reported.
    const assembly = screen.getByTestId('record-OP30-1');
    expect(within(assembly).getByTestId('record-operator').textContent).toBe('op-ali');
    expect(within(assembly).getByTestId('record-crew').dataset.count).toBe('1');
    expect(within(assembly).getByTestId('record-crew').textContent).toContain('mehmet');
    const second = screen.getByTestId('record-OP30-2');
    // Nobody: an em dash in the table, the reason for a screen reader (6.3).
    const nobody = within(second).getByTestId('record-operator');
    expect(nobody.dataset.reported).toBe('true');
    expect(nobody.querySelector('[data-missing]')?.getAttribute('title')).toBe(
      'No device operator signed on',
    );
    expect(within(second).getByTestId('record-crew').textContent).toBe('—Nobody signed on');
    expect(within(washer).getByTestId('record-operator').textContent).toBe('Not reported');
    expect(within(washer).getByTestId('record-operator').dataset.reported).toBe('false');
    expect(screen.getByTestId('trace-holds-empty')).toBeTruthy();
  });

  it('shows a reading without binary noise; its data attributes keep the value as sent (#295)', async () => {
    const noisy = 3381 * 0.001; // 3.3810000000000002
    const records = [
      record({
        operation: 'OP40',
        equipment: 'LKT-01',
        seq: 13,
        lots: [],
        reading: { characteristic: 'leak-rate', value: noisy, unit: 'Pa/min', upperLimit: 3.2 },
      }),
    ];
    const server = traceMes(
      traceState({ serials: { 'VB-100-000042': serialTrace({ units: [unit({ records })] }) } }),
    );
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/trace/serials/VB-100-000042');
    await app.open();
    const reading = within(await screen.findByTestId('record-OP40-1')).getByTestId(
      'record-reading',
    );
    expect(reading.textContent).toBe('3.381 Pa/min (over the limit 3.2 Pa/min)');
    expect(reading.dataset.value).toBe('3.3810000000000002');
  });

  it('says which machines are not final yet and shows holds on the unit, without hold actions', async () => {
    const server = traceMes(
      traceState({
        serials: {
          'VB-100-000042': serialTrace({
            final: false,
            notFinal: ['LKT-01', 'PCK-01'],
            units: [unit({ status: 'wip', carton: null, holds: [holdRef()] })],
          }),
        },
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/trace/serials/VB-100-000042', { session: sessionOf(['quality']) });
    const notice = await screen.findByTestId('trace-finality');
    expect(notice.dataset).toMatchObject({ final: 'false', notFinal: 'LKT-01,PCK-01' });
    expect(notice.textContent).toContain('LKT-01, PCK-01');
    expect(screen.getByTestId('trace-unit').dataset.held).toBe('true');
    expect(screen.getByTestId('unit-held')).toBeTruthy();
    const item = screen.getByTestId(`hold-${HOLD_ID}`);
    expect(item.dataset).toMatchObject({
      state: 'open',
      subjectKind: 'lot',
      subjectId: 'SK1-2610-01',
    });
    expect(screen.getByTestId(`hold-link-${HOLD_ID}`).getAttribute('href')).toBe(
      `/quality/holds/${HOLD_ID}`,
    );
    expect(screen.getByTestId('holds-screen-link').getAttribute('href')).toBe('/quality/holds');
    // A quality user may hold this serial: a link to #203's form, prefilled.
    expect(screen.getByTestId('trace-hold-open').getAttribute('href')).toBe(
      '/quality/holds/new?kind=serial&id=VB-100-000042',
    );
    // Holds are opened and decided on #203's screen, never here.
    // (The shell's menu, drawer close and Log out buttons are outside `main`.)
    expect(within(screen.getByRole('main')).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByTestId('trace-unit').dataset.carton).toBe('');
  });

  it('asks which unit when the serial repeats across runs', async () => {
    const older = unit({ epoch: 2, partId: 42, orderId: 'PO-0900', carton: 'PO-0900-C03' });
    const server = traceMes(
      traceState({ serials: { 'VB-100-000042': serialTrace({ units: [unit(), older] }) } }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/trace/serials/VB-100-000042');
    const choice = await screen.findByTestId('serial-units');
    expect(choice.dataset.count).toBe('2');
    expect(choice.textContent).toContain('Which one?');
    expect(screen.queryByTestId('trace-unit')).toBeNull();
    fireEvent.click(screen.getByTestId('serial-unit-2-42'));
    expect((await screen.findByTestId('trace-unit')).dataset.order).toBe('PO-0900');
    expect(screen.getByTestId('serial-unit-2-42').getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByTestId('serial-unit-3-42'));
    await waitFor(() => {
      expect(screen.getByTestId('trace-unit').dataset.order).toBe('PO-1001');
    });
  });

  it('says when a chosen unit does not carry the serial', async () => {
    const server = traceMes(
      traceState({
        serials: {
          'VB-100-000042': serialTrace({ units: [unit(), unit({ epoch: 2 })] }),
        },
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/trace/serials/VB-100-000042?unit=9-9');
    expect(await screen.findByTestId('serial-unit-unknown')).toBeTruthy();
    expect(screen.queryByTestId('trace-unit')).toBeNull();
  });

  it('says when the MES has no such serial, and refuses an id it could not know', async () => {
    const server = traceMes(traceState());
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/trace/serials/VB-404');
    expect((await screen.findByTestId('trace-missing')).textContent).toContain('VB-404');
    await settle(() => {
      app.history.push('/trace/lots/%20bad');
    });
    expect(await screen.findByTestId('trace-invalid')).toBeTruthy();
  });

  it('reads the trace again on a hold push, an order push and the confirmed subscriptions', async () => {
    const state = traceState({ serials: { 'VB-100-000042': serialTrace() } });
    const server = traceMes(state);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/trace/serials/VB-100-000042');
    await app.open();
    await screen.findByTestId('trace-unit');
    const before = server.readsOf(SERIAL_PATH);
    state.serials['VB-100-000042'] = serialTrace({ units: [unit({ holds: [holdRef()] })] });
    await app.push({ type: 'subscribed', topic: 'quality', metric: null });
    await waitFor(() => {
      expect(server.readsOf(SERIAL_PATH)).toBeGreaterThan(before);
    });
    await waitFor(() => {
      expect(screen.getByTestId('trace-unit').dataset.held).toBe('true');
    });
    // A release, pushed on `quality`: read again, the hold listed as released, no longer held.
    state.serials['VB-100-000042'] = serialTrace({
      units: [unit({ holds: [holdRef({ state: 'released' })] })],
    });
    await app.push({
      type: 'quality-hold',
      event: 'released',
      hold: hold({ state: 'released', version: 2 }),
    });
    await waitFor(() => {
      expect(screen.getByTestId(`hold-${HOLD_ID}`).dataset.state).toBe('released');
    });
    expect(screen.getByTestId('trace-unit').dataset.held).toBe('false');
    // An order pushed completed (its last carton closes) reads it again; another order change
    // (released) does not.
    const quiet = server.readsOf(SERIAL_PATH);
    await app.push({
      type: 'order',
      event: 'updated',
      order: order('PO-1001', { status: 'released', version: 2 }),
    });
    await settle(() => undefined);
    expect(server.readsOf(SERIAL_PATH)).toBe(quiet);
    const after = server.readsOf(SERIAL_PATH);
    await app.push({
      type: 'order',
      event: 'updated',
      order: order('PO-1001', { status: 'completed' }),
    });
    await waitFor(() => {
      expect(server.readsOf(SERIAL_PATH)).toBeGreaterThan(after);
    });
  });

  it('shows a record with no lots field at its first operation as not reported', async () => {
    const server = traceMes(
      traceState({
        serials: {
          'VB-100-000042': serialTrace({
            units: [unit({ records: [record({ lots: null })] })],
          }),
        },
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/trace/serials/VB-100-000042');
    expect((await screen.findByTestId('unit-blank-lots')).dataset.reported).toBe('false');
    expect(screen.getByTestId('unit-components-empty')).toBeTruthy();
  });

  it('says No OP10 record rather than take OP30’s seal-kit lots for the blank', async () => {
    const assembly = record({
      operation: 'OP30',
      equipment: 'ASM-01',
      lots: [{ material: 'SK-1', lot: 'SK1-2610-01' }],
    });
    const server = traceMes(
      traceState({
        serials: {
          'VB-100-000042': serialTrace({ units: [unit({ status: 'wip', records: [assembly] })] }),
        },
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/trace/serials/VB-100-000042');
    const blank = await screen.findByTestId('unit-blank-lots');
    expect(blank.dataset.reported).toBe('no-record');
    expect(blank.textContent).toBe('No OP10 record');
    expect(within(blank).queryByTestId('lot-link-SK1-2610-01')).toBeNull();
    // The seal kit is a component of OP30.
    expect(screen.getByTestId('unit-components-OP30-1').textContent).toContain('SK1-2610-01');
  });

  it('shows components only for the components operation, not reported where so', async () => {
    const server = traceMes(
      traceState({
        serials: {
          'VB-100-000042': serialTrace({
            units: [
              unit({
                status: 'wip',
                records: [record(), record({ operation: 'OP20', equipment: 'WSH-01', lots: null })],
              }),
            ],
          }),
          'VB-100-000043': serialTrace({
            serial: 'VB-100-000043',
            units: [
              unit({
                serial: 'VB-100-000043',
                records: [record(), record({ operation: 'OP30', equipment: 'ASM-01', lots: null })],
              }),
            ],
          }),
        },
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/trace/serials/VB-100-000042');
    // Before OP30: no component yet, whatever the washer reported.
    expect(await screen.findByTestId('unit-components-empty')).toBeTruthy();
    expect(screen.queryByTestId('unit-components')).toBeNull();
    // An OP30 record without a lot field: its components are not reported.
    await settle(() => {
      app.history.push('/trace/serials/VB-100-000043');
    });
    const assembly = await screen.findByTestId('unit-components-OP30-1');
    expect(assembly.textContent).toContain('Not reported');
  });

  it('round-trips ids with ?, # and % through links, the URL and the API path', async () => {
    const odd = 'A?B#C%D';
    const encoded = encodeURIComponent(odd);
    const server = traceMes(
      traceState({
        search: {
          A: [
            { kind: 'serial', id: odd },
            { kind: 'lot', id: odd },
          ],
        },
        serials: { [odd]: serialTrace({ serial: odd, units: [unit({ serial: odd })] }) },
        lots: { [odd]: lotTrace({ lot: odd }) },
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/trace?q=A');
    fireEvent.click(await screen.findByTestId(`trace-result-serial-${odd}`));
    expect((await screen.findByTestId('trace-serial')).dataset.serial).toBe(odd);
    await screen.findByTestId('trace-unit');
    expect(server.reads).toContain(`/api/v1/trace/serials/${encoded}`);
    // Back to the search, then the lot of the same id.
    await settle(() => {
      app.history.back();
    });
    fireEvent.click(await screen.findByTestId(`trace-result-lot-${odd}`));
    expect((await screen.findByTestId('trace-lot')).dataset.lot).toBe(odd);
    expect(server.reads).toContain(`/api/v1/trace/lots/${encoded}`);
    // Opened from the URL directly.
    await settle(() => {
      app.history.push(`/trace/serials/${encoded}`);
    });
    expect((await screen.findByTestId('trace-serial')).dataset.serial).toBe(odd);
  });

  it('releases the quality and orders topics when the page goes', async () => {
    const server = traceMes(traceState({ serials: { 'VB-100-000042': serialTrace() } }));
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/trace/serials/VB-100-000042');
    await app.open();
    await screen.findByTestId('trace-unit');
    expect(subscribed(app)).toEqual(expect.arrayContaining(['quality', 'orders']));
    await settle(() => {
      app.history.push('/trace');
    });
    await waitFor(() => {
      const released = app.factory.last.sent
        .filter((m) => m.type === 'unsubscribe')
        .map((m) => m.topic);
      expect(released).toEqual(expect.arrayContaining(['quality', 'orders']));
    });
  });
});

describe('lot page (forward trace)', () => {
  it('shows the units, orders, cartons, lots used with it and the holds', async () => {
    const server = traceMes(
      traceState({
        lots: {
          'SK1-2610-01': lotTrace({
            holds: [holdRef()],
            final: false,
            notFinal: ['ASM-01'],
            truncated: true,
          }),
        },
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/trace/lots/SK1-2610-01', { session: sessionOf(['operator']) });
    await app.open();
    const page = await screen.findByTestId('trace-lot');
    await waitFor(() => {
      expect(page.dataset.material).toBe('SK-1');
    });
    expect(page.dataset).toMatchObject({ consumed: '2', truncated: 'true', held: 'true' });
    expect(subscribed(app)).toEqual(expect.arrayContaining(['quality', 'orders']));
    expect(screen.getByTestId('lot-held')).toBeTruthy();
    expect(screen.getByText('Held').className).toContain('bg-alarm-soft');
    // An operator may not hold: no link to the form.
    expect(screen.queryByTestId('trace-hold-open')).toBeNull();
    expect(screen.getByTestId('lot-truncated')).toBeTruthy();
    expect(screen.getByTestId('trace-finality').dataset.notFinal).toBe('ASM-01');
    expect(screen.getByTestId('lot-master').dataset).toMatchObject({
      status: 'active',
      quantity: '1800',
    });
    // The import is a wall time (#295).
    const imported = within(screen.getByTestId('lot-master')).getByText('Imported');
    expect(imported.tagName).toBe('DT');
    expect(imported.nextElementSibling?.textContent).toBe('Thu 15 Oct, 05:00:00 (wall time)');
    expect(screen.getByTestId('lot-units').dataset.count).toBe('2');
    const first = screen.getByTestId('lot-unit-3-42');
    expect(first.dataset).toMatchObject({
      serial: 'VB-100-000042',
      order: 'PO-1001',
      carton: 'PO-1001-C01',
    });
    expect(within(first).getByTestId('serial-link-3-42').getAttribute('href')).toBe(
      '/trace/serials/VB-100-000042?unit=3-42',
    );
    // A unit without a serial yet, an order or a carton.
    const second = screen.getByTestId('lot-unit-3-43');
    expect(second.textContent).toContain('no serial');
    expect(second.textContent).toContain('schedule mode');
    expect(
      within(screen.getByTestId('lot-orders')).getByTestId('trace-order-PO-1001'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('lot-cartons')).getByTestId('trace-carton-PO-1001-C01'),
    ).toBeTruthy();
    const withLots = screen.getByTestId('lot-with-lots');
    expect(withLots.dataset.count).toBe('2');
    expect(within(withLots).getByTestId('lot-link-BL100-2610-01').dataset.material).toBe(
      'BLANK-100',
    );
    expect(screen.getByTestId(`hold-${HOLD_ID}`).dataset.state).toBe('open');
    // Following the serial opens the chosen unit's backward trace.
    fireEvent.click(within(first).getByTestId('serial-link-3-42'));
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/trace/serials/VB-100-000042');
    });
  });

  it('says when the lot was never imported and nothing used it', async () => {
    const server = traceMes(
      traceState({
        lots: {
          'XX-1': lotTrace({
            lot: 'XX-1',
            master: null,
            units: [],
            orders: [],
            cartons: [],
            withLots: [],
            consumed: 0,
          }),
        },
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/trace/lots/XX-1');
    expect((await screen.findByTestId('lot-master')).dataset.status).toBe('not-imported');
    // Not held: no Held badge in the header.
    expect(screen.queryByText('Held')).toBeNull();
    expect(screen.getByTestId('lot-units-empty')).toBeTruthy();
    const withLots = screen.getByTestId('lot-with-lots');
    expect(withLots.dataset.count).toBe('0');
    expect(withLots.textContent).toBe('No other lot was used with it.');
    expect(screen.getByTestId('trace-holds-empty')).toBeTruthy();
  });

  it('says when the MES knows no such lot', async () => {
    vi.stubGlobal('fetch', traceMes(traceState()).fetch);
    await renderApp('/trace/lots/NOPE-1');
    expect((await screen.findByTestId('trace-missing')).textContent).toContain('NOPE-1');
  });
});

describe('carton page', () => {
  it('shows the members, their lots and a held carton', async () => {
    const server = traceMes(
      traceState({
        cartons: {
          'PO-1001-C01': cartonTrace({
            carton: { ...cartonTrace().carton, held: true, status: 'open', closedAt: null },
            holds: [holdRef({ subject: { kind: 'serial', id: 'VB-100-000042' } })],
          }),
        },
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/trace/cartons/PO-1001-C01');
    await app.open();
    const page = await screen.findByTestId('trace-carton');
    await waitFor(() => {
      expect(page.dataset.held).toBe('true');
    });
    expect(page.dataset).toMatchObject({ status: 'open', members: '1', capacity: '20' });
    expect(screen.getByTestId('carton-held')).toBeTruthy();
    expect(screen.getByTestId('carton-status').textContent).toBe('OpenHeld');
    expect(screen.getByTestId('carton-members').textContent).toBe('1 of 20');
    expect(screen.getByTestId('carton-units').dataset.count).toBe('1');
    expect(screen.getByTestId('carton-unit-3-42').dataset.serial).toBe('VB-100-000042');
    expect(screen.getByTestId('carton-lots').dataset.count).toBe('2');
    expect(screen.getByTestId(`hold-${HOLD_ID}`).dataset.subjectKind).toBe('serial');
    // A supervisor may hold the carton.
    expect(screen.getByTestId('trace-hold-open').getAttribute('href')).toBe(
      '/quality/holds/new?kind=carton&id=PO-1001-C01',
    );
    expect(subscribed(app)).toEqual(expect.arrayContaining(['quality', 'orders']));
  });

  it('shows a closed carton that is not held, and a missing one', async () => {
    const server = traceMes(traceState({ cartons: { 'PO-1001-C01': cartonTrace() } }));
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/trace/cartons/PO-1001-C01');
    expect((await screen.findByTestId('carton-status')).dataset.status).toBe('closed');
    expect(screen.queryByTestId('carton-held')).toBeNull();
    await settle(() => {
      app.history.push('/trace/cartons/PO-1001-C02');
    });
    expect((await screen.findByTestId('trace-missing')).textContent).toContain('PO-1001-C02');
  });
});

/** A lot's units: `n` of them in run `epoch`, every third scrapped. */
const lotUnits = (n: number, epoch = 3) =>
  Array.from({ length: n }, (_, i) => ({
    epoch,
    partId: 100 + i,
    serial: `VB-100-${String(100 + i).padStart(6, '0')}`,
    orderId: 'PO-1001',
    carton: `PO-1001-C${String(Math.floor(i / 20) + 1).padStart(2, '0')}`,
    status: i % 3 === 2 ? ('scrapped' as const) : ('packed' as const),
  }));

describe('trace screens on the design system (UX-8, #331)', () => {
  it('lists search results in one table grouped by type, each row named by its id (T-01)', async () => {
    const server = traceMes(
      traceState({
        search: {
          P: [
            { kind: 'order', id: 'PO-1001' },
            { kind: 'carton', id: 'PO-1001-C01' },
            { kind: 'serial', id: 'P-1' },
            { kind: 'lot', id: 'P-LOT' },
            { kind: 'serial', id: 'P-2' },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/trace?q=P');
    const table = await screen.findByRole('table', {
      name: 'Serials, lots, cartons and orders starting with P',
    });
    expect(table.dataset.count).toBe('5');
    // Serials, lots, cartons, orders: grouped, whatever order the MES sent them in.
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((th) => th.textContent),
    ).toEqual(['P-1', 'P-2', 'P-LOT', 'PO-1001-C01', 'PO-1001']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.dataset.kind)).toEqual([
      'serial',
      'serial',
      'lot',
      'carton',
      'order',
    ]);
    expect(rows.map((row) => row.querySelector('[data-cell="c-kind"]')?.textContent)).toEqual([
      'Serial',
      'Serial',
      'Lot',
      'Carton',
      'Order',
    ]);
    expect(screen.getByText(/5 results: 2 serials, 1 lot, 1 carton, 1 order/)).toBeTruthy();
    // The search field is a labelled control in a search landmark.
    expect(
      within(screen.getByRole('search', { name: 'Trace search' })).getByRole('searchbox', {
        name: 'Serial, lot, carton or order',
      }),
    ).toBe(screen.getByTestId('trace-query'));
  });

  it('starts with an example of each id, says when nothing matches, and when a kind is cut', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      kind: 'serial' as const,
      id: `VB-${String(i).padStart(2, '0')}`,
    }));
    const server = traceMes(traceState({ search: { VB: many } }));
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/trace');
    expect(screen.getByText('Search for a serial, lot, carton or order')).toBeTruthy();
    fireEvent.change(screen.getByTestId('trace-query'), { target: { value: 'NOPE' } });
    fireEvent.click(screen.getByTestId('trace-submit'));
    const none = await screen.findByTestId('trace-no-results');
    expect(none.textContent).toContain('Nothing starts with “NOPE”');
    await settle(() => {
      app.history.push('/trace?q=VB');
    });
    expect((await screen.findByTestId('trace-more-serial')).textContent).toContain(
      'Only the first 20 serials are shown',
    );
    expect(screen.queryByTestId('trace-more-lot')).toBeNull();
  });

  it('raises a scrapped serial as an alarm badge, with its facts and finality in the header (T-02)', async () => {
    const server = traceMes(
      traceState({
        serials: { 'VB-100-000042': serialTrace({ units: [unit({ status: 'scrapped' })] }) },
        equipment: EQUIPMENT,
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/trace/serials/VB-100-000042');
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Serial VB-100-000042');
    const status = screen.getByText('Scrapped');
    expect(status.className).toContain('bg-alarm-soft');
    // Final once, in the header: a badge, not a sentence per section.
    const final = screen.getByTestId('trace-finality');
    expect(final.textContent).toBe('Final');
    expect(final.dataset).toMatchObject({ final: 'true', notFinal: '' });
    expect(screen.getByRole('link', { name: '‹ Traceability' }).getAttribute('href')).toBe(
      '/trace',
    );
    // The sections are one jump away.
    const nav = screen.getByRole('navigation', { name: 'On this page' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['#trace-materials-title', '#trace-records-section-title', '#trace-holds-title']);
    // Machines by name with their id; the operation names its row; a rework row is marked.
    const assembly = screen.getByTestId('record-OP30-1');
    await waitFor(() => {
      expect(within(assembly).getByTestId('record-machine').textContent).toBe(
        'Machine asm-01 ASM-01',
      );
    });
    expect(within(assembly).getByRole('rowheader').textContent).toBe('OP30');
    const leak = screen.getByTestId('record-OP40-1');
    expect(within(leak).getByTestId('record-machine').textContent).toBe('LKT-01');
    expect(within(leak).getByText('Rework').className).toContain('bg-warn-soft');
    expect(leak.firstElementChild?.className).toContain('--color-warn-border');
    expect(assembly.firstElementChild?.className).not.toContain('--color-');
    // No reading: an em dash with its reason, not an en dash.
    expect(
      assembly.querySelector('[data-cell="c-reading"] [data-missing]')?.getAttribute('title'),
    ).toBe('No reading at this operation');
  });

  it('shows Provisional in the header and the machines still to report under it', async () => {
    const server = traceMes(
      traceState({
        serials: { 'VB-100-000042': serialTrace({ final: false, notFinal: ['LKT-01'] }) },
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/trace/serials/VB-100-000042');
    const notice = await screen.findByTestId('trace-finality');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain('Not final yet');
    expect(
      screen.getByText('Provisional').closest('[data-finality]')?.getAttribute('data-finality'),
    ).toBe('provisional');
  });

  it('shows an unknown id as a not-found page with the way back (T-06), and a bad id as such', async () => {
    vi.stubGlobal('fetch', traceMes(traceState()).fetch);
    const app = await renderApp('/trace/cartons/NOPE-123');
    const missing = await screen.findByTestId('trace-missing');
    expect(within(missing).getByRole('heading', { level: 2 }).textContent).toBe(
      'No carton NOPE-123',
    );
    expect(missing.textContent).toContain('Cartons form once their packing cycles are final.');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Carton NOPE-123');
    expect(
      within(screen.getByRole('main'))
        .getByRole('link', { name: 'Traceability' })
        .getAttribute('href'),
    ).toBe('/trace');
    // Not the carton's description under the id (G-21).
    expect(screen.queryByText(/formed by the MES’s packing rule/)).toBeNull();
    await settle(() => {
      app.history.push('/trace/lots/NOPE-1');
    });
    expect((await screen.findByTestId('trace-missing')).textContent).toContain(
      'Neither the ERP listed it nor a machine reported it.',
    );
    await settle(() => {
      app.history.push('/trace/serials/%20bad');
    });
    const invalid = await screen.findByTestId('trace-invalid');
    expect(invalid.textContent).toContain('This is not a serial id the MES could know');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Serial');
  });

  it('pages a lot’s units by 50, filters them by status, with one link per row (T-04, G-33)', async () => {
    const server = traceMes(
      traceState({ lots: { 'SK1-2610-01': lotTrace({ units: lotUnits(120) }) } }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/trace/lots/SK1-2610-01');
    const table = await screen.findByTestId('lot-units');
    expect(table.dataset.count).toBe('120');
    expect(within(table).getAllByRole('row')).toHaveLength(51);
    expect(screen.getByText('1–50 of 120')).toBeTruthy();
    // One tab stop a row: the serial; the order and carton are linked once each further down.
    const first = screen.getByTestId('lot-unit-3-100');
    expect(within(first).getAllByRole('link')).toHaveLength(1);
    expect(within(first).getByRole('rowheader').textContent).toBe('VB-100-000100');
    expect(first.dataset.status).toBe('packed');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('51–100 of 120')).toBeTruthy();
    expect(screen.queryByTestId('lot-unit-3-100')).toBeNull();
    expect(screen.getByTestId('lot-unit-3-150')).toBeTruthy();
    // A status filter starts on its first page; a scrapped row is marked.
    const filter = screen.getByRole('combobox', { name: 'Status' });
    expect([...filter.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'All (120)',
      'In work (0)',
      'Packed (80)',
      'Scrapped (40)',
      'Lost (its run ended) (0)',
    ]);
    // From page 2, a filter starts on its own first page.
    fireEvent.change(filter, { target: { value: 'packed' } });
    expect(screen.getByText('1–50 of 80')).toBeTruthy();
    fireEvent.change(filter, { target: { value: 'scrapped' } });
    const scrapped = screen.getByTestId('lot-units');
    expect(scrapped.dataset.count).toBe('40');
    expect(within(scrapped).getAllByRole('row')).toHaveLength(41);
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    const row = screen.getByTestId('lot-unit-3-102');
    expect(row.dataset.status).toBe('scrapped');
    expect(row.firstElementChild?.className).toContain('--color-alarm-border');
    fireEvent.change(filter, { target: { value: 'wip' } });
    expect(screen.getByText('No unit is in work')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show every unit' }));
    expect(screen.getByTestId('lot-units').dataset.count).toBe('120');
    // The sections after the table: above it in the index, and a skip link past it.
    const nav = screen.getByRole('navigation', { name: 'On this page' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Units', 'Orders', 'Cartons', 'Where used with', 'Quality holds']);
    fireEvent.click(screen.getByRole('link', { name: 'Skip past the units' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Orders' }));
  });

  it('puts the one run of a lot’s or carton’s units in the header, not on every row (T-05)', async () => {
    const server = traceMes(
      traceState({
        lots: {
          'SK1-2610-01': lotTrace(),
          'MIX-1': lotTrace({ lot: 'MIX-1', units: [...lotUnits(1, 2), ...lotUnits(1, 3)] }),
        },
        cartons: { 'PO-1001-C01': cartonTrace() },
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/trace/lots/SK1-2610-01');
    const master = await screen.findByTestId('lot-master');
    expect(within(master).getByText('Run').nextElementSibling?.textContent).toBe('3');
    const headers = () => screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers()).not.toContain('Run');
    await settle(() => {
      app.history.push('/trace/lots/MIX-1');
    });
    await waitFor(() => {
      expect(screen.getByTestId('trace-lot').dataset.lot).toBe('MIX-1');
    });
    await screen.findByTestId('lot-unit-2-100');
    expect(within(screen.getByTestId('lot-master')).queryByText('Run')).toBeNull();
    expect(headers()).toContain('Run');
    await settle(() => {
      app.history.push('/trace/cartons/PO-1001-C01');
    });
    const summary = await screen.findByTestId('carton-summary');
    expect(within(summary).getByText('Run').nextElementSibling?.textContent).toBe('3');
    expect(
      within(screen.getByTestId('carton-units'))
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['No.', 'Serial', 'Part', 'Status']);
    fireEvent.click(screen.getByRole('link', { name: 'Skip past the members' }));
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Lots of its members' }),
    );
  });

  it('lists holds in a table: each hold linked, its state as a badge, a blocking one marked', async () => {
    const released = { ...holdRef({ state: 'released' }), id: 'b-released' };
    const server = traceMes(
      traceState({ cartons: { 'PO-1001-C01': cartonTrace({ holds: [holdRef(), released] }) } }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/trace/cartons/PO-1001-C01');
    const table = await screen.findByRole('table', {
      name: 'Quality holds on this carton and its members',
    });
    const open = screen.getByTestId(`hold-${HOLD_ID}`);
    expect(within(open).getByRole('rowheader').textContent).toBe(`Hold ${HOLD_ID}`);
    expect(within(open).getByText('Open').className).toContain('bg-alarm-soft');
    expect(open.firstElementChild?.className).toContain('--color-alarm-border');
    const done = within(table).getByTestId('hold-b-released');
    expect(within(done).getByText('Released').className).toContain('bg-ok-soft');
    expect(done.firstElementChild?.className).not.toContain('--color-alarm-border');
    expect(screen.getByTestId('hold-link-b-released').getAttribute('href')).toBe(
      '/quality/holds/b-released',
    );
  });
});
