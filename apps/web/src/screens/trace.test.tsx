import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.ts';
import { sessionOf } from '../test/fixtures.ts';
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
    expect(within(leak).getByTestId('record-lots').textContent).toBe('None');
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
    expect(within(second).getByTestId('record-operator').textContent).toBe('None');
    expect(within(second).getByTestId('record-crew').textContent).toBe('Nobody signed on');
    expect(within(washer).getByTestId('record-operator').textContent).toBe('Not reported');
    expect(within(washer).getByTestId('record-operator').dataset.reported).toBe('false');
    expect(screen.getByTestId('trace-holds-empty')).toBeTruthy();
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
    // Holds are opened and decided on #203's screen, never here.
    expect(screen.queryAllByRole('button')).toHaveLength(1); // the header's Log out
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
    expect(screen.getByTestId('lot-truncated')).toBeTruthy();
    expect(screen.getByTestId('trace-finality').dataset.notFinal).toBe('ASM-01');
    expect(screen.getByTestId('lot-master').dataset).toMatchObject({
      status: 'active',
      quantity: '1800',
    });
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
    expect(screen.getByTestId('lot-units-empty')).toBeTruthy();
    expect(screen.getByTestId('lot-with-lots').textContent).toBe('None');
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
    expect(screen.getByTestId('carton-status').textContent).toContain('held');
    expect(screen.getByTestId('carton-members').textContent).toBe('1 of 20');
    expect(screen.getByTestId('carton-units').dataset.count).toBe('1');
    expect(screen.getByTestId('carton-unit-3-42').dataset.serial).toBe('VB-100-000042');
    expect(screen.getByTestId('carton-lots').dataset.count).toBe('2');
    expect(screen.getByTestId(`hold-${HOLD_ID}`).dataset.subjectKind).toBe('serial');
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
