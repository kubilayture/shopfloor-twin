import { PAUSE_REASONS, type PauseReason, type SessionDto } from '@shopfloor/contracts/mes-api';
import type {
  EquipmentDto,
  ScrapRecordDto,
  TerminalOperationDto,
  TerminalOrderDto,
  TerminalViewDto,
} from '@shopfloor/contracts/mes-api';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
import { OfflineBar } from '../components/offline-bar.tsx';
import { SIGNAL_LOOK } from '../components/quality-ui.tsx';
import { QueryError } from '../components/query-error.tsx';
import { StateBadge } from '../components/state-badge.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Card } from '../components/ui/card.tsx';
import { Code } from '../components/ui/code.tsx';
import { Disclosure } from '../components/ui/disclosure.tsx';
import { TextInput } from '../components/ui/controls.tsx';
import { ConfirmDialog } from '../components/ui/dialog.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { PlantTime, WallTime } from '../components/ui/format.tsx';
import { Icon } from '../components/ui/icons.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { usePageTitle } from '../components/ui/use-page-title.ts';
import { loginFailure } from '../domain/identity.ts';
import { ORDER_STATUS_TEXT, ORDER_STATUS_TONE } from '../domain/orders.ts';
import { groupEquipment } from '../domain/plant.ts';
import { abnormalTone, newest, stateStyle, worstTone } from '../domain/states.ts';
import {
  PAUSE_REASON_LABELS,
  codableReasons,
  myActivity,
  operationActions,
  signedOnHere,
  splitOrders,
  terminalFailure,
  withOperation,
  withoutScrapRecord,
} from '../domain/terminal.ts';
import { CHART_TEXT, SIGNAL_STATUS_TEXT, isOpenEpisode, subjectText } from '../domain/quality.ts';
import { formatPlantTime } from '../domain/time.ts';
import { liveKeys } from '../live/live-cache.ts';
import { useLiveStates, useLiveTerminal } from '../live/live-context.tsx';
import { countOf } from '../domain/words.ts';

// The operator terminal (#177, plan "Operator terminal"; tablet first since UX-7, #330):
// `/terminal` picks a work center (a desk page in the shell), `/terminal/$workCenter` is the
// tablet screen itself, outside the app's layout: 56 px touch targets (`touch` buttons and
// fields), laid out for 1024 × 768 and 768 × 1024 and still whole at 390 px, its own sign-on with
// a `terminal` session. Everything it holds is keyed by (user, work center): sign-off and a
// session's end empty the query cache, stop the live client and unmount every draft, so the next
// operator sees nothing of the previous one's.

/** The terminal's content width and gutters: its top bar, offline bar and `main` line up. */
const FRAME = 'mx-auto w-full max-w-6xl px-4 md:px-6';

/** `/terminal`: the work centers as large tiles, each a link to its terminal screen. */
export function TerminalPicker() {
  const auth = useAuth();
  const equipment = useQuery({
    queryKey: queryKeys.equipmentList,
    queryFn: ({ signal }) => listEquipment(signal),
  });
  const username = auth.session?.user.username ?? '';
  const areas = groupEquipment(equipment.data ?? []);
  return (
    <section aria-labelledby="terminal-picker">
      <PageHeader
        id="terminal-picker"
        title="Operator terminal"
        description="Choose the work center this tablet stands at; operators sign on there."
      />
      {equipment.error ? (
        <QueryError
          what="the work centers"
          error={equipment.error}
          onRetry={() => {
            void equipment.refetch();
          }}
        />
      ) : equipment.isPending ? (
        <Skeleton shape="card" label="Loading the work centers…" />
      ) : areas.length === 0 ? (
        <EmptyState
          title="No work centers yet"
          body="The plant's master data is not seeded, so there is no terminal to choose."
        />
      ) : (
        <ul
          className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
          data-testid="terminal-work-centers"
        >
          {areas.flatMap((area) =>
            area.workCenters.map((wc) => (
              <WorkCenterTile
                key={wc.id}
                id={wc.id}
                name={wc.name}
                area={area.name}
                equipment={wc.equipment}
                username={username}
              />
            )),
          )}
        </ul>
      )}
    </section>
  );
}

/**
 * A work center to choose by (X-01): its name, its machines and their states, who is signed on and
 * the order in progress, read from its terminal view (and kept live by its push topic); a 4 px bar
 * in the tone of its worst machine when one costs output. The whole tile is the link.
 */
