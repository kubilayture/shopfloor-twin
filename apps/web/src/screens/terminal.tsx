import { PAUSE_REASONS, type PauseReason, type SessionDto } from '@shopfloor/contracts/mes-api';
import type {
  ScrapRecordDto,
  TerminalOperationDto,
  TerminalOrderDto,
  TerminalViewDto,
} from '@shopfloor/contracts/mes-api';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { listEquipment } from '../api/client.ts';
import { login } from '../api/identity.ts';
import { queryKeys, usePlantClock } from '../api/queries.ts';
import {
  codeScrap,
  getScrapReasons,
  getTerminalView,
  operationWrite,
  signOff,
  signOn,
  terminalKeys,
  type OperationAction,
} from '../api/terminal.ts';
import { useAuth } from '../auth/auth.tsx';
import { IdleWatch } from '../auth/shell.tsx';
import { ConnectionStatus } from '../components/connection-status.tsx';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { QueryError } from '../components/query-error.tsx';
import { StateBadge } from '../components/state-badge.tsx';
import { loginFailure } from '../domain/identity.ts';
import { groupEquipment } from '../domain/plant.ts';
import {
  PAUSE_REASON_LABELS,
  codableReasons,
  myActivity,
  operationActions,
  signedOnHere,
  terminalFailure,
  withOperation,
  withoutScrapRecord,
} from '../domain/terminal.ts';
import { CHART_TEXT, SIGNAL_STATUS_TEXT, isOpenEpisode, subjectText } from '../domain/quality.ts';
import { formatPlantTime } from '../domain/time.ts';
import { liveKeys } from '../live/live-cache.ts';
import { useLiveTerminal } from '../live/live-context.tsx';

// The operator terminal (#177, plan "Operator terminal"): `/terminal` picks a work center (inside
// the app), `/terminal/$workCenter` is the tablet screen itself, outside the app's layout: large
// touch targets (at least 56 px), 375–1024 px wide, its own sign-on with a `terminal` session.
// Everything it holds is keyed by (user, work center): sign-off and a session's end empty the
// query cache, stop the live client and unmount every draft, so the next operator sees nothing
// of the previous one's.

const big =
  'min-h-14 rounded-lg px-5 text-lg font-semibold focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-sky-700 disabled:opacity-50';
const primary = `${big} border-2 border-sky-900 bg-sky-800 text-white hover:bg-sky-900`;
const secondary = `${big} border-2 border-slate-700 bg-white text-slate-900 hover:bg-slate-100`;
const warning = `${big} border-2 border-amber-800 bg-amber-100 text-amber-950 hover:bg-amber-200`;
const inputClass = 'min-h-14 rounded-lg border-2 border-slate-500 bg-white px-3 text-lg';

/** `/terminal`: the work centers, each a link to its terminal screen. */
export function TerminalPicker() {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const equipment = useQuery({
    queryKey: queryKeys.equipmentList,
    queryFn: ({ signal }) => listEquipment(signal),
  });
  return (
    <section aria-labelledby="terminal-picker">
      <h1 id="terminal-picker" ref={heading} tabIndex={-1} className="text-2xl font-bold">
        Operator terminal
      </h1>
      <p className="mt-1 text-slate-700">
        Choose the work center this tablet stands at. Operators sign on there with their own user
        name and password.
      </p>
      {equipment.error ? (
        <QueryError what="the work centers" error={equipment.error} />
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2" data-testid="terminal-work-centers">
          {groupEquipment(equipment.data ?? []).flatMap((area) =>
            area.workCenters.map((wc) => (
              <li key={wc.id}>
                <Link
                  to="/terminal/$workCenter"
                  params={{ workCenter: wc.id }}
                  data-testid={`terminal-link-${wc.id}`}
                  className={`${secondary} flex flex-col justify-center py-3`}
                >
                  <span>{wc.name}</span>
                  <span className="text-sm font-normal text-slate-600">
                    {area.name} · {wc.equipment.map((e) => e.id).join(', ')}
                  </span>
                </Link>
              </li>
            )),
          )}
        </ul>
      )}
    </section>
  );
}

/** Forgets what the terminal read and every write's input: the next user starts empty. */
function forgetTerminal(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: terminalKeys.all });
  queryClient.removeQueries({ queryKey: ['live', 'terminal'] });
  queryClient.getMutationCache().clear();
}

