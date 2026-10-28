import type { EquipmentDto } from '@shopfloor/contracts/mes-api';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type SyntheticEvent, type ReactNode } from 'react';
import { listEquipment, getReasonCodes } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import {
  SIM_EVENTS_PATH,
  SPEED_RANGE,
  SimError,
  breakTool,
  getActions,
  getDrifts,
  getInjections,
  getLots,
  getOperators,
  getScenario,
  getScenarios,
  getStatus,
  injectDrift,
  injectFailure,
  loadScenario,
  markAbsent,
  pause,
  resume,
  setLotBlocked,
  setModbusSilent,
  setOpcuaOffline,
  setSpeed,
  step,
  type SimAction,
  type SimLot,
  type SimOperator,
  type SimStatus,
} from '../api/sim.ts';
import { useCan } from '../auth/auth.tsx';
import {
  ScreenError,
  SectionError,
  queryRead,
  screenErrors,
  type ScreenErrors,
} from '../components/screen-error.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Card } from '../components/ui/card.tsx';
import { Code } from '../components/ui/code.tsx';
import { NumberInput, Select, TextInput } from '../components/ui/controls.tsx';
import { DataTable, type Column } from '../components/ui/data-table.tsx';
import { ConfirmDialog } from '../components/ui/dialog.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Missing, PlantTime } from '../components/ui/format.tsx';
import type { IconName } from '../components/ui/icons.tsx';
import { Forbidden } from '../components/ui/not-found.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { PlantTimeInput } from '../components/ui/plant-time-input.tsx';
import { Section } from '../components/ui/section.tsx';
import { SectionNav, type SectionNavItem } from '../components/ui/section-nav.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { parsePlantDate, plantTimeText } from '../domain/time.ts';

// The simulation console (#237, Phase 9 plan "Simulation console", ADR-0037): the physical world
// under test, for `admin` only (`sim:control`). Everything goes to the simulator's control API
// through nginx's `/sim/` allowlist; the MES only answers the permission check and never calls
// the control API. Live through a 1 s status poll and the plant event stream; the console holds
// no MES push topic (the push budget stays the screens', #233). Only an action (a POST or PUT)
// counts as use of the session: an open console nobody touches times out like any other page.
//
// On the design system (UX-10, #334): a `PageHeader`, a `SectionNav` over six sections (Run,
// Scenario, Faults, Materials, Operators, Log), every time on `PlantTimeInput` in simulation time,
// the lists on `DataTable`. A lever that harms the plant is `danger`; one that also cannot be
// taken back (a failure, a drift, a tool breakage, an absence) asks first in a `ConfirmDialog`
// (design system 4.9). Blocking a lot, taking a server offline and silencing Modbus have their
// undo beside them, so they do not ask.

/** Every console read starts with this key: an action reads them all again. */
const simKeys = {
  all: ['sim'] as const,
  status: ['sim', 'status'] as const,
  injections: ['sim', 'injections'] as const,
  drifts: ['sim', 'drifts'] as const,
  lots: ['sim', 'lots'] as const,
  operators: ['sim', 'operators'] as const,
  actions: ['sim', 'actions'] as const,
  scenarios: ['sim', 'scenarios'] as const,
  scenario: ['sim', 'scenario'] as const,
};

/** The status poll (plan: "a 1 s status poll"); the lists every 5 s and after each action. */
export const STATUS_POLL_MS = 1_000;
export const LIST_POLL_MS = 5_000;
/** The plant events kept on screen, and how often the list is redrawn. */
export const EVENT_TAIL = 30;
export const EVENT_FLUSH_MS = 1_000;
/** The simulator's close code at the end of a stream's lifetime (control API 1.11). */
export const EVENTS_LIFETIME_CLOSE = 4100;

/** The page's sections in reading order (design system 3.4): the `SectionNav` points at them. */
export const CONSOLE_SECTIONS: readonly SectionNavItem[] = [
  { id: 'console-run-title', label: 'Run' },
  { id: 'console-scenario-title', label: 'Scenario' },
  { id: 'console-faults-title', label: 'Faults' },
  { id: 'console-materials-title', label: 'Materials' },
  { id: 'console-operators-title', label: 'Operators' },
  { id: 'console-log-title', label: 'Log' },
];

interface Outcome {
  readonly kind: 'done' | 'failed';
  readonly text: string;
}

/**
 * What an action did: an `ok` callout (polite) when the simulator took it, an `alarm` one
 * (announced) with the simulator's own words when it refused. `data-kind` is read by the specs.
 */
function OutcomeLine({
  outcome,
  testId,
  quiet = false,
}: {
  readonly outcome: Outcome;
  readonly testId: string;
  /** Not announced: a confirmation dialog in front of it says the same (its own alert). */
  readonly quiet?: boolean;
}) {
  return (
    <Callout
      tone={outcome.kind === 'done' ? 'ok' : 'alarm'}
      {...(quiet ? {} : { role: outcome.kind === 'done' ? 'status' : 'alert' })}
      data-testid={testId}
      data-kind={outcome.kind}
      className="mt-3"
    >
      {outcome.text}
    </Callout>
  );
}

/**
 * A console action: runs it, reads every console list again and says what happened. Actions that
 * share one outcome line pass that line's setter (`shared`), so the line shows the latest one.
 */
function useAction<A extends unknown[], R>(
  run: (...args: A) => Promise<R>,
  done: (result: R, ...args: A) => string,
  shared?: (outcome: Outcome | undefined) => void,
) {
  const queryClient = useQueryClient();
  const [own, setOwn] = useState<Outcome | undefined>(undefined);
  const setOutcome = shared ?? setOwn;
  const outcome = shared ? undefined : own;
  const failed = (error: unknown): Outcome => ({
    kind: 'failed',
    text: error instanceof SimError ? error.message : 'The action failed',
  });
  const mutation = useMutation({
    mutationFn: (args: A) => run(...args),
    onSuccess: (result, args) => {
      setOutcome({ kind: 'done', text: done(result, ...args) });
    },
    onError: (error) => {
      setOutcome(failed(error));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: simKeys.all });
    },
  });
  return {
    act: (...args: A) => {
      setOutcome(undefined);
      mutation.mutate(args);
    },
    /** As `act`, settled: what happened, for a confirmation that waits for the write. */
    settle: async (...args: A): Promise<Outcome> => {
      setOutcome(undefined);
      try {
        return { kind: 'done', text: done(await mutation.mutateAsync(args), ...args) };
      } catch (error) {
        return failed(error);
      }
    },
    pending: mutation.isPending,
    outcome,
  };
}

/** Simulation times in plant time, as the header shows the plant clock (#295). */
const timeText = plantTimeText;

/** A simulation time on the page, dated (a run moves across days); `—` with why when none. */
function SimTime({ at, none }: { readonly at: string | undefined; readonly none: string }) {
  if (at === undefined || !Number.isFinite(Date.parse(at))) return <Missing reason={none} />;
  return <PlantTime at={at} />;
}