function WorkCenterTile({
  id,
  name,
  area,
  equipment,
  username,
}: {
  readonly id: string;
  readonly name: string;
  readonly area: string;
  readonly equipment: readonly EquipmentDto[];
  readonly username: string;
}) {
  const rest = useQuery({
    queryKey: terminalKeys.tile(username, id),
    queryFn: ({ signal }) => getTerminalView(id, signal),
  });
  const view = useLiveTerminal(id) ?? rest.data;
  const states = useLiveStates();
  const machines = equipment.map((item) => ({
    item,
    state: newest(item.current, states?.states[item.id])?.state,
  }));
  const tone = worstTone(machines.map((m) => abnormalTone(m.state)));
  const running = view?.orders.find((o) => o.order.status === 'in-progress')?.order;
  // Named by the work center alone; the rest describes it (UX-7 review L3), so a screen reader
  // reads "Line A1, link" first and the machines, crew and order after it.
  const factsId = useId();
  const machinesId = useId();
  const crewId = useId();
  const orderId = useId();
  return (
    <li
      data-testid={`terminal-tile-${id}`}
      data-tone={tone ?? 'normal'}
      className={`relative flex h-full flex-col gap-3 rounded-lg border border-line bg-surface p-5 text-ink hover:bg-surface-hover motion-safe:transition-colors motion-safe:duration-fast ${tone ? TONE_BAR[tone] : ''}`}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          {/* The link is the name (its visible text, WCAG 2.5.3); its box covers the whole
                tile (a 56 px target and more), with the focus ring around the tile. */}
          <Link
            to="/terminal/$workCenter"
            params={{ workCenter: id }}
            data-testid={`terminal-link-${id}`}
            aria-describedby={`${factsId} ${machinesId} ${crewId} ${orderId}`}
            className="block text-xl font-semibold outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-focus"
          >
            {name}
          </Link>
          <span id={factsId} className="block text-sm text-ink-secondary">
            {area} · <Code>{id}</Code>
          </span>
        </span>
        <Icon name="chevron-right" size={24} className="mt-0.5 text-ink-secondary" />
      </span>
      <span
        id={machinesId}
        className="flex flex-col gap-1.5"
        data-testid={`terminal-tile-machines-${id}`}
      >
        {machines.map(({ item, state }, i) => (
          <span key={item.id} className="flex flex-wrap items-center justify-between gap-2">
            {/* The space and comma part the words in the link's description, not on screen. */}
            <span className="min-w-0 text-sm">{item.name}</span> <StateBadge state={state} />
            {i < machines.length - 1 ? <span className="sr-only">,</span> : null}
          </span>
        ))}
      </span>
      <span className="mt-auto flex flex-col gap-1 border-t border-line-subtle pt-3 text-sm">
        <span
          id={crewId}
          className="flex items-start gap-2"
          data-testid={`terminal-tile-crew-${id}`}
        >
          <Icon name="user" size={16} className="mt-0.5 text-ink-secondary" />
          {view === undefined ? (
            <span className="text-ink-secondary">
              {rest.error ? 'Crew not known: the work center could not be read' : 'Reading…'}
            </span>
          ) : view.crew.length === 0 ? (
            <span className="text-ink-secondary">Nobody signed on</span>
          ) : (
            <span>
              Signed on:{' '}
              <span className="font-medium">{view.crew.map((c) => c.username).join(', ')}</span>
            </span>
          )}
        </span>
        <span
          id={orderId}
          className="flex items-start gap-2"
          data-testid={`terminal-tile-order-${id}`}
        >
          <Icon name="play" size={16} className="mt-0.5 text-ink-secondary" />
          {view === undefined ? (
            <span className="text-ink-secondary">Order not known</span>
          ) : running ? (
            <span>
              In progress: <Code className="font-medium">{running.id}</Code> · {running.product}
            </span>
          ) : (
            <span className="text-ink-secondary">No order in progress</span>
          )}
        </span>
      </span>
    </li>
  );
}

/** The 4 px bar of an abnormal item (design system 4.3); written out in full for Tailwind. */
const TONE_BAR = {
  neutral: 'border-l-4 border-l-neutral-border',
  info: 'border-l-4 border-l-info-border',
  ok: 'border-l-4 border-l-ok-border',
  warn: 'border-l-4 border-l-warn-border',
  caution: 'border-l-4 border-l-caution-border',
  alarm: 'border-l-4 border-l-alarm-border',
} as const;

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
  // This route has no desk shell, which starts the live client for a desk session: a signed-on
  // terminal opened or reloaded starts it here (#311). Starting is a no-op while it runs; sign-off
  // and a session's end stop it (`logOut`, `sessionLost`). On the session object, as the desk's
  // `SignedIn` does: a 4403 close stops the client and has the session read again, and a session
  // still valid then starts it again (#341 review, UX-7).
  const { startLive } = auth;
  const signedOn = user !== undefined;
  useEffect(() => {
    if (session?.kind === 'terminal' && !session.user.mustChangePassword) startLive();
  }, [startLive, session]);
  // The work center's name (X-02), from the plant's equipment once a session may read it.
  const equipment = useQuery({
    queryKey: queryKeys.equipmentList,
    queryFn: ({ signal }) => listEquipment(signal),
    enabled: session !== undefined && session !== null && !session.user.mustChangePassword,
  });
  const name = equipment.data?.find((e) => e.workCenter.id === workCenter)?.workCenter.name;
  usePageTitle(name === undefined ? undefined : `Terminal ${name}`);
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink" data-testid="terminal-screen">
      <TerminalHeader workCenter={workCenter} name={name} signedOn={signedOn} />
      {/* Only for a signed-on operator, whose screen is live; the sign-on page starts no client. */}
      {signedOn ? <OfflineBar variant="terminal" /> : null}
      <main id="main" tabIndex={-1} className={`${FRAME} flex-1 py-6`}>
        {session === undefined ? (
          <p role="status" className="text-lg text-ink-secondary">
            Checking your session…
          </p>
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
          <SignOn key={workCenter} workCenter={workCenter} name={name} session={session} />
        )}
      </main>
    </div>
  );
}

