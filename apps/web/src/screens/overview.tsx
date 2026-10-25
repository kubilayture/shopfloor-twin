import type { Clock, CurrentStateDto, EquipmentDto } from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { listEquipment } from '../api/client.ts';
import { queryKeys, usePlantClock } from '../api/queries.ts';
import { CauseText } from '../components/cause-text.tsx';
import { QueryError } from '../components/query-error.tsx';
import { StaleTag, StateBadge } from '../components/state-badge.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Card } from '../components/ui/card.tsx';
import { Code } from '../components/ui/code.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Duration, PlantTime } from '../components/ui/format.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { Section } from '../components/ui/section.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { groupEquipment } from '../domain/plant.ts';
import {
  isConnectionLost,
  NO_DATA,
  NO_DATA_STATE,
  newest,
  staleness,
  stateCounts,
  type Staleness,
  stateStyle,
  timeInState,
} from '../domain/states.ts';
import { useLiveConnection, useLiveStates } from '../live/live-context.tsx';

/**
 * The plant overview (UX-2, #322; design system 2.4, 3.3, 3.4): the page header, a summary of
 * machines per state with the abnormal ones first (O-01, O-04), then each area (`h2`) and work
 * center (`h3`) with a card per machine (`article`, `h4`). Only an abnormal machine's card has
 * colour: the 4 px left bar in its state's border colour (G-13). A stale state keeps its badge
 * and gets the `warn` Stale tag beside it with the full reason as visible text.
 *
 * Test contracts: the cards stay `article[data-testid="machine-<id>"]` (the demo walkthrough
 * counts them), the badges `state-<id>` with `data-state` (`no-data` before the first report),
 * `stale-<id>` only while stale, `time-in-state-<id>`; the summary uses `overview-summary` and
 * `summary-state-<state>`, never an id starting with `machine-`.
 */

/** "1 machine", "3 machines". */
const machines = (count: number) => `${String(count)} ${count === 1 ? 'machine' : 'machines'}`;