/** "Horizontal machining centre 1 (cnc-01)": names before codes (design system 6.4). */
function MachineName({ machine }: { readonly machine: EquipmentDto }) {
  return (
    <>
      {machine.name} <Code className="whitespace-nowrap text-ink-secondary">({machine.id})</Code>
    </>
  );
}

const machineText = (machines: readonly EquipmentDto[], id: string): string => {
  const machine = machines.find((m) => m.id === id);
  return machine ? `${machine.name} (${id})` : id;
};

const STATE_TEXT: Readonly<Record<SimStatus['state'], string>> = {
  idle: 'Idle (not started)',
  running: 'Running',
  paused: 'Paused',
  finished: 'Finished',
};
const STATE_ICON: Readonly<Record<SimStatus['state'], IconName>> = {
  idle: 'circle',
  running: 'play',
  paused: 'pause',
  finished: 'check',
};

/** A decimal typed in a box, or undefined when it is not one. */
const decimal = (text: string): number | undefined => {
  const value = Number(text.trim().replace(',', '.'));
  return text.trim() === '' || !Number.isFinite(value) ? undefined : value;
};

function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-ink-secondary">{term}</dt>
      {children}
    </div>
  );
}

function RunSection({
  status,
  error,
}: {
  readonly status: SimStatus | undefined;
  readonly error: ReactNode;
}) {
  const [speed, setSpeedDraft] = useState<string | undefined>(undefined);
  const [speedError, setSpeedError] = useState<string | undefined>(undefined);
  const shown = speed ?? String(status?.speed ?? 60);
  const sliderId = useId();
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined);
  const doPause = useAction(pause, (s) => `Paused at ${timeText(s.simTime)}.`, setOutcome);
  const doResume = useAction(resume, (s) => `Running at ${String(s.speed)}×.`, setOutcome);
  const doStep = useAction(
    step,
    (r) => (r.stepped ? `Stepped to ${timeText(r.status.simTime)}.` : 'No event left to process.'),
    setOutcome,
  );
  const doSpeed = useAction(setSpeed, (s) => `Speed ${String(s.speed)}×.`, setOutcome);
  const state = status?.state;
  const canResume = state === 'paused' || state === 'idle';
  return (
    <Section
      id="console-run-title"
      title="Run"
      testId="console-run"
      description="Start, pause or step the simulated plant, and set how fast its clock runs."
    >
      {error}
      <Card padding="compact">
        {status ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
            <Fact term="State">
              <dd data-testid="sim-state" data-state={status.state} className="mt-0.5">
                <Badge tone="neutral" icon={STATE_ICON[status.state]}>
                  {STATE_TEXT[status.state]}
                </Badge>
              </dd>
            </Fact>
            <Fact term="Simulation time">
              <dd data-testid="sim-time" className="mt-0.5 font-semibold tabular-nums">
                <time dateTime={status.simTime}>{timeText(status.simTime)}</time>
              </dd>
            </Fact>
            <Fact term="Speed">
              <dd data-testid="sim-speed" className="mt-0.5 font-semibold tabular-nums">
                {status.speed}×
              </dd>
            </Fact>
            <Fact term="Events processed">
              <dd data-testid="sim-events" className="mt-0.5 tabular-nums">
                {status.events}
              </dd>
            </Fact>
            <Fact term="Lag">
              <dd className="mt-0.5 tabular-nums">{Math.round(status.lagMs)} ms</dd>
            </Fact>
          </dl>
        ) : (
          <Skeleton shape="text" rows={2} label="Reading the run…" />
        )}
        <div className="mt-4 flex flex-col gap-4 border-t border-line-subtle pt-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button
              variant={canResume ? 'primary' : 'secondary'}
              icon="play"
              data-testid="sim-resume"
              disabled={doResume.pending || !canResume}
              onClick={() => {
                doResume.act();
              }}
            >
              {state === 'idle' ? 'Start' : 'Resume'}
            </Button>
            <Button
              icon="pause"
              data-testid="sim-pause"
              disabled={doPause.pending || state !== 'running'}
              onClick={() => {
                doPause.act();
              }}
            >
              Pause
            </Button>
            <Button
              data-testid="sim-step"
              disabled={doStep.pending || !canResume}
              onClick={() => {
                doStep.act();
              }}
            >
              Step one event
            </Button>
          </div>
          <form
            noValidate
            aria-label="Speed"
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const value = decimal(shown);
              if (value === undefined || value < SPEED_RANGE.min || value > SPEED_RANGE.max) {
                setSpeedError(
                  `Enter a speed from ${String(SPEED_RANGE.min)} to ${String(SPEED_RANGE.max)}.`,
                );
                return;
              }
              setSpeedError(undefined);
              doSpeed.act(value);
              setSpeedDraft(undefined);
            }}
          >
            <div className="flex min-h-9 items-center">
              <label htmlFor={sliderId} className="sr-only">
                Speed slider
              </label>
              <input
                id={sliderId}
                name="speed-slider"
                type="range"
                data-testid="sim-speed-range"
                min={SPEED_RANGE.min}
                max={SPEED_RANGE.max}
                step={0.5}
                value={decimal(shown) ?? SPEED_RANGE.min}
                onChange={(event) => {
                  setSpeedDraft(event.target.value);
                  setSpeedError(undefined);
                }}
                className="w-40 accent-accent"
              />
            </div>
            <NumberInput
              label="Speed"
              name="speed"
              unit="×"
              inputMode="decimal"
              data-testid="sim-speed-input"
              value={shown}
              error={speedError}
              onChange={(event) => {
                setSpeedDraft(event.target.value);
                setSpeedError(undefined);
              }}
              className="w-20"
            />
            <Button type="submit" data-testid="sim-speed-apply" disabled={doSpeed.pending}>
              Set speed
            </Button>
          </form>
        </div>
        {outcome ? <OutcomeLine outcome={outcome} testId="run-outcome" /> : null}
      </Card>
    </Section>
  );
}

/** A confirmation waiting to be given: what it asks and what it runs. */
interface Pending {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  /** The write; the dialog stays busy until it settles. */
  readonly run: () => Promise<Outcome>;
}

/** One `ConfirmDialog` for a lever that cannot be taken back (design system 4.9). */
function useConfirm(testId: string) {
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  // The simulator's refusal, shown in the dialog: it stays open, so the person reads why and
  // cancels (or tries again) where they confirmed.
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const dialog = (
    <ConfirmDialog
      open={pending !== undefined}
      title={pending?.title ?? 'Inject'}
      body={
        <>
          {pending?.body ?? ''}
          {refusal === undefined ? null : (
            <Callout tone="alarm" role="alert" className="mt-3" data-testid={`${testId}-refusal`}>
              {refusal}
            </Callout>
          )}
        </>
      }
      confirmLabel={pending?.confirmLabel ?? 'Inject'}
      tone="danger"
      testId={testId}
      onCancel={() => {
        setPending(undefined);
        setRefusal(undefined);
      }}
      onConfirm={async () => {
        if (pending === undefined) return;
        setRefusal(undefined);
        // Busy (and not to be closed) until the write settles (design system 4.9).
        const outcome = await pending.run();
        if (outcome.kind === 'done') setPending(undefined);
        else setRefusal(outcome.text);
      }}
    />
  );
  return {
    ask: (next: Pending) => {
      setRefusal(undefined);
      setPending(next);
    },
    dialog,
    /** The dialog shows a refusal: the outcome line behind it stays quiet (one announcement). */
    refusing: refusal !== undefined,
  };
}