/**
 * The terminal's own top bar, 56 px on the shell's dark surface: the work center's name and id
 * (X-02), the plant clock, the live connection's state only for a signed-on terminal session
 * (#311: before sign-on this route never starts the live client, so a desk session in the same
 * browser would read a stopped client as "Offline") and the way back to the picker (X-04).
 */
function TerminalHeader({
  workCenter,
  name,
  signedOn,
}: {
  readonly workCenter: string;
  readonly name: string | undefined;
  readonly signedOn: boolean;
}) {
  const { clock } = usePlantClock();
  return (
    <header
      className="z-topbar bg-topbar text-topbar-ink md:sticky md:top-0 print:hidden"
      data-surface="dark"
      data-print="hidden"
    >
      <div className={`${FRAME} flex min-h-14 flex-wrap items-center gap-x-6 gap-y-1 py-1`}>
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-lg font-semibold" data-testid="terminal-work-center">
            {name ?? 'Terminal'}
          </span>
          <Code className="text-nav-heading">{workCenter}</Code>
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-x-6 gap-y-1">
          <p className="whitespace-nowrap text-base tabular-nums" data-testid="terminal-clock">
            {clock ? (
              <>
                Plant time{' '}
                <time dateTime={clock.watermark} className="font-semibold tabular-nums">
                  {formatPlantTime(clock.watermark)}
                </time>
              </>
            ) : (
              'No plant time yet'
            )}
          </p>
          {signedOn ? <ConnectionStatus /> : null}
          <Link
            to="/terminal"
            data-testid="terminal-change"
            className="-mx-2 inline-flex min-h-14 items-center gap-1 rounded-md px-2 text-base font-medium underline-offset-4 hover:bg-nav-hover hover:underline motion-safe:transition-colors motion-safe:duration-fast"
          >
            <Icon name="chevron-left" size={20} />
            Change work center
          </Link>
        </div>
      </div>
    </header>
  );
}