/** `/terminal/$workCenter`: the tablet screen, with its own sign-on. */
export function TerminalScreen() {
  const { workCenter } = useParams({ from: '/terminal/$workCenter' });
  const auth = useAuth();
  const queryClient = useQueryClient();
  const session = auth.session;
  const user =
    session?.kind === 'terminal' && !session.user.mustChangePassword ? session.user : undefined;
  // Whoever held the screen before: a change of user (or none) forgets everything of theirs.
  const holder = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (holder.current !== undefined && holder.current !== user?.id) forgetTerminal(queryClient);
    holder.current = user?.id;
  }, [queryClient, user?.id]);
  return (
    <div className="min-h-screen bg-slate-100 text-slate-900" data-testid="terminal-screen">
      <TerminalHeader workCenter={workCenter} session={session ?? null} />
      <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-3 py-4 focus:outline-none">
        {session === undefined ? (
          <p role="status">Checking your session…</p>
        ) : user && session ? (
          <>
            <TerminalWork
              key={`${String(user.id)}/${workCenter}`}
              workCenter={workCenter}
              session={session}
            />
            <IdleWatch session={session} />
          </>
        ) : (
          <SignOn key={workCenter} workCenter={workCenter} session={session} />
        )}
      </main>
    </div>
  );
}

function TerminalHeader({
  workCenter,
  session,
}: {
  readonly workCenter: string;
  readonly session: SessionDto | null;
}) {
  const { clock } = usePlantClock();
  return (
    <header className="bg-slate-900 text-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
        <p className="text-lg font-bold">
          Terminal <span className="font-mono font-normal text-slate-300">{workCenter}</span>
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span data-testid="terminal-clock">
            {clock ? `Plant time ${formatPlantTime(clock.watermark)}` : 'No plant time yet'}
          </span>
          {session ? <ConnectionStatus /> : null}
        </div>
      </div>
    </header>
  );
}