const boxText = (form: HTMLFormElement, name: string): string => {
  const box = form.elements.namedItem(name);
  return box instanceof HTMLInputElement ? box.value.trim() : '';
};

/**
 * What is wrong with an optional time field that names no time although something was typed: a
 * time box that cannot be read, or a date with an empty time box (the input reads an empty time
 * as no value, so the write would silently go "now"). Undefined when it is fine.
 */
function timeProblem(
  form: HTMLFormElement,
  name: string,
  value: string | null,
): string | undefined {
  if (value !== null) return undefined;
  if (boxText(form, `${name}-time`) !== '') return TIME_UNREAD;
  if (boxText(form, `${name}-date`) !== '') return TIME_MISSING;
  return undefined;
}

/** A form's field errors by field; a field without one is `undefined` or absent. */
type FieldErrors<K extends string> = Partial<Record<K, string | undefined>>;

const TIME_UNREAD = 'Enter a time this box can read, or leave it empty.';
const TIME_MISSING = 'Enter a time for this date, or clear the date.';

function FailureCard({
  machines,
  codes,
}: {
  readonly machines: readonly EquipmentDto[];
  readonly codes: readonly string[];
}) {
  const [machine, setMachine] = useState('');
  const [code, setCode] = useState('');
  const [at, setAt] = useState<string | null>(null);
  const [repair, setRepair] = useState('');
  const [errors, setErrors] = useState<FieldErrors<'code' | 'at' | 'repair'>>({});
  const listId = useId();
  const confirm = useConfirm('confirm-failure');
  const inject = useAction(
    (target: string, body: Parameters<typeof injectFailure>[1]) => injectFailure(target, body),
    (r) => `Failure ${r.injection.code} on ${r.injection.machine}: ${r.injection.status}.`,
  );
  const chosen = machine === '' ? (machines[0]?.id ?? '') : machine;
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = code.trim();
    const minutes = decimal(repair);
    const found = {
      ...(name === '' ? { code: 'Enter a failure code.' } : {}),
      ...(timeProblem(event.currentTarget, 'failure-at', at) === undefined
        ? {}
        : { at: timeProblem(event.currentTarget, 'failure-at', at) }),
      ...(repair.trim() !== '' && (minutes === undefined || minutes <= 0)
        ? { repair: 'Enter the repair time in minutes, for example 12.' }
        : {}),
    };
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = {
      code: name,
      ...(at === null ? {} : { at }),
      ...(minutes === undefined ? {} : { repairMs: Math.round(minutes * 60_000) }),
    };
    confirm.ask({
      title: `Inject ${name} on ${machineText(machines, chosen)}?`,
      body: `The machine breaks down ${at === null ? 'at the current simulation time' : `at ${timeText(at)}`}${minutes === undefined ? '' : ` and is repaired after ${String(minutes)} min`}. An injected failure cannot be withdrawn.`,
      confirmLabel: 'Inject failure',
      run: () => inject.settle(chosen, body),
    });
  };
  return (
    <Card as="section" title="Failure injection" headingLevel={3} testId="console-failure">
      <form noValidate className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="flex flex-col gap-4">
          <Select
            label="Machine"
            name="failure-machine"
            data-testid="failure-machine"
            value={chosen}
            onChange={(event) => {
              setMachine(event.target.value);
            }}
            className="w-full max-w-sm"
          >
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.id})
              </option>
            ))}
          </Select>
          <TextInput
            label="Failure code"
            name="failure-code"
            required
            data-testid="failure-code"
            list={listId}
            autoComplete="off"
            spellCheck={false}
            value={code}
            error={errors.code}
            hint="A breakdown reason the machine has."
            onChange={(event) => {
              setCode(event.target.value);
              setErrors((current) => ({ ...current, code: undefined }));
            }}
            className="w-full max-w-xs"
          />
          <datalist id={listId}>
            {codes.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <PlantTimeInput
          label="At"
          name="failure-at"
          variant="console"
          testId="failure-at"
          value={at}
          error={errors.at}
          hint="Empty: at the current simulation time."
          onChange={(value) => {
            setAt(value);
            setErrors((current) => ({ ...current, at: undefined }));
          }}
        />
        <NumberInput
          label="Repair time"
          name="failure-repair"
          unit="min"
          inputMode="decimal"
          data-testid="failure-repair"
          value={repair}
          error={errors.repair}
          hint="Empty: the failure mode's own repair time."
          onChange={(event) => {
            setRepair(event.target.value);
            setErrors((current) => ({ ...current, repair: undefined }));
          }}
          className="w-24"
        />
        <div>
          <Button
            type="submit"
            variant="danger"
            data-testid="failure-inject"
            disabled={inject.pending}
          >
            Inject failure
          </Button>
        </div>
      </form>
      {inject.outcome ? (
        <OutcomeLine outcome={inject.outcome} testId="failure-outcome" quiet={confirm.refusing} />
      ) : null}
      {confirm.dialog}
    </Card>
  );
}