function MachineCard({
  equipment,
  current,
  clock,
  connectionLost,
}: {
  readonly equipment: EquipmentDto;
  readonly current: CurrentStateDto | undefined;
  readonly clock: Clock | null;
  readonly connectionLost: boolean;
}) {
  const stale = current ? staleness(current, clock, connectionLost) : undefined;
  const style = current ? stateStyle(current.state) : NO_DATA;
  return (
    <li className="min-w-0">
      <Card
        as="article"
        headingLevel={4}
        padding="compact"
        testId={`machine-${equipment.id}`}
        className={`h-full ${style.bar ?? ''}`}
        title={
          <Link
            to="/equipment/$id"
            params={{ id: equipment.id }}
            search={{ range: '8h' }}
            className="text-link underline-offset-4 hover:underline"
          >
            {equipment.name}
          </Link>
        }
        description={
          <>
            <Code>{equipment.id}</Code> · {equipment.operation}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge
            state={current?.state}
            testId={`state-${equipment.id}`}
            stale={stale}
            staleTestId={`stale-${equipment.id}`}
          />
          {current?.seq === null ? (
            <Badge
              tone="neutral"
              variant="dashed"
              title="Known from the device's start-up state only; no state change seen yet"
            >
              Provisional
            </Badge>
          ) : null}
        </div>
        {current ? (
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div className="min-w-0">
              <dt className="text-xs font-medium text-ink-secondary">In state</dt>
              <dd>
                <Duration
                  ms={timeInState(current, clock)}
                  seconds
                  testId={`time-in-state-${equipment.id}`}
                />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-medium text-ink-secondary">Since</dt>
              <dd>
                <PlantTime at={current.since} clock={clock?.watermark} />
              </dd>
            </div>
            {current.cause === null ? null : (
              <div className="col-span-2 min-w-0">
                <dt className="text-xs font-medium text-ink-secondary">Cause</dt>
                <dd>
                  <CauseText cause={current.cause} />
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="mt-3 text-sm text-ink-secondary">This machine has not reported yet.</p>
        )}
      </Card>
    </li>
  );
}

/**
 * Machines per state, the abnormal states first (O-01): one tile per state that has a machine,
 * the count in large figures beside the state's badge; an abnormal state's tile has its bar.
 */
function Summary({
  states,
  stale,
}: {
  readonly states: readonly (string | undefined)[];
  /** Why the counts may be out of date: the Stale tag beside the heading. */
  readonly stale: Staleness;
}) {
  const counts = stateCounts(states);
  const attention = counts
    .filter((item) => stateStyle(item.state).abnormal)
    .reduce((sum, item) => sum + item.count, 0);
  return (
    <Section
      id="summary-title"
      title="Machines by state"
      testId="overview-summary"
      status={stale === undefined ? undefined : <StaleTag reason={stale} testId="summary-stale" />}
      description={`${machines(states.length)}; ${
        attention === 0
          ? 'none needs'
          : `${String(attention)} ${attention === 1 ? 'needs' : 'need'}`
      } attention`}
    >
      <ul className="flex flex-wrap gap-3">
        {counts.map(({ state, count }) => {
          const style = state === NO_DATA_STATE ? NO_DATA : stateStyle(state);
          return (
            <li
              key={state}
              data-testid={`summary-state-${state}`}
              data-state={state}
              data-count={String(count)}
              className={`flex min-w-36 items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2 ${
                style.bar ?? ''
              }`}
            >
              <span className="sr-only">
                {style.label}: {machines(count)}
              </span>
              <span aria-hidden="true" className="text-2xl font-semibold tabular-nums text-ink">
                {count}
              </span>
              <span aria-hidden="true">
                <StateBadge state={state === NO_DATA_STATE ? undefined : state} />
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/**
 * Whether the summary's counts may be out of date: the live connection is lost, or a counted
 * state is from an earlier run. The summary then says so beside its heading, as each card does.
 */
function summaryStaleness(
  states: readonly (CurrentStateDto | undefined)[],
  clock: Clock | null,
  connectionLost: boolean,
): Staleness {
  if (connectionLost) return 'disconnected';
  return states.some((current) => current && staleness(current, clock, false) === 'older-run')
    ? 'older-run'
    : undefined;
}

export function Overview() {
  const equipment = useQuery({
    queryKey: queryKeys.equipmentList,
    queryFn: ({ signal }) => listEquipment(signal),
  });
  const live = useLiveStates();
  const { clock } = usePlantClock();
  const connectionLost = isConnectionLost(useLiveConnection().status);
  const items = (equipment.data ?? []).map((item) => ({
    item,
    current: newest(item.current, live?.states[item.id]),
  }));
  const currentOf = new Map(items.map(({ item, current }) => [item.id, current]));

  return (
    <section aria-labelledby="overview-title">
      <PageHeader
        id="overview-title"
        title="Plant overview"
        size="dashboard"
        description="Every machine's state as it reports it, by area and work center."
      />
      {equipment.isPending ? (
        // The page's own shape: the summary's tiles, then a work center's three cards.
        <div className="flex flex-col gap-8" data-testid="overview-loading">
          <Skeleton
            shape="stat"
            count={3}
            gridClassName="flex flex-wrap gap-3 *:w-36 *:rounded-lg *:border *:border-line *:bg-surface *:px-4 *:py-3"
            label="Loading equipment…"
          />
          <Skeleton
            shape="card"
            count={3}
            gridClassName="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
          />
        </div>
      ) : null}
      {equipment.isError ? (
        <QueryError
          what="the equipment"
          error={equipment.error}
          onRetry={() => void equipment.refetch()}
        />
      ) : null}
      {equipment.data?.length === 0 ? (
        <Card padding="compact">
          <EmptyState
            title="No machines yet"
            body="No equipment yet: master data is not seeded."
            icon="info"
          />
        </Card>
      ) : null}
      {items.length > 0 ? (
        <>
          <Summary
            states={items.map(({ current }) => current?.state)}
            stale={summaryStaleness(
              items.map(({ current }) => current),
              clock,
              connectionLost,
            )}
          />
          {groupEquipment(equipment.data ?? []).map((area) => (
            <Section key={area.id} id={`area-${area.id}`} title={area.name}>
              {area.workCenters.map((center) => (
                <Section
                  key={center.id}
                  level={3}
                  id={`wc-${center.id}`}
                  title={center.name}
                  description={machines(center.equipment.length)}
                >
                  <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {center.equipment.map((item) => (
                      <MachineCard
                        key={item.id}
                        equipment={item}
                        current={currentOf.get(item.id)}
                        clock={clock}
                        connectionLost={connectionLost}
                      />
                    ))}
                  </ul>
                </Section>
              ))}
            </Section>
          ))}
        </>
      ) : null}
    </section>
  );
}