/** User name and password at the terminal: a `terminal` session, then the crew row here. */
function SignOn({
  workCenter,
  session,
}: {
  readonly workCenter: string;
  readonly session: SessionDto | null;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | undefined>(undefined);
  const userId = useId();
  const passwordId = useId();
  const submit = useMutation({
    mutationFn: async () => {
      const next = await login({ username: username.trim(), password, kind: 'terminal' });
      setPassword('');
      if (next.user.mustChangePassword) {
        // The MES holds that session now: the app reads it, so it never shows the one before.
        await auth.refresh().catch(() => undefined);
        return { next, signedOn: false };
      }
      // The crew row first, then the session goes to the app: the screen that mounts then reads
      // a view that already has the operator signed on. A refused sign-on (no shift running)
      // leaves the operator logged in; the screen that mounts says why and offers to sign on.
      const refusal = await signOn(workCenter).then(
        () => undefined,
        (error: unknown) => terminalFailure(error, 'Logged in, but not signed on').text,
      );
      auth.loggedIn(next);
      if (refusal !== undefined) {
        queryClient.setQueryData(terminalKeys.refusal(next.user.username, workCenter), refusal);
      }
      return { next, signedOn: refusal === undefined };
    },
    meta: { auth: false },
    onSuccess: ({ next }) => {
      if (next.user.mustChangePassword) {
        setMessage(
          'Your password must be changed first: log in at a desk once, then sign on here.',
        );
      }
    },
    onError: (error) => {
      setMessage(loginFailure(error));
    },
  });
  const desk = session?.kind === 'desk' ? session.user.username : undefined;
  return (
    <section aria-labelledby="sign-on" className="mx-auto max-w-md rounded-lg bg-white p-5 shadow">
      <h1 id="sign-on" ref={heading} tabIndex={-1} className="text-2xl font-bold">
        Sign on
      </h1>
      {desk ? (
        <p className="mt-2 text-base" data-testid="terminal-desk-session">
          {desk} is logged in at a desk on this browser. Signing on here ends that session.
        </p>
      ) : null}
      <form
        noValidate
        aria-label="Sign on"
        className="mt-4 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setMessage(undefined);
          if (username.trim() === '' || password === '') {
            setMessage('Enter your user name and password.');
            return;
          }
          submit.mutate();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={userId} className="text-lg font-medium">
            User name
          </label>
          <input
            id={userId}
            data-testid="terminal-username"
            value={username}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={passwordId} className="text-lg font-medium">
            Password
          </label>
          <input
            id={passwordId}
            type="password"
            data-testid="terminal-password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            className={inputClass}
          />
        </div>
        {message ? (
          <p
            role="alert"
            data-testid="terminal-sign-on-message"
            className="rounded border border-red-800 bg-red-50 p-3 text-red-950"
          >
            {message}
          </p>
        ) : null}
        <button
          type="submit"
          data-testid="terminal-sign-on"
          disabled={submit.isPending}
          className={primary}
        >
          {submit.isPending ? 'Signing on…' : 'Sign on'}
        </button>
      </form>
    </section>
  );
}

/**
 * The screen of a signed-in terminal user: the view (REST, then the pushed one), sign-on here if
 * the session isn't, and sign-off. Mounted per (user, work center).
 */
function TerminalWork({
  workCenter,
  session,
}: {
  readonly workCenter: string;
  readonly session: SessionDto;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const user = session.user;
  const key = terminalKeys.view(user.username, workCenter);
  const rest = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getTerminalView(workCenter, signal),
  });
  const live = useLiveTerminal(workCenter);
  const view = live ?? rest.data;
  const [message, setMessage] = useState<string | undefined>(() =>
    queryClient.getQueryData<string>(terminalKeys.refusal(user.username, workCenter)),
  );
  /** A write's answer, shown at once in whichever copy is on screen. */
  const patch = (change: (view: TerminalViewDto) => TerminalViewDto) => {
    for (const k of [key, liveKeys.terminal(workCenter)] as const) {
      const known = queryClient.getQueryData<TerminalViewDto>(k);
      if (known) queryClient.setQueryData<TerminalViewDto>(k, change(known));
    }
  };
  const join = useMutation({
    mutationFn: () => signOn(workCenter),
    onSuccess: () => {
      setMessage(undefined);
      // Signed on now: the refusal kept from the login is no longer true (#190 re-review).
      queryClient.removeQueries({
        queryKey: terminalKeys.refusal(user.username, workCenter),
        exact: true,
      });
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => {
      setMessage(terminalFailure(error, 'Not signed on').text);
    },
  });
  const leave = useMutation({
    mutationFn: async () => {
      await signOff(workCenter).catch(() => undefined);
      await auth.logOut();
    },
  });
  if (rest.error && !view) {
    return (
      <QueryError
        what="this work center"
        error={rest.error}
        onRetry={() => {
          void rest.refetch();
        }}
      />
    );
  }
  if (!view) return <p role="status">Loading the work center…</p>;
  const here = signedOnHere(view, user.id);
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white p-4 shadow">
        <div>
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-bold"
            data-testid="terminal-title"
          >
            {view.workCenter.name}
          </h1>
          <p className="text-base text-slate-700">
            <span data-testid="terminal-user" className="font-semibold">
              {user.username}
            </span>
            {here ? ' is signed on' : ' is logged in but not signed on here'}
            {view.shift ? ` · shift ${view.shift.key}` : ' · no shift running'}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {here ? null : (
            <button
              type="button"
              data-testid="terminal-join"
              className={primary}
              disabled={join.isPending}
              onClick={() => {
                join.mutate();
              }}
            >
              Sign on here
            </button>
          )}
          <button
            type="button"
            data-testid="terminal-sign-off"
            className={secondary}
            disabled={leave.isPending}
            onClick={() => {
              leave.mutate();
            }}
          >
            {here ? 'Sign off' : 'Log out'}
          </button>
        </div>
      </section>
      {message ? (
        <p
          role="alert"
          className="rounded border border-red-800 bg-red-50 p-3 text-lg text-red-950"
        >
          {message}
        </p>
      ) : null}
      <QualityBanners view={view} />
      <Machines view={view} />
      <Crew view={view} />
      <section aria-labelledby="terminal-orders">
        <h2 id="terminal-orders" className="text-xl font-bold">
          Orders at this work center
        </h2>
        {view.orders.length === 0 ? (
          <p className="mt-2 text-slate-700">No order is active here.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-4">
            {view.orders.map((order) => (
              <OrderCard
                key={order.order.id}
                order={order}
                workCenter={workCenter}
                userId={user.id}
                signedOn={here}
                onOperation={(operation) => {
                  patch((v) => withOperation(v, operation));
                }}
              />
            ))}
          </ul>
        )}
      </section>
      <Queue view={view} />
      <ScrapRecords
        view={view}
        username={user.username}
        // Coding is offered to operators signed on here (or quality, who need no crew row).
        canCode={auth.can('scrap:code') && (here || !auth.can('terminal:operate'))}
        onCoded={(id) => {
          patch((v) => withoutScrapRecord(v, id));
        }}
      />
      {view.truncated ? (
        <p className="text-sm text-slate-700">More orders or scrap records exist than are shown.</p>
      ) : null}
    </div>
  );
}