/** User name and password at the terminal: a `terminal` session, then the crew row here. */
function SignOn({
  workCenter,
  name,
  session,
}: {
  readonly workCenter: string;
  readonly name: string | undefined;
  readonly session: SessionDto | null;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | undefined>(undefined);
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
    <section aria-labelledby="sign-on" className="mx-auto w-full max-w-lg md:mt-6">
      <Card>
        <h1 id="sign-on" ref={heading} tabIndex={-1} className="text-3xl font-semibold">
          Sign on
        </h1>
        <p className="mt-1 text-base text-ink-secondary">
          At {name ?? <Code>{workCenter}</Code>}, with your own user name and password.
        </p>
        {desk ? (
          <Callout tone="warn" size="touch" className="mt-4" data-testid="terminal-desk-session">
            {desk} is logged in at a desk on this browser. Signing on here ends that session.
          </Callout>
        ) : null}
        <form
          noValidate
          aria-label="Sign on"
          className="mt-5 flex flex-col gap-5"
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
          <TextInput
            label={<span className="text-lg">User name</span>}
            name="username"
            size="touch"
            data-testid="terminal-username"
            value={username}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
          />
          <TextInput
            label={<span className="text-lg">Password</span>}
            name="password"
            type="password"
            size="touch"
            data-testid="terminal-password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
          {message ? (
            <Callout tone="alarm" size="touch" role="alert" data-testid="terminal-sign-on-message">
              {message}
            </Callout>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            size="touch"
            fullWidth
            icon="user"
            data-testid="terminal-sign-on"
            loading={submit.isPending}
          >
            Sign on
          </Button>
        </form>
      </Card>
    </section>
  );
}

/** A section of the terminal screen: a 24 px heading (`h2`), then its content. */
function TerminalSection({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <h2 id={id} className="text-2xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * The screen of a signed-in terminal user, top to bottom: who is signed on and the session's
 * actions; what quality says (holds and signals, in their tones); the orders with their
 * operations to start, pause, resume and sign off; the scrap to code. Beside them on a landscape
 * tablet (below them in portrait) the machines and the orders coming up. The view comes from
 * REST, then the pushed one. Mounted per (user, work center).
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
  const { clock } = usePlantClock();
  const user = session.user;
  const key = terminalKeys.view(user.username, workCenter);
  const rest = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getTerminalView(workCenter, signal),
  });
  const live = useLiveTerminal(workCenter);
  const view = live ?? rest.data;
  /** Orders seen active on this screen: one signed off here stays in view (`splitOrders`). */
  const [seenActive, setSeenActive] = useState<ReadonlySet<string>>(() => new Set());
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
  if (!view) return <Skeleton shape="card" label="Loading the work center…" />;
  const here = signedOnHere(view, user.id);
  const orders = splitOrders(view.orders, seenActive);
  // Remembered once seen active, so an order whose last operation is signed off here stays in view
  // (state set while rendering: React renders again at once, before anything is shown).
  const newlyActive = orders.active.filter((o) => !seenActive.has(o.order.id));
  if (newlyActive.length > 0) {
    setSeenActive(new Set([...seenActive, ...newlyActive.map((o) => o.order.id)]));
  }
  const at = clock?.watermark;
  // Coding is offered to operators signed on here (or quality, who need no crew row).
  const canCode = auth.can('scrap:code') && (here || !auth.can('terminal:operate'));
  const codeHint = canCode
    ? undefined
    : auth.can('scrap:code')
      ? 'Sign on here to code scrap.'
      : 'Your role does not code scrap.';
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <h1
              ref={heading}
              tabIndex={-1}
              className="text-3xl font-semibold"
              data-testid="terminal-title"
            >
              {view.workCenter.name}
            </h1>
            <p className="mt-1 text-lg">
              <span data-testid="terminal-user" className="font-semibold">
                {user.username}
              </span>
              {here ? ' is signed on' : ' is logged in but not signed on here'}
              {view.shift ? ` · shift ${view.shift.key}` : ' · no shift running'}
            </p>
          </div>
          <div className="flex flex-wrap gap-3 *:max-md:flex-1">
            <Button
              variant="secondary"
              size="touch"
              icon="logout"
              data-testid="terminal-sign-off"
              loading={leave.isPending}
              onClick={() => {
                leave.mutate();
              }}
            >
              {here ? 'Sign off' : 'Log out'}
            </Button>
            {here ? null : (
              <Button
                variant="primary"
                size="touch"
                icon="user"
                data-testid="terminal-join"
                loading={join.isPending}
                onClick={() => {
                  join.mutate();
                }}
              >
                Sign on here
              </Button>
            )}
          </div>
        </div>
        <Crew view={view} at={at} />
      </Card>
      {message ? (
        <Callout tone="alarm" size="touch" role="alert">
          {message}
        </Callout>
      ) : null}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <QualityBanners view={view} at={at} />
          <TerminalSection id="terminal-orders" title="Orders at this work center">
            {view.orders.length === 0 ? (
              <Card padding="compact">
                <EmptyState
                  size="inline"
                  icon="info"
                  title={<span className="text-lg">No order is active here.</span>}
                  body={
                    <span className="text-base">
                      Released and dispatched orders are listed under Coming up.
                    </span>
                  }
                />
              </Card>
            ) : (
              <>
                {orders.active.length > 0 ? (
                  <ul className="flex flex-col gap-4">
                    {orders.active.map((order) => (
                      <OrderCard
                        key={order.order.id}
                        order={order}
                        workCenter={workCenter}
                        userId={user.id}
                        signedOn={here}
                        at={at}
                        onOperation={(operation) => {
                          patch((v) => withOperation(v, operation));
                        }}
                      />
                    ))}
                  </ul>
                ) : null}
                {orders.done.length > 0 ? (
                  // Finished orders (all operations signed off) in one line, so the work stays
                  // first on a shift with older orders (UX-7 review); every test id inside.
                  <Disclosure
                    testId="terminal-orders-done"
                    summary={
                      <span className="inline-flex min-h-14 items-center text-lg">
                        {orders.done.length === 1
                          ? '1 completed order, signed off'
                          : `${String(orders.done.length)} completed orders, signed off`}
                      </span>
                    }
                  >
                    <ul className="flex flex-col gap-4">
                      {orders.done.map((order) => (
                        <OrderCard
                          key={order.order.id}
                          order={order}
                          workCenter={workCenter}
                          userId={user.id}
                          signedOn={here}
                          at={at}
                          onOperation={(operation) => {
                            patch((v) => withOperation(v, operation));
                          }}
                        />
                      ))}
                    </ul>
                  </Disclosure>
                ) : null}
              </>
            )}
          </TerminalSection>
          <ScrapRecords
            view={view}
            username={user.username}
            canCode={canCode}
            codeHint={codeHint}
            at={at}
            onCoded={(id) => {
              patch((v) => withoutScrapRecord(v, id));
            }}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Lots view={view} at={at} />
          <Machines view={view} />
          <Queue view={view} />
        </div>
      </div>
      {view.truncated ? (
        <p className="text-base text-ink-secondary">
          More orders or scrap records exist than are shown.
        </p>
      ) : null}
    </div>
  );
}