function DriftCard({ testers }: { readonly testers: readonly EquipmentDto[] }) {
  const [shift, setShift] = useState('0.6');
  const [until, setUntil] = useState<string | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors<'shift' | 'at' | 'until'>>({});
  const confirm = useConfirm('confirm-drift');
  const tester = testers[0];
  const machine = tester?.id ?? 'lkt-01';
  const drift = useAction(
    (body: Parameters<typeof injectDrift>[1]) => injectDrift(machine, body),
    (r) =>
      `Leak-test drift of ${String(r.drift.shift)} until ${timeText(r.drift.until)}: ${r.drift.status}.`,
  );
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const by = decimal(shift);
    const form = event.currentTarget;
    const found = {
      ...(by === undefined ? { shift: 'Enter the shift in Pa/min, for example 0.6.' } : {}),
      ...(timeProblem(form, 'drift-at', at) === undefined
        ? {}
        : { at: timeProblem(form, 'drift-at', at) }),
      ...(until === null
        ? {
            until:
              boxText(form, 'drift-until-time') === '' ? 'Enter when the drift ends.' : TIME_UNREAD,
          }
        : {}),
    };
    setErrors(found);
    if (by === undefined || until === null || Object.keys(found).length > 0) return;
    confirm.ask({
      title: `Inject a drift of ${String(by)} Pa/min on ${machineText(testers, machine)}?`,
      body: `The leak tester reads ${String(by)} Pa/min high from ${at === null ? 'the current simulation time' : timeText(at)} until ${timeText(until)}, so good parts can fail the test. An injected drift cannot be withdrawn.`,
      confirmLabel: 'Inject drift',
      run: () => drift.settle({ shift: by, until, ...(at === null ? {} : { at }) }),
    });
  };
  return (
    <Card
      as="section"
      title="Leak-test sensor drift"
      headingLevel={3}
      testId="console-drift"
      description={
        <>
          On {tester ? <MachineName machine={tester} /> : <Code>{machine}</Code>}: its readings
          shift up for a while.
        </>
      }
    >
      <form noValidate className="flex flex-col gap-4" onSubmit={onSubmit}>
        <NumberInput
          label="Shift"
          name="drift-shift"
          unit="Pa/min"
          required
          inputMode="decimal"
          data-testid="drift-shift"
          value={shift}
          error={errors.shift}
          onChange={(event) => {
            setShift(event.target.value);
            setErrors((current) => ({ ...current, shift: undefined }));
          }}
          className="w-24"
        />
        <PlantTimeInput
          label="From"
          name="drift-at"
          variant="console"
          testId="drift-at"
          value={at}
          error={errors.at}
          hint="Empty: from the current simulation time."
          onChange={(value) => {
            setAt(value);
            setErrors((current) => ({ ...current, at: undefined }));
          }}
        />
        <PlantTimeInput
          label="Until"
          name="drift-until"
          variant="console"
          required
          testId="drift-until"
          value={until}
          error={errors.until}
          onChange={(value) => {
            setUntil(value);
            setErrors((current) => ({ ...current, until: undefined }));
          }}
        />
        <div>
          <Button
            type="submit"
            variant="danger"
            data-testid="drift-inject"
            disabled={drift.pending}
          >
            Inject drift
          </Button>
        </div>
      </form>
      {drift.outcome ? (
        <OutcomeLine outcome={drift.outcome} testId="drift-outcome" quiet={confirm.refusing} />
      ) : null}
      {confirm.dialog}
    </Card>
  );
}

/** A connection's state: the protocol and the word, abnormal in `alarm` with its glyph. */
function ConnectionState({
  testId,
  protocol,
  down,
  word,
}: {
  readonly testId: string;
  readonly protocol: string;
  readonly down: boolean;
  readonly word: string;
}) {
  return (
    <Badge tone={down ? 'alarm' : 'neutral'} icon={down ? 'ban' : undefined} data-testid={testId}>
      {protocol} {word}
    </Badge>
  );
}

function ConnectionsCard({
  opcua,
  modbus,
}: {
  readonly opcua: readonly EquipmentDto[];
  readonly modbus: readonly EquipmentDto[];
}) {
  // The control API has no read of these switches: the console shows what it last set.
  const [offline, setOffline] = useState<Readonly<Record<string, boolean>>>({});
  const [silent, setSilent] = useState<boolean | undefined>(undefined);
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined);
  const opcuaAction = useAction(
    (machine: string, next: boolean) => setOpcuaOffline(machine, next),
    (r, machine) => {
      setOffline((current) => ({ ...current, [machine]: r.offline }));
      return `${machine}'s OPC UA server is ${r.offline ? 'offline' : 'online'}.`;
    },
    setOutcome,
  );
  const modbusAction = useAction(
    setModbusSilent,
    (r) => {
      setSilent(r.silent);
      return `The Modbus device is ${r.silent ? 'silent' : 'answering'}.`;
    },
    setOutcome,
  );
  const row = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2';
  return (
    <Card
      as="section"
      title="Device connections"
      headingLevel={3}
      testId="console-infrastructure"
      description="The console shows what it last set; “as started” until then."
    >
      <ul className="divide-y divide-line-subtle text-sm">
        {opcua.map((m) => {
          const isOffline = offline[m.id] === true;
          return (
            <li key={m.id} className={row}>
              <span className="min-w-0">
                <MachineName machine={m} />
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <ConnectionState
                  testId={`opcua-state-${m.id}`}
                  protocol="OPC UA"
                  down={isOffline}
                  word={
                    offline[m.id] === undefined ? 'as started' : isOffline ? 'offline' : 'online'
                  }
                />
                <Button
                  size="sm"
                  variant={isOffline ? 'secondary' : 'danger'}
                  data-testid={`opcua-toggle-${m.id}`}
                  aria-label={`${isOffline ? 'Bring online' : 'Take offline'}: the OPC UA server of ${m.name}`}
                  disabled={opcuaAction.pending}
                  onClick={() => {
                    opcuaAction.act(m.id, !isOffline);
                  }}
                >
                  {isOffline ? 'Bring online' : 'Take offline'}
                </Button>
              </span>
            </li>
          );
        })}
        {modbus.map((m) => (
          <li key={m.id} className={row}>
            <span className="min-w-0">
              <MachineName machine={m} />
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <ConnectionState
                testId="modbus-state"
                protocol="Modbus"
                down={silent === true}
                word={silent === undefined ? 'as started' : silent ? 'silent' : 'answering'}
              />
              <Button
                size="sm"
                variant={silent === true ? 'secondary' : 'danger'}
                data-testid="modbus-toggle"
                aria-label={`${silent === true ? 'Answer again' : 'Go silent'}: the Modbus device of ${m.name}`}
                disabled={modbusAction.pending}
                onClick={() => {
                  modbusAction.act(silent !== true);
                }}
              >
                {silent === true ? 'Answer again' : 'Go silent'}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {outcome ? <OutcomeLine outcome={outcome} testId="infrastructure-outcome" /> : null}
    </Card>
  );
}

function ToolCard({ cncs }: { readonly cncs: readonly EquipmentDto[] }) {
  const confirm = useConfirm('confirm-tool');
  const tool = useAction(breakTool, (r, machine) =>
    r.action.kind === 'tool-breakage'
      ? `${machine}'s tool breaks at ${timeText(r.action.at)} (${r.action.status}).`
      : 'Done.',
  );
  return (
    <Card
      as="section"
      title="Tool breakage"
      headingLevel={3}
      testId="console-tool"
      description="The machine stops at its next cycle and needs a tool change."
    >
      <ul className="divide-y divide-line-subtle text-sm">
        {cncs.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="min-w-0">
              <MachineName machine={m} />
            </span>
            <Button
              size="sm"
              variant="danger"
              data-testid={`tool-break-${m.id}`}
              aria-label={`Break tool on ${m.name}`}
              disabled={tool.pending}
              onClick={() => {
                confirm.ask({
                  title: `Break the tool on ${m.name} (${m.id})?`,
                  body: 'The machine stops with a broken tool at its next cycle and stays down until the tool is changed. A tool breakage cannot be withdrawn.',
                  confirmLabel: 'Break tool',
                  run: () => tool.settle(m.id),
                });
              }}
            >
              Break tool
            </Button>
          </li>
        ))}
      </ul>
      {tool.outcome ? (
        <OutcomeLine outcome={tool.outcome} testId="tool-outcome" quiet={confirm.refusing} />
      ) : null}
      {confirm.dialog}
    </Card>
  );
}

