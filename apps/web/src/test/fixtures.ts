import type { CurrentStateDto, EquipmentDto } from '@shopfloor/contracts/mes-api';

export const EPOCH = 1_790_000_000;

export function current(overrides: Partial<CurrentStateDto> = {}): CurrentStateDto {
  return {
    epoch: EPOCH,
    state: 'Running',
    cause: null,
    since: '2026-10-15T06:00:00.000Z',
    seq: 10,
    provisionalUntil: '2026-10-15T06:10:00.000Z',
    ageMs: 600_000,
    ...overrides,
  };
}

const machining = { id: 'machining', name: 'Machining' };
const assembly = { id: 'assembly', name: 'Assembly' };
const site = { id: 'gebze', name: 'Gebze' };

function equipment(
  id: string,
  position: number,
  area: { id: string; name: string },
  workCenter: { id: string; name: string },
  state: CurrentStateDto | null,
): EquipmentDto {
  return {
    id,
    name: `Machine ${id}`,
    operation: `OP${String(position * 10)}`,
    interface: id === 'wsh-01' ? 'modbus' : 'opcua',
    position,
    site,
    area,
    workCenter,
    current: state,
  };
}

export const EQUIPMENT: EquipmentDto[] = [
  equipment('wsh-01', 3, machining, { id: 'cell-m1', name: 'Cell M1' }, current({ state: 'Idle' })),
  equipment('cnc-01', 1, machining, { id: 'cell-m1', name: 'Cell M1' }, current()),
  equipment('asm-01', 4, assembly, { id: 'line-a1', name: 'Line A1' }, null),
];

export const PLANT = {
  site: { ...site, enterprise: { id: 'orbis', name: 'Orbis Components' } },
  clock: { epoch: EPOCH, watermark: '2026-10-15T06:10:00.000Z' },
  epochs: [{ epoch: EPOCH, watermark: '2026-10-15T06:10:00.000Z' }],
};

type Handler = (url: URL) => Response | Promise<Response>;

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A problem+json answer; `type` is about:blank unless a stable one is given (#163). */
export const problem = (
  status: number,
  title: string,
  detail: string,
  instance: string,
  type = 'about:blank',
): Response =>
  new Response(JSON.stringify({ type, title, status, detail, instance }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

/** A fetch that answers by path; unknown paths are 404 problems. */
export function fakeFetch(routes: Record<string, Handler>) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    const handler = routes[url.pathname];
    if (handler) return handler(url);
    return problem(404, 'Not Found', 'Unknown equipment, metric or route', url.pathname);
  };
}
