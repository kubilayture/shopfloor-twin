import type { Clock, CurrentStateDto, EquipmentDto } from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { listEquipment } from '../api/client.ts';
import { queryKeys, usePlantClock } from '../api/queries.ts';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { QueryError } from '../components/query-error.tsx';
import { StateBadge } from '../components/state-badge.tsx';
import { groupEquipment } from '../domain/plant.ts';
import { STALE_TEXT, isConnectionLost, newest, staleness, timeInState } from '../domain/states.ts';
import { formatDuration, formatPlantTime } from '../domain/time.ts';
import { useLiveConnection, useLiveStates } from '../live/live-context.tsx';

function MachineCard({
  equipment,
  current,
  clock,
  connectionLost,
}: {
  equipment: EquipmentDto;
  current: CurrentStateDto | undefined;
  clock: Clock | null;
  connectionLost: boolean;
}) {
  const headingId = `machine-${equipment.id}`;
  const stale = current ? staleness(current, clock, connectionLost) : undefined;
  return (
    <li>
      <article
        aria-labelledby={headingId}
        data-testid={`machine-${equipment.id}`}
        className="flex h-full flex-col gap-2 rounded-lg border border-slate-300 bg-white p-4 shadow-sm"
      >
        <h4 id={headingId} className="font-semibold leading-tight">
          <Link
            to="/equipment/$id"
            params={{ id: equipment.id }}
            search={{ range: '8h' }}
            className="text-sky-900 underline-offset-2 hover:underline"
          >
            {equipment.name}
          </Link>
        </h4>
        <p className="text-xs text-slate-600">
          <span className="font-mono">{equipment.id}</span> · {equipment.operation}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={current?.state} testId={`state-${equipment.id}`} />
          {stale ? (
            <span
              data-testid={`stale-${equipment.id}`}
              className="rounded border border-amber-700 px-1.5 text-xs font-medium text-amber-900"
            >
              {STALE_TEXT[stale]}
            </span>
          ) : null}
          {current?.seq === null ? (
            <span
              title="Known from the device's start-up state only; no state change seen yet"
              className="rounded border border-slate-500 px-1.5 text-xs text-slate-700"
            >
              Provisional
            </span>
          ) : null}
        </div>
        {current ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
            <dt className="text-slate-600">Cause</dt>
            <dd>{current.cause ?? '—'}</dd>
            <dt className="text-slate-600">In state</dt>
            <dd className="tabular-nums" data-testid={`time-in-state-${equipment.id}`}>
              {formatDuration(timeInState(current, clock))}
            </dd>
            <dt className="text-slate-600">Since</dt>
            <dd>
              <time dateTime={current.since}>{formatPlantTime(current.since)}</time>
            </dd>
          </dl>
        ) : (
          <p className="text-sm text-slate-700">This machine has not reported yet.</p>
        )}
      </article>
    </li>
  );
}

export function Overview() {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const equipment = useQuery({
    queryKey: queryKeys.equipmentList,
    queryFn: ({ signal }) => listEquipment(signal),
  });
  const live = useLiveStates();
  const { clock } = usePlantClock();
  const connectionLost = isConnectionLost(useLiveConnection().status);

  return (
    <section aria-labelledby="overview-title">
      <h1 ref={heading} id="overview-title" tabIndex={-1} className="text-2xl font-bold">
        Plant overview
      </h1>
      {equipment.isPending ? <p className="mt-4">Loading equipment…</p> : null}
      {equipment.isError ? (
        <div className="mt-4">
          <QueryError
            what="the equipment"
            error={equipment.error}
            onRetry={() => void equipment.refetch()}
          />
        </div>
      ) : null}
      {equipment.data?.length === 0 ? (
        <p className="mt-4">No equipment yet: master data is not seeded.</p>
      ) : null}
      {groupEquipment(equipment.data ?? []).map((area) => (
        <section key={area.id} aria-labelledby={`area-${area.id}`} className="mt-6">
          <h2 id={`area-${area.id}`} className="text-xl font-semibold">
            {area.name}
          </h2>
          {area.workCenters.map((center) => (
            <section key={center.id} aria-labelledby={`wc-${center.id}`} className="mt-3">
              <h3 id={`wc-${center.id}`} className="text-base font-medium text-slate-700">
                {center.name}
              </h3>
              <ul className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {center.equipment.map((item) => (
                  <MachineCard
                    key={item.id}
                    equipment={item}
                    current={newest(item.current, live?.states[item.id])}
                    clock={clock}
                    connectionLost={connectionLost}
                  />
                ))}
              </ul>
            </section>
          ))}
        </section>
      ))}
    </section>
  );
}