/**
 * What quality says about this work center (#203, plan "Operator terminal"), read-only: open
 * holds that touch its orders, SPC episodes of its machines that are open or not yet
 * acknowledged, and the lots of each machine's last cycle. Announced politely as they change.
 */
function QualityBanners({ view }: { readonly view: TerminalViewDto }) {
  const { holds, signals, lots, truncated } = view.quality;
  // The section and both live lists stay mounted while empty (#203 final review): a live region
  // inserted together with its first item is not announced, so the first hold or signal at a work
  // center would pass unannounced. Empty lists take no space.
  return (
    <section
      aria-labelledby="terminal-quality"
      data-testid="terminal-quality"
      data-empty={String(holds.length === 0 && signals.length === 0 && lots.length === 0)}
      className="flex flex-col gap-3"
    >
      <h2 id="terminal-quality" className="sr-only">
        Quality
      </h2>
      <ul
        className="flex flex-col gap-2 empty:hidden"
        data-testid="terminal-holds"
        data-count={holds.length}
        aria-live="polite"
        aria-label="Quality holds"
      >
        {holds.map(({ hold, orders }) => (
          <li
            key={hold.id}
            data-testid={`terminal-hold-${hold.id}`}
            data-subject={`${hold.subject.kind}:${hold.subject.id}`}
            className="rounded-lg border-4 border-red-800 bg-red-50 p-4 text-red-950"
          >
            <p className="text-xl font-bold">Quality hold: {subjectText(hold.subject)}</p>
            <p className="text-lg">
              {hold.reason} · orders here: {orders.join(', ')} · {hold.scope.units} unit
              {hold.scope.units === 1 ? '' : 's'} held so far · opened by {hold.openedBy}{' '}
              {formatPlantTime(hold.openedPlantAt ?? hold.openedAt)}
            </p>
            <p className="text-base">
              Keep the held goods apart; quality releases or rejects the hold. The order cannot be
              closed while it is open.
            </p>
          </li>
        ))}
      </ul>
      <ul
        className="flex flex-col gap-2 empty:hidden"
        data-testid="terminal-signals"
        data-count={signals.length}
        aria-live="polite"
        aria-label="SPC signals"
      >
        {signals.map((signal) => (
          <li
            key={signal.id}
            data-testid={`terminal-signal-${String(signal.id)}`}
            data-status={signal.status}
            data-open={String(isOpenEpisode(signal))}
            data-acknowledged={String(signal.acknowledged !== null)}
            className="rounded-lg border-4 border-amber-700 bg-amber-50 p-4 text-amber-950"
          >
            <p className="text-xl font-bold">
              SPC signal on {signal.characteristic}: {CHART_TEXT[signal.chart].short} chart, rule{' '}
              {signal.rule}
            </p>
            <p className="text-lg">
              {signal.ruleText} · since part {signal.first.partId},{' '}
              {formatPlantTime(signal.first.at)} · {SIGNAL_STATUS_TEXT[signal.status]}
              {isOpenEpisode(signal) ? ', still firing' : ', ended'} ·{' '}
              {signal.acknowledged
                ? `acknowledged by ${signal.acknowledged.by}`
                : 'not acknowledged yet'}
            </p>
          </li>
        ))}
      </ul>
      {lots.length > 0 ? (
        <div className="rounded-lg bg-white p-4 shadow" data-testid="terminal-lots">
          <h3 className="text-lg font-bold">Lots in use</h3>
          <ul className="mt-1 flex flex-col gap-1 text-base">
            {lots.map((l) => (
              <li key={l.equipment} data-testid={`terminal-lots-${l.equipment}`}>
                <span className="font-semibold">{l.equipment}</span> ({l.operation}), last cycle
                part {l.partId}
                {l.serial ? ` (${l.serial})` : ''} at {formatPlantTime(l.at)}:{' '}
                {l.lots.map((x, i) => (
                  <span
                    key={`${x.lot}-${String(i)}`}
                    data-testid={`terminal-lot-${x.lot}`}
                    data-held={String(x.held)}
                  >
                    {i > 0 ? ', ' : ''}
                    {x.material ? `${x.material} ` : ''}
                    <span className="font-mono">{x.lot}</span>
                    {x.held ? <strong className="text-red-900"> (on hold)</strong> : null}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {truncated ? (
        <p className="text-sm text-slate-700" data-testid="terminal-quality-truncated">
          More holds or signals exist than are shown here.
        </p>
      ) : null}
    </section>
  );
}

function Machines({ view }: { readonly view: TerminalViewDto }) {
  return (
    <section aria-labelledby="terminal-machines">
      <h2 id="terminal-machines" className="text-xl font-bold">
        Machines
      </h2>
      <ul className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {view.machines.map((m) => (
          <li
            key={m.id}
            data-testid={`terminal-machine-${m.id}`}
            className="rounded-lg bg-white p-4 shadow"
          >
            <p className="text-lg font-semibold">{m.name}</p>
            <p className="text-sm text-slate-600">
              <span className="font-mono">{m.id}</span> · {m.operation}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StateBadge state={m.state?.state} size="lg" testId={`terminal-state-${m.id}`} />
              {m.state?.cause ? <span className="text-sm">{m.state.cause}</span> : null}
            </div>
            <p className="mt-2 text-base" data-testid={`terminal-job-${m.id}`}>
              {m.job
                ? `Order ${m.job.orderId} (${m.job.product})`
                : m.orders.length > 0
                  ? `Orders here: ${m.orders.join(', ')}`
                  : 'No order here'}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Crew({ view }: { readonly view: TerminalViewDto }) {
  return (
    <section aria-labelledby="terminal-crew" className="rounded-lg bg-white p-4 shadow">
      <h2 id="terminal-crew" className="text-xl font-bold">
        Signed on
      </h2>
      {view.crew.length === 0 ? (
        <p className="mt-1 text-slate-700">Nobody is signed on.</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-2" data-testid="terminal-crew">
          {view.crew.map((c) => (
            <li key={c.id} className="rounded-full border border-slate-400 px-3 py-1 text-base">
              {c.username}{' '}
              <span className="text-sm text-slate-600">since {formatPlantTime(c.fromPlant)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OrderCard({
  order,
  workCenter,
  userId,
  signedOn,
  onOperation,
}: {
  readonly order: TerminalOrderDto;
  readonly workCenter: string;
  readonly userId: number;
  readonly signedOn: boolean;
  readonly onOperation: (operation: TerminalOperationDto) => void;
}) {
  const o = order.order;
  return (
    <li data-testid={`terminal-order-${o.id}`} className="rounded-lg bg-white p-4 shadow">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xl font-bold">
          Order <span className="font-mono">{o.id}</span>
        </h3>
        <p className="text-base">
          {o.product} · {o.quantity} pcs ·{' '}
          <span data-testid={`terminal-order-status-${o.id}`}>{o.status}</span> · WIP here{' '}
          <span data-testid={`terminal-wip-${o.id}`}>{order.wip}</span>
        </p>
      </div>
      <ul className="mt-3 flex flex-col gap-3">
        {order.operations.map((op) => (
          <OperationRow
            key={op.operation}
            operation={op}
            orderStatus={o.status}
            workCenter={workCenter}
            userId={userId}
            signedOn={signedOn}
            onOperation={onOperation}
          />
        ))}
      </ul>
    </li>
  );
}

function OperationRow({
  operation,
  orderStatus,
  workCenter,
  userId,
  signedOn,
  onOperation,
}: {
  readonly operation: TerminalOrderDto['operations'][number];
  readonly orderStatus: string;
  readonly workCenter: string;
  readonly userId: number;
  readonly signedOn: boolean;
  readonly onOperation: (operation: TerminalOperationDto) => void;
}) {
  const [pausing, setPausing] = useState(false);
  const [reason, setReason] = useState<PauseReason | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const id = `${operation.orderId}-${operation.operation}`;
  const mine = myActivity(operation, userId);
  const write = useMutation({
    mutationFn: (action: OperationAction) =>
      operationWrite(
        { workCenter, orderId: operation.orderId, operation: operation.operation },
        action,
        action === 'sign-off'
          ? { version: operation.version }
          : action === 'pause'
            ? { activity: mine?.id ?? null, reason: reason ?? 'other' }
            : { activity: mine?.id ?? null },
      ),
    onSuccess: (result) => {
      setMessage(undefined);
      setPausing(false);
      setReason(undefined);
      onOperation(result.operation);
    },
    onError: (error, action) => {
      setMessage(terminalFailure(error, ACTION_NOT[action]).text);
    },
  });
  const actions = signedOn
    ? operationActions(operation, orderStatus, userId)
    : { start: false, pause: false, resume: false, signOff: false };
  const others = operation.activities.filter((a) => a.userId !== userId);
  const c = operation.counts;
  return (
    <li data-testid={`terminal-op-${id}`} className="rounded-lg border-2 border-slate-300 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-lg font-semibold">{operation.operation}</p>
        <p className="text-base tabular-nums" data-testid={`terminal-counts-${id}`}>
          in {c.in} · good {c.good} · scrap {c.scrap} · rework {c.rework}
        </p>
      </div>
      <p className="mt-1 text-base" data-testid={`terminal-op-state-${id}`}>
        {operation.signedOff
          ? `Signed off by ${operation.signedOff.username} at ${formatPlantTime(operation.signedOff.plantAt)}`
          : operation.complete
            ? 'Complete: ready to sign off'
            : 'Not complete yet'}
        {mine
          ? ` · You: ${mine.kind === 'work' ? 'working' : `paused (${PAUSE_REASON_LABELS[mine.reason ?? 'other']})`}`
          : ''}
        {others.length > 0
          ? ` · ${others.map((a) => `${a.username} ${a.kind === 'work' ? 'working' : 'paused'}`).join(', ')}`
          : ''}
      </p>
      <div className="mt-2 flex flex-wrap gap-3">
        {actions.start ? (
          <button
            type="button"
            data-testid={`terminal-start-${id}`}
            className={primary}
            disabled={write.isPending}
            onClick={() => {
              write.mutate('start');
            }}
          >
            Start
          </button>
        ) : null}
        {actions.pause && !pausing ? (
          <button
            type="button"
            data-testid={`terminal-pause-${id}`}
            className={warning}
            disabled={write.isPending}
            onClick={() => {
              setPausing(true);
            }}
          >
            Pause
          </button>
        ) : null}
        {actions.resume ? (
          <button
            type="button"
            data-testid={`terminal-resume-${id}`}
            className={primary}
            disabled={write.isPending}
            onClick={() => {
              write.mutate('resume');
            }}
          >
            Resume
          </button>
        ) : null}
        {actions.signOff ? (
          <button
            type="button"
            data-testid={`terminal-sign-off-${id}`}
            className={secondary}
            disabled={write.isPending}
            onClick={() => {
              write.mutate('sign-off');
            }}
          >
            Sign off operation
          </button>
        ) : null}
      </div>
      {pausing && actions.pause ? (
        <fieldset
          className="mt-3 rounded-lg border-2 border-amber-700 p-3"
          data-testid={`terminal-pause-reasons-${id}`}
        >
          <legend className="px-1 text-lg font-semibold">Why do you pause?</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {PAUSE_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={reason === r}
                data-testid={`terminal-reason-${id}-${r}`}
                className={reason === r ? primary : secondary}
                onClick={() => {
                  setReason(r);
                }}
              >
                {PAUSE_REASON_LABELS[r]}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              data-testid={`terminal-pause-confirm-${id}`}
              className={warning}
              disabled={reason === undefined || write.isPending}
              onClick={() => {
                write.mutate('pause');
              }}
            >
              Pause now
            </button>
            <button
              type="button"
              className={secondary}
              onClick={() => {
                setPausing(false);
                setReason(undefined);
              }}
            >
              Cancel
            </button>
          </div>
        </fieldset>
      ) : null}
      {message ? (
        <p
          role="alert"
          data-testid={`terminal-op-message-${id}`}
          className="mt-2 rounded border border-red-800 bg-red-50 p-2 text-base text-red-950"
        >
          {message}
        </p>
      ) : null}
    </li>
  );
}

const ACTION_NOT: Readonly<Record<OperationAction, string>> = {
  start: 'Not started',
  pause: 'Not paused',
  resume: 'Not resumed',
  'sign-off': 'Not signed off',
};

function Queue({ view }: { readonly view: TerminalViewDto }) {
  return (
    <section aria-labelledby="terminal-queue" className="rounded-lg bg-white p-4 shadow">
      <h2 id="terminal-queue" className="text-xl font-bold">
        Coming up
      </h2>
      {view.queue.length === 0 ? (
        <p className="mt-1 text-slate-700">No released or dispatched order waits.</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1 text-base" data-testid="terminal-queue">
          {view.queue.map((q) => (
            <li key={q.order.id}>
              <span className="font-mono font-semibold">{q.order.id}</span> · {q.order.product} ·{' '}
              {q.order.quantity} pcs · {q.order.status}
              {q.equipment ? ` on ${q.equipment}` : ''} · planned{' '}
              {formatPlantTime(q.order.plannedStart)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ScrapRecords({
  view,
  username,
  canCode,
  onCoded,
}: {
  readonly view: TerminalViewDto;
  readonly username: string;
  readonly canCode: boolean;
  readonly onCoded: (id: number) => void;
}) {
  const reasons = useQuery({
    queryKey: terminalKeys.scrapReasons(username),
    queryFn: ({ signal }) => getScrapReasons(signal),
    staleTime: 60_000,
    enabled: canCode && view.scrapRecords.length > 0,
  });
  return (
    <section aria-labelledby="terminal-scrap" className="rounded-lg bg-white p-4 shadow">
      <h2 id="terminal-scrap" className="text-xl font-bold">
        Scrap to code
      </h2>
      {view.scrapRecords.length === 0 ? (
        <p className="mt-1 text-slate-700">No scrap waits for a reason.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-3">
          {view.scrapRecords.map((record) => (
            <ScrapCoding
              key={record.id}
              record={record}
              reasons={reasons.data?.reasons ?? []}
              canCode={canCode}
              onCoded={onCoded}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ScrapCoding({
  record,
  reasons,
  canCode,
  onCoded,
}: {
  readonly record: ScrapRecordDto;
  readonly reasons: readonly { id: string; name: string; active: boolean; parent: string | null }[];
  readonly canCode: boolean;
  readonly onCoded: (id: number) => void;
}) {
  const [reason, setReason] = useState<string | undefined>(undefined);
  const [comment, setComment] = useState('');
  const [message, setMessage] = useState<string | undefined>(undefined);
  const commentId = useId();
  const code = useMutation({
    mutationFn: () =>
      codeScrap(record.id, {
        version: record.version,
        reason: reason ?? record.machineReason,
        ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
      }),
    onSuccess: () => {
      onCoded(record.id);
    },
    onError: (error) => {
      setMessage(terminalFailure(error, 'Not coded').text);
    },
  });
  const choices = codableReasons(reasons, record.machineReason);
  return (
    <li
      data-testid={`terminal-scrap-${String(record.id)}`}
      className="rounded-lg border-2 border-slate-300 p-3"
    >
      <p className="text-lg font-semibold">
        {record.operation} · {record.machineReason}
      </p>
      <p className="text-base text-slate-700">
        {record.serial ?? `part ${String(record.partId)}`} · order {record.orderId ?? '—'} ·{' '}
        {record.equipment} · {formatPlantTime(record.scrappedAt)}
      </p>
      {canCode ? (
        <>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {choices.map((r) => (
              <button
                key={r.id}
                type="button"
                aria-pressed={reason === r.id}
                data-testid={`terminal-scrap-reason-${String(record.id)}-${r.id}`}
                className={reason === r.id ? primary : secondary}
                onClick={() => {
                  setReason(r.id);
                }}
              >
                {r.name}
              </button>
            ))}
          </div>
          <label htmlFor={commentId} className="mt-2 block text-base font-medium">
            Comment (optional)
          </label>
          <input
            id={commentId}
            data-testid={`terminal-scrap-comment-${String(record.id)}`}
            value={comment}
            maxLength={500}
            onChange={(event) => {
              setComment(event.target.value);
            }}
            className={`${inputClass} w-full`}
          />
          <button
            type="button"
            data-testid={`terminal-scrap-code-${String(record.id)}`}
            className={`${primary} mt-3`}
            disabled={reason === undefined || code.isPending}
            onClick={() => {
              code.mutate();
            }}
          >
            Code scrap
          </button>
        </>
      ) : null}
      {message ? (
        <p
          role="alert"
          className="mt-2 rounded border border-red-800 bg-red-50 p-2 text-base text-red-950"
        >
          {message}
        </p>
      ) : null}
    </li>
  );
}