function FaultsSection({
  equipment,
  codes,
  errors,
}: {
  readonly equipment: { readonly data: readonly EquipmentDto[] | undefined };
  readonly codes: readonly string[];
  readonly errors: ScreenErrors;
}) {
  const machines = [...(equipment.data ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  return (
    <Section
      id="console-faults-title"
      title="Faults"
      testId="console-faults"
      description="Break machines, sensors and connections; the MES sees only what the machines report."
    >
      {errors.inSection('the machines') ? (
        <SectionError errors={errors} readKey="the machines" />
      ) : equipment.data === undefined ? (
        <Skeleton shape="card" label="Loading the machines…" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <FailureCard machines={machines} codes={codes} />
          <DriftCard testers={machines.filter((m) => m.id.startsWith('lkt-'))} />
          <ConnectionsCard
            opcua={machines.filter((m) => m.interface === 'opcua')}
            modbus={machines.filter((m) => m.interface === 'modbus')}
          />
          <ToolCard cncs={machines.filter((m) => m.operation === 'OP10')} />
        </div>
      )}
    </Section>
  );
}

function MaterialsSection({
  lots,
  errors,
}: {
  readonly lots: UseQueryResult<Awaited<ReturnType<typeof getLots>>>;
  readonly errors: ScreenErrors;
}) {
  const lotAction = useAction(
    (lot: string, blocked: boolean) => setLotBlocked(lot, blocked),
    (r, lot, blocked) =>
      `${lot} ${blocked ? 'block' : 'release'}: ${r.action.status}${'at' in r.action ? ` at ${timeText(r.action.at)}` : ''}.`,
  );
  const columns: Column<SimLot>[] = [
    { key: 'lot', header: 'Lot', rowHeader: true, nowrap: true, cell: (l) => <Code>{l.lot}</Code> },
    { key: 'material', header: 'Material', nowrap: true, cell: (l) => <Code>{l.material}</Code> },
    { key: 'remaining', header: 'Remaining', numeric: true, cell: (l) => l.remaining },
    {
      key: 'state',
      header: 'State',
      nowrap: true,
      cell: (l) =>
        l.blocked ? (
          <Badge tone="caution" icon="ban">
            Blocked
          </Badge>
        ) : (
          'Free'
        ),
    },
  ];
  return (
    <Section
      id="console-materials-title"
      title="Materials"
      testId="console-lots"
      description="Block a lot and the machines that draw from it starve. A change applies at the next step of the run."
    >
      {lotAction.outcome ? (
        <div className="mb-3">
          <OutcomeLine outcome={lotAction.outcome} testId="lot-outcome" />
        </div>
      ) : null}
      {errors.inSection('the lots') ? (
        <SectionError errors={errors} readKey="the lots" />
      ) : (
        <DataTable
          caption="Material lots"
          testId="lot-table"
          columns={columns}
          rows={lots.data?.lots ?? []}
          rowKey={(l) => l.lot}
          rowTestId={(l) => `lot-${l.lot}`}
          rowProps={(l) => ({ 'data-blocked': String(l.blocked) })}
          rowTone={(l) => (l.blocked ? 'caution' : undefined)}
          density="compact"
          loading={lots.data === undefined ? 'Loading the lots…' : undefined}
          empty={<EmptyState title="No material lots" body="The simulator holds no lot." />}
          actions={(l) => (
            // Both, always: an action applies at the next step, so a paused run still shows the
            // lot as it was. The one that matches the lot's state carries the weight (N-03).
            <>
              <Button
                size="sm"
                variant={l.blocked ? 'ghost' : 'danger'}
                data-testid={`lot-block-${l.lot}`}
                aria-label={`Block ${l.lot}`}
                disabled={lotAction.pending}
                onClick={() => {
                  lotAction.act(l.lot, true);
                }}
              >
                Block
              </Button>
              <Button
                size="sm"
                variant={l.blocked ? 'secondary' : 'ghost'}
                data-testid={`lot-release-${l.lot}`}
                aria-label={`Release ${l.lot}`}
                disabled={lotAction.pending}
                onClick={() => {
                  lotAction.act(l.lot, false);
                }}
              >
                Release
              </Button>
            </>
          )}
        />
      )}
    </Section>
  );
}

/** `2026-10-12/A` → its date and shift id. */
const splitShift = (key: string | null): { date: string; shift: string } => {
  const [date = '', shift = ''] = (key ?? '').split('/');
  return { date, shift };
};

/** `2026-10-12` → `12/10/2026`, the way the date boxes read. */
const dayText = (day: string): string => {
  const [year, month, date] = day.split('-');
  return year && month && date ? `${date}/${month}/${year}` : day;
};

const OPERATOR_STATUS: Readonly<Record<SimOperator['status'], string>> = {
  present: 'Present',
  absent: 'Absent',
  'off-shift': 'Off shift',
};

function OperatorsSection({
  operators,
  errors,
}: {
  readonly operators: UseQueryResult<Awaited<ReturnType<typeof getOperators>>>;
  readonly errors: ScreenErrors;
}) {
  const current = splitShift(operators.data?.currentShift ?? null);
  const shiftIds = [...new Set((operators.data?.operators ?? []).map((o) => o.shift))].sort();
  const [date, setDate] = useState<string | undefined>(undefined);
  const [dateError, setDateError] = useState<string | undefined>(undefined);
  const [shiftId, setShiftId] = useState<string | undefined>(undefined);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const confirm = useConfirm('confirm-absent');
  const dateBox = date ?? dayText(current.date);
  const id = shiftId ?? shiftIds.find((s) => s !== current.shift) ?? shiftIds[0] ?? '';
  const absent = useAction(
    (shift: string, ids: readonly string[]) => markAbsent(shift, ids),
    (r) =>
      r.action.kind === 'operators-absent'
        ? `${r.action.operators.join(', ')} absent in shift ${r.action.shift} (${r.action.status}).`
        : 'Done.',
  );
  const list = (operators.data?.operators ?? []).filter((o) => chosen.has(o.id)).map((o) => o.id);
  const columns: Column<SimOperator>[] = [
    {
      key: 'id',
      header: 'Operator',
      rowHeader: true,
      nowrap: true,
      cell: (o) => <Code>{o.id}</Code>,
    },
    { key: 'shift', header: 'Shift', nowrap: true, cell: (o) => o.shift },
    {
      key: 'skills',
      header: 'Skills',
      priority: 3,
      cell: (o) => <Code>{o.skills.join(', ')}</Code>,
    },
    {
      key: 'status',
      header: 'Now',
      nowrap: true,
      cell: (o) => (
        <span data-testid={`operator-status-${o.id}`}>
          {o.status === 'absent' ? (
            <Badge tone="warn">{OPERATOR_STATUS[o.status]}</Badge>
          ) : (
            OPERATOR_STATUS[o.status]
          )}
          {o.forced ? ' (forced)' : ''}
        </span>
      ),
    },
    {
      key: 'station',
      header: 'Station',
      priority: 2,
      nowrap: true,
      cell: (o) =>
        o.station === null ? <Missing reason="Not at a station" /> : <Code>{o.station}</Code>,
    },
  ];
  return (
    <Section
      id="console-operators-title"
      title="Operators"
      testId="console-operators"
      description="Mark operators absent for a whole shift: the stations they would staff stand idle."
    >
      {errors.inSection('the operators') ? (
        <SectionError errors={errors} readKey="the operators" />
      ) : operators.data === undefined ? (
        <Skeleton shape="table" label="Loading the operators…" />
      ) : (
        <>
          <p className="mb-3 text-sm" data-testid="current-shift">
            Current shift:{' '}
            {operators.data.currentShift === null ? (
              'between shifts'
            ) : (
              <Code>{operators.data.currentShift}</Code>
            )}
          </p>
          <form
            noValidate
            aria-label="Mark operators absent"
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const day = parsePlantDate(dateBox);
              if (day === undefined) {
                setDateError('Enter the date as dd/mm/yyyy, for example 12/10/2026.');
                return;
              }
              setDateError(undefined);
              const shift = `${day}/${id}`;
              const ids = list;
              confirm.ask({
                title: `Mark ${ids.join(', ')} absent in shift ${shift}?`,
                body: 'They do not come to work for that whole shift, and the stations they would staff stand idle. An absence cannot be withdrawn.',
                confirmLabel: 'Mark absent',
                run: async () => {
                  const outcome = await absent.settle(shift, ids);
                  if (outcome.kind === 'done') setChosen(new Set());
                  return outcome;
                },
              });
            }}
          >
            <div className="flex flex-wrap items-start gap-3">
              <TextInput
                label="Shift date"
                name="absent-date"
                required
                data-testid="absent-date"
                placeholder="dd/mm/yyyy"
                autoComplete="off"
                spellCheck={false}
                value={dateBox}
                error={dateError}
                hint="Simulation date, dd/mm/yyyy."
                onChange={(event) => {
                  setDate(event.target.value);
                  setDateError(undefined);
                }}
                className="w-32"
              />
              <Select
                label="Shift"
                name="absent-shift"
                data-testid="absent-shift"
                value={id}
                onChange={(event) => {
                  setShiftId(event.target.value);
                  setChosen(new Set());
                }}
              >
                {shiftIds.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </div>
            <DataTable
              caption="Operators"
              testId="operator-table"
              columns={columns}
              rows={operators.data.operators}
              rowKey={(o) => o.id}
              rowTestId={(o) => `operator-${o.id}`}
              density="compact"
              empty={<EmptyState title="No operators" body="The simulator has no operator." />}
              selection={{
                selected: chosen,
                onChange: setChosen,
                label: (o) => `${o.id} absent`,
                allLabel: `Every operator of shift ${id} absent`,
                selectable: (o) => o.shift === id,
                rowTestId: (o) => `absent-${o.id}`,
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                variant="danger"
                data-testid="absent-submit"
                disabled={absent.pending || list.length === 0}
              >
                Mark absent for that shift
              </Button>
              {list.length === 0 ? (
                <span className="text-sm text-ink-secondary">
                  Select operators of shift {id} to mark them absent.
                </span>
              ) : null}
            </div>
          </form>
          {absent.outcome ? (
            <OutcomeLine
              outcome={absent.outcome}
              testId="absent-outcome"
              quiet={confirm.refusing}
            />
          ) : null}
          {confirm.dialog}
          <div className="mt-6">
            <Section level={3} title="Planned absences">
              {operators.data.absences.length > 0 ? (
                <ul
                  className="divide-y divide-line-subtle rounded-lg border border-line bg-surface px-3 text-sm"
                  data-testid="absence-list"
                >
                  {operators.data.absences.map((a) => (
                    <li
                      key={a.id}
                      data-testid={`absence-${String(a.id)}`}
                      data-status={a.status}
                      className={ITEM}
                    >
                      <span className="text-ink-secondary tabular-nums">#{a.id}</span>
                      <span className="min-w-0">
                        <Code>{a.operators.join(', ')}</Code> in shift <Code>{a.shift}</Code>
                      </span>
                      <Badge tone="neutral" variant="outline">
                        {a.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <Card padding="compact">
                  <EmptyState
                    size="inline"
                    title="No absence planned"
                    body="Absences marked here or by the timeline appear here."
                  />
                </Card>
              )}
            </Section>
          </div>
        </>
      )}
    </Section>
  );
}

function ScenarioSection({
  status,
  scenarios,
  errors,
}: {
  readonly status: SimStatus | undefined;
  readonly scenarios: UseQueryResult<Awaited<ReturnType<typeof getScenarios>>>;
  readonly errors: ScreenErrors;
}) {
  const scenario = useQuery({
    queryKey: simKeys.scenario,
    queryFn: ({ signal }) => getScenario(signal),
    refetchInterval: LIST_POLL_MS,
  });
  const load = useAction(loadScenario, (r) => `Loaded ${r.scenario.name ?? 'the timeline'}.`);
  const loaded = scenario.data?.scenario ?? null;
  const loadable = loaded === null && status?.state === 'idle';
  type Listed = NonNullable<typeof scenarios.data>['scenarios'][number];
  type Entry = NonNullable<typeof loaded>['entries'][number];
  const listColumns: Column<Listed>[] = [
    {
      key: 'name',
      header: 'Timeline',
      rowHeader: true,
      nowrap: true,
      cell: (s) => <Code>{s.name}</Code>,
    },
    {
      key: 'description',
      header: 'What happens',
      cell: (s) =>
        s.description ?? <span className="text-ink-secondary">Does not parse: cannot load.</span>,
    },
  ];
  const entryColumns: Column<Entry>[] = [
    { key: 'entry', header: 'Entry', nowrap: true, cell: (e) => <Code>{e.entry}</Code> },
    // A plain cell with the action alone: the demo finds the row whose cell is exactly "pause".
    { key: 'action', header: 'Action', nowrap: true, cell: (e) => e.action },
    {
      key: 'at',
      header: 'At',
      nowrap: true,
      cell: (e) => <SimTime at={e.at} none="No time of its own" />,
    },
    { key: 'status', header: 'Status', nowrap: true, cell: (e) => e.status },
  ];
  return (
    <Section
      id="console-scenario-title"
      title="Scenario"
      testId="console-scenario"
      description="A committed timeline loads only while the run is idle (not started) and has no timeline, injection or action yet; then start the run."
    >
      {errors.inSection('the timelines') ? (
        <SectionError errors={errors} readKey="the timelines" />
      ) : (
        <DataTable
          caption="Committed timelines"
          testId="scenario-list"
          narrow="stack"
          columns={listColumns}
          rows={scenarios.data?.scenarios ?? []}
          rowKey={(s) => s.name}
          density="compact"
          loading={scenarios.data === undefined ? 'Loading the timelines…' : undefined}
          empty={
            <EmptyState
              title="No committed timeline"
              body="The simulator has no timeline to load."
            />
          }
          actions={(s) => (
            <Button
              size="sm"
              variant="secondary"
              data-testid={`scenario-load-${s.name}`}
              aria-label={`Load ${s.name}`}
              disabled={load.pending || !loadable}
              onClick={() => {
                load.act(s.name);
              }}
            >
              Load
            </Button>
          )}
        />
      )}
      {load.outcome ? <OutcomeLine outcome={load.outcome} testId="scenario-outcome" /> : null}
      {loaded ? (
        <div className="mt-6">
          <Section
            level={3}
            title={
              <span data-testid="scenario-name">{loaded.name ?? 'Inline timeline'}: progress</span>
            }
          >
            <DataTable
              caption="Timeline progress"
              testId="scenario-progress"
              columns={entryColumns}
              rows={loaded.entries}
              rowKey={(e) => e.entry}
              rowProps={(e) => ({ 'data-status': e.status })}
              density="compact"
              empty={<EmptyState title="No entries" body="The timeline has no entry." />}
            />
          </Section>
        </div>
      ) : null}
    </Section>
  );
}

const actionText = (a: SimAction): string => {
  switch (a.kind) {
    case 'lot-block':
      return `Block lot ${a.lot} (${a.material}) at ${timeText(a.at)}`;
    case 'lot-release':
      return `Release lot ${a.lot} (${a.material}) at ${timeText(a.at)}`;
    case 'tool-breakage':
      return `Tool breakage on ${a.machine} at ${timeText(a.at)}${a.cycles === undefined ? '' : ` after ${String(a.cycles)} cycles`}`;
    case 'operators-absent':
      return `${a.operators.join(', ')} absent in shift ${a.shift}`;
  }
};

/** A row of a log list: the id, what it is, its status. */
const ITEM = 'grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-2 py-2';

function LogItem({
  id,
  status,
  children,
  ...data
}: {
  readonly id: number;
  readonly status: string;
  readonly children: ReactNode;
  readonly 'data-testid': string;
  readonly 'data-status': string;
  readonly 'data-kind'?: string;
}) {
  return (
    <li {...data} className={ITEM}>
      <span className="text-ink-secondary tabular-nums">#{id}</span>
      <span className="break-words">{children}</span>
      <Badge tone="neutral" variant="outline">
        {status}
      </Badge>
    </li>
  );
}

function List<T>({
  query,
  what,
  errors,
  testId,
  items,
  empty,
  render,
}: {
  readonly query: { data: unknown };
  readonly what: string;
  readonly errors: ScreenErrors;
  readonly testId: string;
  readonly items: readonly T[];
  readonly empty: { readonly title: string; readonly body: string };
  readonly render: (item: T) => ReactNode;
}) {
  if (errors.inSection(what)) return <SectionError errors={errors} readKey={what} />;
  if (query.data === undefined)
    return <Skeleton shape="text" rows={3} label={`Loading ${what}…`} />;
  if (items.length === 0) return <EmptyState size="inline" title={empty.title} body={empty.body} />;
  return (
    <ul className="divide-y divide-line-subtle text-sm" data-testid={testId}>
      {items.map(render)}
    </ul>
  );
}

/**
 * The plant event stream (`/sim/api/v1/events`), the last `EVENT_TAIL` events, redrawn at most
 * once a second (at 60× a busy plant sends many). Reconnects while shown: at once (250 ms) when the
 * simulator ended the stream's lifetime (`EVENTS_LIFETIME_CLOSE`, #237 review: every new upgrade
 * passes nginx's permission check again), 2 s after any other close. Not `enabled` (a status poll
 * answered 401 or 403: the session ended or lost `sim:control`), the socket is closed at once.
 */
export function usePlantEvents(enabled: boolean): {
  readonly lines: readonly string[];
  readonly connected: boolean;
} {
  const [lines, setLines] = useState<readonly string[]>([]);
  const [connected, setConnected] = useState(false);
  const buffer = useRef<string[]>([]);
  useEffect(() => {
    if (!enabled || typeof WebSocket === 'undefined') return undefined;
    let socket: WebSocket | undefined;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${window.location.host}${SIM_EVENTS_PATH}`);
      socket.addEventListener('open', () => {
        setConnected(true);
      });
      socket.addEventListener('message', (message: MessageEvent) => {
        buffer.current.push(String(message.data));
        if (buffer.current.length > EVENT_TAIL)
          buffer.current.splice(0, buffer.current.length - EVENT_TAIL);
      });
      socket.addEventListener('close', (event: CloseEvent) => {
        setConnected(false);
        if (!stopped) retry = setTimeout(open, event.code === EVENTS_LIFETIME_CLOSE ? 250 : 2_000);
      });
    };
    open();
    const flush = setInterval(() => {
      setLines((shown) =>
        shown.length === buffer.current.length && shown.at(-1) === buffer.current.at(-1)
          ? shown
          : [...buffer.current],
      );
    }, EVENT_FLUSH_MS);
    return () => {
      stopped = true;
      clearInterval(flush);
      if (retry !== undefined) clearTimeout(retry);
      socket?.close();
    };
  }, [enabled]);
  return { lines, connected };
}

/** One event line: `seq`, its simulation time, its type and machine. */
function EventLine({ line }: { readonly line: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = undefined;
  }
  // Not a JSON object (not JSON, `null`, a number): the line as it came.
  if (typeof parsed !== 'object' || parsed === null) {
    return <li className="py-1 break-all">{line}</li>;
  }
  const event = parsed as { seq?: number; at?: string; type?: string; machineId?: string };
  return (
    <li className="flex flex-wrap gap-x-2 py-1">
      <span className="text-ink-secondary tabular-nums">{String(event.seq ?? '?')}</span>{' '}
      <span className="tabular-nums">{timeText(event.at)}</span> <span>{event.type ?? '?'}</span>
      {event.machineId ? (
        <>
          {' '}
          <Code>{event.machineId}</Code>
        </>
      ) : null}
    </li>
  );
}

function EventsCard({ enabled }: { readonly enabled: boolean }) {
  const { lines, connected } = usePlantEvents(enabled);
  return (
    <Card as="section" title="Plant events" headingLevel={3} testId="console-events">
      <p
        className="flex flex-wrap items-center gap-2 text-sm text-ink-secondary"
        data-testid="events-connection"
        data-connected={connected}
      >
        <Badge tone={connected ? 'neutral' : 'warn'} icon="dot">
          {connected ? 'Live' : 'Connecting…'}
        </Badge>
        <span>The last {EVENT_TAIL}, newest first.</span>
      </p>
      {lines.length === 0 ? (
        <EmptyState
          size="inline"
          title="No plant event yet"
          body="Events show here while the run is going."
        />
      ) : (
        <ol
          className="mt-2 divide-y divide-line-subtle text-sm"
          data-testid="event-list"
          aria-label="Plant events, newest first"
        >
          {[...lines].reverse().map((line, i) => (
            <EventLine key={`${String(lines.length - i)}-${line.slice(0, 40)}`} line={line} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function LogSection({
  enabled,
  actions,
  injections,
  drifts,
  errors,
}: {
  readonly enabled: boolean;
  readonly actions: UseQueryResult<Awaited<ReturnType<typeof getActions>>>;
  readonly injections: UseQueryResult<Awaited<ReturnType<typeof getInjections>>>;
  readonly drifts: UseQueryResult<Awaited<ReturnType<typeof getDrifts>>>;
  readonly errors: ScreenErrors;
}) {
  return (
    <Section
      id="console-log-title"
      title="Log"
      testId="console-log"
      description="What the console asked of the simulator, and the plant's events as they happen."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Card as="section" title="Console actions" headingLevel={3} testId="console-actions">
          <List
            query={actions}
            what="the actions"
            errors={errors}
            testId="action-list"
            items={actions.data?.actions ?? []}
            empty={{
              title: 'No console action yet',
              body: 'Blocked lots, absences and tool breakages show here.',
            }}
            render={(a) => (
              <LogItem
                key={a.id}
                id={a.id}
                status={a.status}
                data-testid={`action-${String(a.id)}`}
                data-kind={a.kind}
                data-status={a.status}
              >
                {actionText(a)}
              </LogItem>
            )}
          />
        </Card>
        <Card as="section" title="Failure injections" headingLevel={3} testId="console-injections">
          <List
            query={injections}
            what="the failure injections"
            errors={errors}
            testId="injection-list"
            items={injections.data?.injections ?? []}
            empty={{ title: 'No failure injected yet', body: 'Inject one under Faults.' }}
            render={(i) => (
              <LogItem
                key={i.id}
                id={i.id}
                status={i.status}
                data-testid={`injection-${String(i.id)}`}
                data-status={i.status}
              >
                <Code>{i.code}</Code> on <Code>{i.machine}</Code> at {timeText(i.at)}
                {i.appliedAt ? `, applied ${timeText(i.appliedAt)}` : ''}
              </LogItem>
            )}
          />
        </Card>
        <Card as="section" title="Leak-test drifts" headingLevel={3} testId="console-drifts">
          <List
            query={drifts}
            what="the drifts"
            errors={errors}
            testId="drift-list"
            items={drifts.data?.drifts ?? []}
            empty={{ title: 'No drift injected yet', body: 'Inject one under Faults.' }}
            render={(d) => (
              <LogItem
                key={d.id}
                id={d.id}
                status={d.status}
                data-testid={`drift-${String(d.id)}`}
                data-status={d.status}
              >
                {d.shift} Pa/min on <Code>{d.machine}</Code> from {timeText(d.at)} until{' '}
                {timeText(d.until)}
              </LogItem>
            )}
          />
        </Card>
        <EventsCard enabled={enabled} />
      </div>
    </Section>
  );
}

/** `/console` (#237, `sim:control`: admin only). */
export function Console() {
  const allowed = useCan('sim:control');
  const status = useQuery({
    queryKey: simKeys.status,
    queryFn: ({ signal }) => getStatus(signal),
    refetchInterval: STATUS_POLL_MS,
    enabled: allowed,
  });
  const equipment = useQuery({
    queryKey: queryKeys.equipmentList,
    queryFn: ({ signal }) => listEquipment(signal),
    enabled: allowed,
  });
  const reasons = useQuery({
    queryKey: queryKeys.reasonCodes,
    queryFn: ({ signal }) => getReasonCodes(signal),
    enabled: allowed,
  });
  // Every section's read, here so the console says one error when several failed (#394): with
  // the simulator down, one alert instead of one per section.
  const scenarios = useQuery({
    queryKey: simKeys.scenarios,
    queryFn: ({ signal }) => getScenarios(signal),
    enabled: allowed,
  });
  const lots = useQuery({
    queryKey: simKeys.lots,
    queryFn: ({ signal }) => getLots(signal),
    refetchInterval: LIST_POLL_MS,
    enabled: allowed,
  });
  const operators = useQuery({
    queryKey: simKeys.operators,
    queryFn: ({ signal }) => getOperators(signal),
    refetchInterval: LIST_POLL_MS,
    enabled: allowed,
  });
  const actions = useQuery({
    queryKey: simKeys.actions,
    queryFn: ({ signal }) => getActions(signal),
    refetchInterval: LIST_POLL_MS,
    enabled: allowed,
  });
  const injections = useQuery({
    queryKey: simKeys.injections,
    queryFn: ({ signal }) => getInjections(signal),
    refetchInterval: LIST_POLL_MS,
    enabled: allowed,
  });
  const drifts = useQuery({
    queryKey: simKeys.drifts,
    queryFn: ({ signal }) => getDrifts(signal),
    refetchInterval: LIST_POLL_MS,
    enabled: allowed,
  });
  const errors = screenErrors([
    queryRead('the run', status, 'section'),
    queryRead('the timelines', scenarios, 'section'),
    queryRead('the machines', equipment, 'section'),
    queryRead('the lots', lots, 'section'),
    queryRead('the operators', operators, 'section'),
    queryRead('the actions', actions, 'section'),
    queryRead('the failure injections', injections, 'section'),
    queryRead('the drifts', drifts, 'section'),
  ]);
  // The session ended or lost sim:control (nginx's 401 or 403 on the poll): the event stream,
  // checked only at its upgrade, closes now rather than at the end of its lifetime.
  const denied =
    status.error instanceof SimError &&
    (status.error.status === 401 || status.error.status === 403);
  // Failure codes: the breakdown reasons' last segment (the simulator answers 404 for a code the
  // machine doesn't have).
  const codes = (reasons.data?.reasons ?? [])
    .filter((r) => r.parent === 'BREAKDOWN' && !r.id.endsWith('/UNSPECIFIED'))
    .map((r) => r.id.slice('BREAKDOWN/'.length));
  return (
    <section aria-labelledby="console-title">
      <PageHeader
        id="console-title"
        title="Simulation console"
        description={
          allowed
            ? 'These levers change the simulated plant; the MES sees them only through the machines.'
            : undefined
        }
      />
      {!allowed ? (
        <Forbidden testId="console-forbidden" permission="sim:control">
          Only an admin drives the simulation
        </Forbidden>
      ) : (
        <>
          {errors.whole ? null : (
            <SectionNav items={CONSOLE_SECTIONS} testId="console-section-nav" />
          )}
          <div className="mt-6">
            {errors.summary.length > 0 ? (
              <div className="mb-6">
                <ScreenError errors={errors} />
              </div>
            ) : null}
            {errors.whole ? null : (
              <>
                <RunSection
                  status={status.data}
                  error={
                    errors.inSection('the run') ? (
                      <div className="mb-3">
                        <SectionError errors={errors} readKey="the run" />
                      </div>
                    ) : null
                  }
                />
                <ScenarioSection status={status.data} scenarios={scenarios} errors={errors} />
                <FaultsSection equipment={equipment} codes={codes} errors={errors} />
                <MaterialsSection lots={lots} errors={errors} />
                <OperatorsSection operators={operators} errors={errors} />
                <LogSection
                  enabled={!denied}
                  actions={actions}
                  injections={injections}
                  drifts={drifts}
                  errors={errors}
                />
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