/** Who is signed on here, each since when: the operator's own name is among them. */
function Crew({ view, at }: { readonly view: TerminalViewDto; readonly at: string | undefined }) {
  return (
    <section
      aria-labelledby="terminal-crew"
      className="mt-4 flex flex-col gap-2 border-t border-line-subtle pt-4"
    >
      <h2 id="terminal-crew" className="text-lg font-semibold">
        Signed on here
      </h2>
      {view.crew.length === 0 ? (
        <p className="text-lg text-ink-secondary">Nobody is signed on.</p>
      ) : (
        <ul className="flex flex-wrap gap-2" data-testid="terminal-crew">
          {view.crew.map((c) => (
            <li
              key={c.id}
              className="inline-flex flex-wrap items-baseline gap-x-2 rounded-full border border-line-strong bg-surface-sunken px-4 py-1.5 text-lg font-medium"
            >
              {c.username}
              <span className="text-base font-normal text-ink-secondary">
                since <PlantTime at={c.fromPlant} clock={at} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What quality says about this work center (#203, plan "Operator terminal"), read-only: open
 * holds that touch its orders (`alarm`), SPC episodes of its machines that are open or not yet
 * acknowledged (in their status's tone, design system 2.6). Announced politely as they change.
 * The lots of each machine's last cycle stand beside the work (`Lots`).
 */
function QualityBanners({
  view,
  at,
}: {
  readonly view: TerminalViewDto;
  readonly at: string | undefined;
}) {
  const { holds, signals, lots, truncated } = view.quality;
  // `data-empty` still counts the lots, which stand beside the work since UX-7 (review L1).
  const empty = holds.length === 0 && signals.length === 0 && lots.length === 0;
  const none = holds.length === 0 && signals.length === 0;
  // The section and both live lists stay mounted while empty (#203 final review): a live region
  // inserted together with its first item is not announced, so the first hold or signal at a work
  // center would pass unannounced. An empty list stays displayed (a live region must never be
  // `display: none`, #204 review) and cancels the gaps around it with negative margins.
  return (
    <section
      aria-labelledby="terminal-quality"
      data-testid="terminal-quality"
      data-empty={String(empty)}
      className={`flex flex-col gap-3${none && !truncated ? ' -mb-6' : ''}`}
    >
      <h2 id="terminal-quality" className="sr-only">
        Quality
      </h2>
      <ul
        className="flex flex-col gap-3 empty:-mb-3"
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
          >
            <Callout tone="alarm" size="touch" title={`Quality hold: ${subjectText(hold.subject)}`}>
              <p>
                {hold.reason} · orders here: {orders.join(', ')} ·{' '}
                {countOf(hold.scope.units, 'unit')} held so far · opened by {hold.openedBy}{' '}
                {hold.openedPlantAt === null ? (
                  <WallTime at={hold.openedAt} />
                ) : (
                  <PlantTime at={hold.openedPlantAt} clock={at} />
                )}
              </p>
              <p className="mt-1 text-base">
                Keep the held goods apart; quality releases or rejects the hold. The order cannot be
                closed while it is open.
              </p>
            </Callout>
          </li>
        ))}
      </ul>
      <ul
        className="flex flex-col gap-3 empty:-mb-3"
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
          >
            <Callout
              tone={SIGNAL_LOOK[signal.status].tone}
              size="touch"
              title={`SPC signal on ${signal.characteristic}: ${CHART_TEXT[signal.chart].short} chart, rule ${String(signal.rule)}`}
            >
              <p>
                {signal.ruleText} · since part {signal.first.partId},{' '}
                <PlantTime at={signal.first.at} clock={at} /> · {SIGNAL_STATUS_TEXT[signal.status]}
                {isOpenEpisode(signal) ? ', still firing' : ', ended'} ·{' '}
                {signal.acknowledged
                  ? `acknowledged by ${signal.acknowledged.by}`
                  : 'not acknowledged yet'}
              </p>
            </Callout>
          </li>
        ))}
      </ul>
      {truncated ? (
        <p className="text-base text-ink-secondary" data-testid="terminal-quality-truncated">
          More holds or signals exist than are shown here.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The lots of each machine's last cycle (#203), read-only, in the side column: on a landscape
 * tablet the operator's orders come first (UX-7 review L1).
 */
function Lots({ view, at }: { readonly view: TerminalViewDto; readonly at: string | undefined }) {
  const { lots } = view.quality;
  if (lots.length === 0) return null;
  return (
    <TerminalSection id="terminal-lots-title" title="Lots in use">
      <Card padding="compact" testId="terminal-lots">
        <ul className="flex flex-col gap-2 text-base">
          {lots.map((l) => (
            <li key={l.equipment} data-testid={`terminal-lots-${l.equipment}`}>
              <span className="font-semibold">{l.equipment}</span> ({l.operation}), last cycle part{' '}
              {l.partId}
              {l.serial ? ` (${l.serial})` : ''} at <PlantTime at={l.at} clock={at} />:{' '}
              {l.lots.map((x, i) => (
                <span
                  key={`${x.lot}-${String(i)}`}
                  data-testid={`terminal-lot-${x.lot}`}
                  data-held={String(x.held)}
                >
                  {i > 0 ? ', ' : ''}
                  {x.material ? `${x.material} ` : ''}
                  <Code>{x.lot}</Code>
                  {x.held ? (
                    <>
                      {' '}
                      <Badge tone="alarm" icon="alert">
                        On hold
                      </Badge>
                    </>
                  ) : null}
                </span>
              ))}
            </li>
          ))}
        </ul>
      </Card>
    </TerminalSection>
  );
}

/** The machines of the work center, each with its state; an abnormal one with its tone's bar. */
function Machines({ view }: { readonly view: TerminalViewDto }) {
  return (
    <TerminalSection id="terminal-machines" title="Machines">
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
        {view.machines.map((m) => (
          <li key={m.id} data-testid={`terminal-machine-${m.id}`}>
            <Card
              padding="compact"
              // The state's own 4 px bar when it costs output, as on the overview (2.4, UX-2).
              className={`h-full ${m.state ? (stateStyle(m.state.state).bar ?? '') : ''}`}
            >
              <p className="text-lg font-semibold">{m.name}</p>
              <p className="text-sm text-ink-secondary">
                <Code>{m.id}</Code> · {m.operation}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StateBadge state={m.state?.state} size="lg" testId={`terminal-state-${m.id}`} />
                {m.state?.cause ? <span className="text-base">{m.state.cause}</span> : null}
              </div>
              <p className="mt-2 text-base" data-testid={`terminal-job-${m.id}`}>
                {m.job
                  ? `Order ${m.job.orderId} (${m.job.product})`
                  : m.orders.length > 0
                    ? `Orders here: ${m.orders.join(', ')}`
                    : 'No order here'}
              </p>
            </Card>
          </li>
        ))}
      </ul>
    </TerminalSection>
  );
}

function OrderCard({
  order,
  workCenter,
  userId,
  signedOn,
  at,
  onOperation,
}: {
  readonly order: TerminalOrderDto;
  readonly workCenter: string;
  readonly userId: number;
  readonly signedOn: boolean;
  readonly at: string | undefined;
  readonly onOperation: (operation: TerminalOperationDto) => void;
}) {
  const o = order.order;
  return (
    <li data-testid={`terminal-order-${o.id}`}>
      <Card>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h3 className="text-2xl font-semibold">
            Order <Code>{o.id}</Code>
          </h3>
          {/* The word as on the desk, the raw status in `data-status` (#295); the tone (2.6). */}
          <Badge
            size="lg"
            tone={ORDER_STATUS_TONE[o.status]}
            icon={o.status === 'completed' ? 'check' : undefined}
            data-testid={`terminal-order-status-${o.id}`}
            data-status={o.status}
          >
            {ORDER_STATUS_TEXT[o.status]}
          </Badge>
        </div>
        <p className="mt-1 text-lg text-ink-secondary">
          {o.product} · {o.quantity} pcs · WIP here{' '}
          <span
            data-testid={`terminal-wip-${o.id}`}
            className="font-semibold text-ink tabular-nums"
          >
            {order.wip}
          </span>
        </p>
        <ul className="mt-4 flex flex-col gap-3">
          {order.operations.map((op) => (
            <OperationRow
              key={op.operation}
              operation={op}
              orderStatus={o.status}
              workCenter={workCenter}
              userId={userId}
              signedOn={signedOn}
              at={at}
              onOperation={onOperation}
            />
          ))}
        </ul>
      </Card>
    </li>
  );
}

/** "in 2 · good 2 · scrap 0 · rework 0", the figures emphasised; the text as the specs parse it. */
function Counts({
  id,
  counts,
}: {
  readonly id: string;
  readonly counts: TerminalOrderDto['operations'][number]['counts'];
}) {
  const parts = [
    ['in', counts.in],
    ['good', counts.good],
    ['scrap', counts.scrap],
    ['rework', counts.rework],
  ] as const;
  return (
    <p className="text-lg text-ink-secondary tabular-nums" data-testid={`terminal-counts-${id}`}>
      {parts.map(([label, value], i) => (
        <span key={label}>
          {i > 0 ? ' · ' : ''}
          {label} <span className="font-semibold text-ink">{value}</span>
        </span>
      ))}
    </p>
  );
}

function OperationRow({
  operation,
  orderStatus,
  workCenter,
  userId,
  signedOn,
  at,
  onOperation,
}: {
  readonly operation: TerminalOrderDto['operations'][number];
  readonly orderStatus: string;
  readonly workCenter: string;
  readonly userId: number;
  readonly signedOn: boolean;
  readonly at: string | undefined;
  readonly onOperation: (operation: TerminalOperationDto) => void;
}) {
  const [pausing, setPausing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState<PauseReason | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const stateRef = useRef<HTMLParagraphElement>(null);
  const focusState = useRef(false);
  useEffect(() => {
    if (confirming || !focusState.current) return;
    focusState.current = false;
    stateRef.current?.focus();
  }, [confirming]);
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
  /** The button of the write on its way shows it is busy; the others wait for it. */
  const busy = (action: OperationAction) =>
    write.isPending
      ? { loading: write.variables === action, disabled: write.variables !== action }
      : {};
  const working = mine?.kind === 'work';
  return (
    <li
      data-testid={`terminal-op-${id}`}
      className={`rounded-lg border border-line bg-surface-sunken p-4${working ? ' border-l-4 border-l-accent' : ''}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h4 className="text-xl font-semibold">{operation.operation}</h4>
        <Counts id={id} counts={operation.counts} />
      </div>
      <p
        ref={stateRef}
        tabIndex={-1}
        // Focused by script after a sign-off only: no ring, as a focused heading (G-22).
        className="mt-1 text-lg focus-visible:outline-none"
        data-testid={`terminal-op-state-${id}`}
      >
        {operation.signedOff ? (
          <>
            Signed off by {operation.signedOff.username} at{' '}
            <PlantTime at={operation.signedOff.plantAt} clock={at} />
          </>
        ) : operation.complete ? (
          'Complete: ready to sign off'
        ) : (
          'Not complete yet'
        )}
        {mine ? (
          <span className="font-semibold">
            {` · You: ${mine.kind === 'work' ? 'working' : `paused (${PAUSE_REASON_LABELS[mine.reason ?? 'other']})`}`}
          </span>
        ) : null}
        {others.length > 0
          ? ` · ${others.map((a) => `${a.username} ${a.kind === 'work' ? 'working' : 'paused'}`).join(', ')}`
          : ''}
      </p>
      {actions.start || (actions.pause && !pausing) || actions.resume || actions.signOff ? (
        <div className="mt-3 flex flex-wrap gap-3 *:max-sm:flex-1">
          {actions.start ? (
            <Button
              variant="primary"
              size="touch"
              icon="play"
              data-testid={`terminal-start-${id}`}
              {...busy('start')}
              onClick={() => {
                write.mutate('start');
              }}
            >
              Start
            </Button>
          ) : null}
          {actions.pause && !pausing ? (
            <Button
              variant="secondary"
              size="touch"
              icon="pause"
              data-testid={`terminal-pause-${id}`}
              disabled={write.isPending}
              onClick={() => {
                setPausing(true);
              }}
            >
              Pause
            </Button>
          ) : null}
          {actions.resume ? (
            <Button
              variant="primary"
              size="touch"
              icon="play"
              data-testid={`terminal-resume-${id}`}
              {...busy('resume')}
              onClick={() => {
                write.mutate('resume');
              }}
            >
              Resume
            </Button>
          ) : null}
          {actions.signOff ? (
            <Button
              variant="secondary"
              size="touch"
              icon="check"
              data-testid={`terminal-sign-off-${id}`}
              {...busy('sign-off')}
              onClick={() => {
                setConfirming(true);
              }}
            >
              Sign off operation
            </Button>
          ) : null}
        </div>
      ) : null}
      {pausing && actions.pause ? (
        <fieldset
          className="mt-4 rounded-lg border border-line-strong bg-surface p-4"
          data-testid={`terminal-pause-reasons-${id}`}
        >
          <legend className="px-1 text-lg font-semibold">Why do you pause?</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {PAUSE_REASONS.map((r) => (
              <Button
                key={r}
                variant={reason === r ? 'primary' : 'secondary'}
                size="touch"
                fullWidth
                {...(reason === r ? { icon: 'check' as const } : {})}
                aria-pressed={reason === r}
                data-testid={`terminal-reason-${id}-${r}`}
                onClick={() => {
                  setReason(r);
                }}
              >
                {PAUSE_REASON_LABELS[r]}
              </Button>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap justify-end gap-3 *:max-sm:flex-1">
            <Button
              variant="secondary"
              size="touch"
              onClick={() => {
                setPausing(false);
                setReason(undefined);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="touch"
              icon="pause"
              data-testid={`terminal-pause-confirm-${id}`}
              disabled={reason === undefined}
              loading={write.isPending}
              onClick={() => {
                write.mutate('pause');
              }}
            >
              Pause now
            </Button>
          </div>
        </fieldset>
      ) : null}
      {message ? (
        <Callout
          tone="alarm"
          size="touch"
          role="alert"
          className="mt-3"
          data-testid={`terminal-op-message-${id}`}
        >
          {message}
        </Callout>
      ) : null}
      <ConfirmDialog
        open={confirming}
        size="touch"
        title={`Sign off ${operation.operation} of order ${operation.orderId}?`}
        body={`You confirm that ${operation.operation} is complete for this order. A signed-off operation cannot be reopened at the terminal.`}
        confirmLabel="Sign off operation"
        pending={write.isPending}
        testId={`terminal-confirm-sign-off-${id}`}
        onCancel={() => {
          setConfirming(false);
        }}
        onConfirm={() =>
          // The promise: the dialog stays busy until the answer, so a second tap sends nothing.
          // Refused: the row says why and the focus goes back to the button that opened it.
          write
            .mutateAsync('sign-off')
            .then(
              () => {
                // Signed off: that button is gone, so the operation's state takes the focus once
                // the dialog has closed (an effect, after the dialog's own).
                focusState.current = true;
              },
              () => undefined,
            )
            .finally(() => {
              setConfirming(false);
            })
        }
      />
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
    <TerminalSection id="terminal-queue" title="Coming up">
      {view.queue.length === 0 ? (
        <Card padding="compact">
          <EmptyState
            size="inline"
            icon="info"
            title={<span className="text-lg">No released or dispatched order waits.</span>}
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="terminal-queue">
          {view.queue.map((q) => (
            <li key={q.order.id}>
              <Card padding="compact">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Code className="text-lg font-semibold">{q.order.id}</Code>
                  <Badge tone={ORDER_STATUS_TONE[q.order.status]}>
                    {ORDER_STATUS_TEXT[q.order.status]}
                  </Badge>
                </p>
                <p className="mt-1 text-base">
                  {q.order.product} · {q.order.quantity} pcs
                  {q.equipment ? ` on ${q.equipment}` : ''}
                </p>
                <p className="text-sm text-ink-secondary">
                  Planned <PlantTime at={q.order.plannedStart} seconds={false} />
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </TerminalSection>
  );
}

function ScrapRecords({
  view,
  username,
  canCode,
  codeHint,
  at,
  onCoded,
}: {
  readonly view: TerminalViewDto;
  readonly username: string;
  readonly canCode: boolean;
  readonly codeHint: string | undefined;
  readonly at: string | undefined;
  readonly onCoded: (id: number) => void;
}) {
  const reasons = useQuery({
    queryKey: terminalKeys.scrapReasons(username),
    queryFn: ({ signal }) => getScrapReasons(signal),
    staleTime: 60_000,
    enabled: canCode && view.scrapRecords.length > 0,
  });
  return (
    <TerminalSection id="terminal-scrap" title="Scrap to code">
      {view.scrapRecords.length === 0 ? (
        <Card padding="compact">
          <EmptyState
            size="inline"
            icon="check"
            title={<span className="text-lg">No scrap waits for a reason.</span>}
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-4">
          {view.scrapRecords.map((record) => (
            <ScrapCoding
              key={record.id}
              record={record}
              reasons={reasons.data?.reasons ?? []}
              canCode={canCode}
              codeHint={codeHint}
              at={at}
              onCoded={onCoded}
            />
          ))}
        </ul>
      )}
    </TerminalSection>
  );
}

function ScrapCoding({
  record,
  reasons,
  canCode,
  codeHint,
  at,
  onCoded,
}: {
  readonly record: ScrapRecordDto;
  readonly reasons: readonly { id: string; name: string; active: boolean; parent: string | null }[];
  readonly canCode: boolean;
  readonly codeHint: string | undefined;
  readonly at: string | undefined;
  readonly onCoded: (id: number) => void;
}) {
  const [reason, setReason] = useState<string | undefined>(undefined);
  const [comment, setComment] = useState('');
  const [message, setMessage] = useState<string | undefined>(undefined);
  const legendId = useId();
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
    <li data-testid={`terminal-scrap-${String(record.id)}`}>
      <Card>
        <h3 className="text-xl font-semibold">
          {record.operation} · <Code>{record.machineReason}</Code>
        </h3>
        <p className="mt-1 text-base text-ink-secondary">
          {record.serial ?? `part ${String(record.partId)}`} · order {record.orderId ?? '—'} ·{' '}
          {record.equipment} · <PlantTime at={record.scrappedAt} clock={at} />
        </p>
        {canCode ? (
          <div className="mt-4 flex flex-col gap-4">
            <div role="group" aria-labelledby={legendId}>
              <p id={legendId} className="mb-2 text-lg font-medium">
                Reason
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {choices.map((r) => (
                  <Button
                    key={r.id}
                    variant={reason === r.id ? 'primary' : 'secondary'}
                    size="touch"
                    fullWidth
                    {...(reason === r.id ? { icon: 'check' as const } : {})}
                    aria-pressed={reason === r.id}
                    data-testid={`terminal-scrap-reason-${String(record.id)}-${r.id}`}
                    onClick={() => {
                      setReason(r.id);
                    }}
                  >
                    {r.name}
                  </Button>
                ))}
              </div>
            </div>
            <TextInput
              label={<span className="text-lg">Comment</span>}
              name="comment"
              size="touch"
              data-testid={`terminal-scrap-comment-${String(record.id)}`}
              value={comment}
              maxLength={500}
              onChange={(event) => {
                setComment(event.target.value);
              }}
            />
            <div className="flex justify-end">
              <Button
                variant="primary"
                size="touch"
                icon="check"
                className="max-sm:w-full"
                data-testid={`terminal-scrap-code-${String(record.id)}`}
                disabled={reason === undefined}
                loading={code.isPending}
                onClick={() => {
                  code.mutate();
                }}
              >
                Code scrap
              </Button>
            </div>
          </div>
        ) : codeHint ? (
          <p className="mt-2 text-base text-ink-secondary">{codeHint}</p>
        ) : null}
        {message ? (
          <Callout tone="alarm" size="touch" role="alert" className="mt-3">
            {message}
          </Callout>
        ) : null}
      </Card>
    </li>
  );
}
