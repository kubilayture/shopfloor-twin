import type { EquipmentDto } from '@shopfloor/contracts/mes-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
  type SimStatus,
} from '../api/sim.ts';
import { useCan } from '../auth/auth.tsx';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { QueryError } from '../components/query-error.tsx';
import { plantTimeText } from '../domain/time.ts';

// The simulation console (#237, Phase 9 plan "Simulation console", ADR-0037): the physical world
// under test, for `admin` only (`sim:control`). Everything goes to the simulator's control API
// through nginx's `/sim/` allowlist; the MES only answers the permission check and never calls
// the control API. Live through a 1 s status poll and the plant event stream; the console holds
// no MES push topic (the push budget stays the screens', #233). Only an action (a POST or PUT)
// counts as use of the session: an open console nobody touches times out like any other page.

const inputClass = 'rounded border border-slate-500 bg-white px-2 py-1 text-sm';
const buttonClass =
  'rounded border border-slate-700 bg-white px-3 py-1 text-sm font-medium text-slate-900 hover:bg-slate-100 disabled:opacity-60';
const primaryClass =
  'rounded border border-sky-900 bg-sky-800 px-3 py-1 text-sm font-semibold text-white hover:bg-sky-900 disabled:opacity-60';

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

interface Outcome {
  readonly kind: 'done' | 'failed';
  readonly text: string;
}

function OutcomeLine({ outcome, testId }: { readonly outcome: Outcome; readonly testId: string }) {
  return (
    <p
      role={outcome.kind === 'done' ? 'status' : 'alert'}
      data-testid={testId}
      data-kind={outcome.kind}
      className={`mt-2 rounded border p-2 text-sm ${
        outcome.kind === 'done'
          ? 'border-emerald-800 bg-emerald-50 text-emerald-950'
          : 'border-red-800 bg-red-50 text-red-950'
      }`}
    >
      {outcome.text}
    </p>
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
  const mutation = useMutation({
    mutationFn: (args: A) => run(...args),
    onSuccess: (result, args) => {
      setOutcome({ kind: 'done', text: done(result, ...args) });
    },
    onError: (error) => {
      setOutcome({
        kind: 'failed',
        text: error instanceof SimError ? error.message : 'The action failed',
      });
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
    pending: mutation.isPending,
    outcome,
  };
}

function Panel({
  title,
  testId,
  children,
}: {
  readonly title: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      data-testid={testId}
      className="rounded border border-slate-300 bg-white p-4"
    >
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Simulation times in plant time, as the header shows the plant clock (#295). */
const timeText = plantTimeText;

const STATE_TEXT: Readonly<Record<SimStatus['state'], string>> = {
  idle: 'Idle (not started)',
  running: 'Running',
  paused: 'Paused',
  finished: 'Finished',
};

function RunPanel({ status }: { readonly status: SimStatus | undefined }) {
  const [speed, setSpeedDraft] = useState<number | undefined>(undefined);
  const shown = speed ?? status?.speed ?? 60;
  const speedId = useId();
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined);
  const doPause = useAction(pause, (s) => `Paused at ${timeText(s.simTime)}.`, setOutcome);
  const doResume = useAction(resume, (s) => `Running at ${String(s.speed)}×.`, setOutcome);
  const doStep = useAction(
    step,
    (r) => (r.stepped ? `Stepped to ${timeText(r.status.simTime)}.` : 'No event left to process.'),
    setOutcome,
  );
  const doSpeed = useAction(setSpeed, (s) => `Speed ${String(s.speed)}×.`, setOutcome);
  return (
    <Panel title="Run" testId="console-run">
      {status ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-5">
          <div>
            <dt className="text-slate-600">State</dt>
            <dd data-testid="sim-state" data-state={status.state} className="font-semibold">
              {STATE_TEXT[status.state]}
            </dd>
          </div>
          <div>
            <dt className="text-slate-600">Simulation time</dt>
            <dd data-testid="sim-time" className="font-mono">
              <time dateTime={status.simTime}>{timeText(status.simTime)}</time>
            </dd>
          </div>
          <div>
            <dt className="text-slate-600">Speed</dt>
            <dd data-testid="sim-speed">{status.speed}×</dd>
          </div>
          <div>
            <dt className="text-slate-600">Events</dt>
            <dd data-testid="sim-events">{status.events}</dd>
          </div>
          <div>
            <dt className="text-slate-600">Lag</dt>
            <dd>{Math.round(status.lagMs)} ms</dd>
          </div>
        </dl>
      ) : (
        <p role="status" className="mt-2 text-sm">
          Reading the run…
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass}
          data-testid="sim-pause"
          disabled={doPause.pending || status?.state !== 'running'}
          onClick={() => {
            doPause.act();
          }}
        >
          Pause
        </button>
        <button
          type="button"
          className={buttonClass}
          data-testid="sim-resume"
          disabled={doResume.pending || (status?.state !== 'paused' && status?.state !== 'idle')}
          onClick={() => {
            doResume.act();
          }}
        >
          {status?.state === 'idle' ? 'Start' : 'Resume'}
        </button>
        <button
          type="button"
          className={buttonClass}
          data-testid="sim-step"
          disabled={doStep.pending || (status?.state !== 'paused' && status?.state !== 'idle')}
          onClick={() => {
            doStep.act();
          }}
        >
          Step one event
        </button>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            doSpeed.act(shown);
            setSpeedDraft(undefined);
          }}
        >
          <label htmlFor={speedId} className="text-sm">
            Speed
          </label>
          <input
            type="range"
            aria-label="Speed slider"
            data-testid="sim-speed-range"
            min={SPEED_RANGE.min}
            max={SPEED_RANGE.max}
            step={0.5}
            value={shown}
            onChange={(event) => {
              setSpeedDraft(Number(event.target.value));
            }}
          />
          <input
            id={speedId}
            type="number"
            className={`${inputClass} w-20`}
            data-testid="sim-speed-input"
            min={SPEED_RANGE.min}
            max={SPEED_RANGE.max}
            step={0.5}
            value={shown}
            onChange={(event) => {
              setSpeedDraft(Number(event.target.value));
            }}
          />
          <span className="text-sm">×</span>
          <button type="submit" className={buttonClass} data-testid="sim-speed-apply">
            Set speed
          </button>
        </form>
      </div>
      {outcome ? <OutcomeLine outcome={outcome} testId="run-outcome" /> : null}
    </Panel>
  );
}

function FailurePanel({
  machines,
  codes,
}: {
  readonly machines: readonly EquipmentDto[];
  readonly codes: readonly string[];
}) {
  const [machine, setMachine] = useState('');
  const [code, setCode] = useState('');
  const [at, setAt] = useState('');
  const [repair, setRepair] = useState('');
  const listId = useId();
  const injections = useQuery({
    queryKey: simKeys.injections,
    queryFn: ({ signal }) => getInjections(signal),
    refetchInterval: LIST_POLL_MS,
  });
  const inject = useAction(
    (target: string, body: Parameters<typeof injectFailure>[1]) => injectFailure(target, body),
    (r) => `Failure ${r.injection.code} on ${r.injection.machine}: ${r.injection.status}.`,
  );
  const chosen = machine === '' ? (machines[0]?.id ?? '') : machine;
  return (
    <Panel title="Failure injection" testId="console-failure">
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          inject.act(chosen, {
            code: code.trim(),
            ...(at.trim() === '' ? {} : { at: at.trim() }),
            ...(repair.trim() === '' ? {} : { repairMs: Math.round(Number(repair) * 60_000) }),
          });
        }}
      >
        <label className="flex flex-col text-sm">
          Machine
          <select
            className={inputClass}
            data-testid="failure-machine"
            value={chosen}
            onChange={(event) => {
              setMachine(event.target.value);
            }}
          >
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Failure code
          <input
            className={inputClass}
            data-testid="failure-code"
            list={listId}
            required
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
          <datalist id={listId}>
            {codes.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col text-sm">
          At (simulation time, optional; UTC, ISO 8601)
          <input
            className={inputClass}
            data-testid="failure-at"
            placeholder="2026-10-12T05:00:00Z"
            value={at}
            onChange={(event) => {
              setAt(event.target.value);
            }}
          />
        </label>
        <label className="flex flex-col text-sm">
          Repair minutes (optional)
          <input
            className={inputClass}
            data-testid="failure-repair"
            inputMode="decimal"
            value={repair}
            onChange={(event) => {
              setRepair(event.target.value);
            }}
          />
        </label>
        <button
          type="submit"
          className={primaryClass}
          data-testid="failure-inject"
          disabled={inject.pending}
        >
          Inject failure
        </button>
      </form>
      {inject.outcome ? <OutcomeLine outcome={inject.outcome} testId="failure-outcome" /> : null}
      <List
        query={injections}
        what="the failure injections"
        testId="injection-list"
        items={injections.data?.injections ?? []}
        empty="No failure injected yet."
        render={(i) => (
          <li key={i.id} data-testid={`injection-${String(i.id)}`} data-status={i.status}>
            #{i.id} {i.machine} {i.code} at {timeText(i.at)}: {i.status}
            {i.appliedAt ? ` (applied ${timeText(i.appliedAt)})` : ''}
          </li>
        )}
      />
    </Panel>
  );
}

function DriftPanel({ testers }: { readonly testers: readonly EquipmentDto[] }) {
  const [shift, setShift] = useState('0.6');
  const [until, setUntil] = useState('');
  const [at, setAt] = useState('');
  const drifts = useQuery({
    queryKey: simKeys.drifts,
    queryFn: ({ signal }) => getDrifts(signal),
    refetchInterval: LIST_POLL_MS,
  });
  const machine = testers[0]?.id ?? 'lkt-01';
  const drift = useAction(
    (body: Parameters<typeof injectDrift>[1]) => injectDrift(machine, body),
    (r) =>
      `Leak-test drift of ${String(r.drift.shift)} until ${timeText(r.drift.until)}: ${r.drift.status}.`,
  );
  return (
    <Panel title="Leak-test sensor drift" testId="console-drift">
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          drift.act({
            shift: Number(shift),
            until: until.trim(),
            ...(at.trim() === '' ? {} : { at: at.trim() }),
          });
        }}
      >
        <span className="text-sm">On {machine}:</span>
        <label className="flex flex-col text-sm">
          Shift (Pa/min)
          <input
            className={inputClass}
            data-testid="drift-shift"
            inputMode="decimal"
            value={shift}
            onChange={(event) => {
              setShift(event.target.value);
            }}
          />
        </label>
        <label className="flex flex-col text-sm">
          From (simulation time, optional; UTC, ISO 8601)
          <input
            className={inputClass}
            data-testid="drift-at"
            placeholder="2026-10-12T05:00:00Z"
            value={at}
            onChange={(event) => {
              setAt(event.target.value);
            }}
          />
        </label>
        <label className="flex flex-col text-sm">
          Until (simulation time; UTC, ISO 8601)
          <input
            className={inputClass}
            data-testid="drift-until"
            required
            placeholder="2026-10-12T08:00:00Z"
            value={until}
            onChange={(event) => {
              setUntil(event.target.value);
            }}
          />
        </label>
        <button
          type="submit"
          className={primaryClass}
          data-testid="drift-inject"
          disabled={drift.pending}
        >
          Inject drift
        </button>
      </form>
      {drift.outcome ? <OutcomeLine outcome={drift.outcome} testId="drift-outcome" /> : null}
      <List
        query={drifts}
        what="the drifts"
        testId="drift-list"
        items={drifts.data?.drifts ?? []}
        empty="No drift injected yet."
        render={(d) => (
          <li key={d.id} data-testid={`drift-${String(d.id)}`} data-status={d.status}>
            #{d.id} {d.machine} {d.shift} from {timeText(d.at)} until {timeText(d.until)}:{' '}
            {d.status}
          </li>
        )}
      />
    </Panel>
  );
}

function InfrastructurePanel({
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
  return (
    <Panel title="Infrastructure faults" testId="console-infrastructure">
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {opcua.map((m) => {
          const isOffline = offline[m.id] === true;
          return (
            <li key={m.id} className="flex flex-wrap items-center gap-2">
              <span className="w-20 font-mono">{m.id}</span>
              <span data-testid={`opcua-state-${m.id}`}>
                OPC UA{' '}
                {offline[m.id] === undefined ? 'as started' : isOffline ? 'offline' : 'online'}
              </span>
              <button
                type="button"
                className={buttonClass}
                data-testid={`opcua-toggle-${m.id}`}
                disabled={opcuaAction.pending}
                onClick={() => {
                  opcuaAction.act(m.id, !isOffline);
                }}
              >
                {isOffline ? 'Bring online' : 'Take offline'}
              </button>
            </li>
          );
        })}
        {modbus.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-2">
            <span className="w-20 font-mono">{m.id}</span>
            <span data-testid="modbus-state">
              Modbus {silent === undefined ? 'as started' : silent ? 'silent' : 'answering'}
            </span>
            <button
              type="button"
              className={buttonClass}
              data-testid="modbus-toggle"
              disabled={modbusAction.pending}
              onClick={() => {
                modbusAction.act(silent !== true);
              }}
            >
              {silent === true ? 'Answer again' : 'Go silent'}
            </button>
          </li>
        ))}
      </ul>
      {outcome ? <OutcomeLine outcome={outcome} testId="infrastructure-outcome" /> : null}
    </Panel>
  );
}

function LotsPanel() {
  const lots = useQuery({
    queryKey: simKeys.lots,
    queryFn: ({ signal }) => getLots(signal),
    refetchInterval: LIST_POLL_MS,
  });
  const lotAction = useAction(
    (lot: string, blocked: boolean) => setLotBlocked(lot, blocked),
    (r, lot, blocked) =>
      `${lot} ${blocked ? 'block' : 'release'}: ${r.action.status}${'at' in r.action ? ` at ${timeText(r.action.at)}` : ''}.`,
  );
  return (
    <Panel title="Material lots" testId="console-lots">
      {lotAction.outcome ? <OutcomeLine outcome={lotAction.outcome} testId="lot-outcome" /> : null}
      {lots.isError ? (
        <QueryError what="the lots" error={lots.error} onRetry={() => void lots.refetch()} />
      ) : lots.data === undefined ? (
        <p role="status">Loading the lots…</p>
      ) : (
        <table className="mt-2 w-full text-left text-sm" data-testid="lot-table">
          <thead>
            <tr className="border-b border-slate-300">
              <th className="py-1">Lot</th>
              <th>Material</th>
              <th className="text-right">Remaining</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lots.data.lots.map((lot) => (
              <tr
                key={lot.lot}
                className="border-b border-slate-200"
                data-testid={`lot-${lot.lot}`}
                data-blocked={lot.blocked}
              >
                <td className="py-1 font-mono">{lot.lot}</td>
                <td>{lot.material}</td>
                <td className="text-right tabular-nums">{lot.remaining}</td>
                <td>{lot.blocked ? 'Blocked' : 'Free'}</td>
                <td className="text-right">
                  {/* Both, always: an action applies at the next step, so a paused run still
                      shows the lot as it was. */}
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      className={buttonClass}
                      data-testid={`lot-block-${lot.lot}`}
                      disabled={lotAction.pending}
                      onClick={() => {
                        lotAction.act(lot.lot, true);
                      }}
                    >
                      Block
                    </button>
                    <button
                      type="button"
                      className={buttonClass}
                      data-testid={`lot-release-${lot.lot}`}
                      disabled={lotAction.pending}
                      onClick={() => {
                        lotAction.act(lot.lot, false);
                      }}
                    >
                      Release
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/** `2026-10-12/A` → its date and shift id. */
const splitShift = (key: string | null): { date: string; shift: string } => {
  const [date = '', shift = ''] = (key ?? '').split('/');
  return { date, shift };
};

function OperatorsPanel() {
  const operators = useQuery({
    queryKey: simKeys.operators,
    queryFn: ({ signal }) => getOperators(signal),
    refetchInterval: LIST_POLL_MS,
  });
  const current = splitShift(operators.data?.currentShift ?? null);
  const shiftIds = [...new Set((operators.data?.operators ?? []).map((o) => o.shift))].sort();
  const [date, setDate] = useState<string | undefined>(undefined);
  const [shiftId, setShiftId] = useState<string | undefined>(undefined);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const day = date ?? current.date;
  const id = shiftId ?? shiftIds.find((s) => s !== current.shift) ?? shiftIds[0] ?? '';
  const absent = useAction(
    (shift: string, ids: readonly string[]) => markAbsent(shift, ids),
    (r) =>
      r.action.kind === 'operators-absent'
        ? `${r.action.operators.join(', ')} absent in shift ${r.action.shift} (${r.action.status}).`
        : 'Done.',
  );
  return (
    <Panel title="Operators" testId="console-operators">
      {operators.isError ? (
        <QueryError
          what="the operators"
          error={operators.error}
          onRetry={() => void operators.refetch()}
        />
      ) : operators.data === undefined ? (
        <p role="status">Loading the operators…</p>
      ) : (
        <>
          <p className="mt-1 text-sm" data-testid="current-shift">
            Current shift: {operators.data.currentShift ?? 'none (between shifts)'}
          </p>
          <form
            className="mt-2 flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              absent.act(`${day}/${id}`, chosen);
              setChosen([]);
            }}
          >
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col text-sm">
                Shift date
                <input
                  className={inputClass}
                  data-testid="absent-date"
                  type="date"
                  value={day}
                  onChange={(event) => {
                    setDate(event.target.value);
                  }}
                />
              </label>
              <label className="flex flex-col text-sm">
                Shift
                <select
                  className={inputClass}
                  data-testid="absent-shift"
                  value={id}
                  onChange={(event) => {
                    setShiftId(event.target.value);
                    setChosen([]);
                  }}
                >
                  {shiftIds.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className={primaryClass}
                data-testid="absent-submit"
                disabled={absent.pending || chosen.length === 0}
              >
                Mark absent for that shift
              </button>
            </div>
            <table className="w-full text-left text-sm" data-testid="operator-table">
              <thead>
                <tr className="border-b border-slate-300">
                  <th className="py-1">Absent</th>
                  <th>Operator</th>
                  <th>Shift</th>
                  <th>Skills</th>
                  <th>Now</th>
                  <th>Station</th>
                </tr>
              </thead>
              <tbody>
                {operators.data.operators.map((o) => (
                  <tr
                    key={o.id}
                    className="border-b border-slate-200"
                    data-testid={`operator-${o.id}`}
                  >
                    <td className="py-1">
                      <input
                        type="checkbox"
                        aria-label={`${o.id} absent`}
                        data-testid={`absent-${o.id}`}
                        disabled={o.shift !== id}
                        checked={chosen.includes(o.id)}
                        onChange={(event) => {
                          setChosen((list) =>
                            event.target.checked ? [...list, o.id] : list.filter((x) => x !== o.id),
                          );
                        }}
                      />
                    </td>
                    <td className="font-mono">{o.id}</td>
                    <td>{o.shift}</td>
                    <td>{o.skills.join(', ')}</td>
                    <td data-testid={`operator-status-${o.id}`}>
                      {o.status}
                      {o.forced ? ' (forced)' : ''}
                    </td>
                    <td>{o.station ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </form>
          {absent.outcome ? <OutcomeLine outcome={absent.outcome} testId="absent-outcome" /> : null}
          {operators.data.absences.length > 0 ? (
            <ul className="mt-2 text-sm" data-testid="absence-list">
              {operators.data.absences.map((a) => (
                <li key={a.id} data-testid={`absence-${String(a.id)}`} data-status={a.status}>
                  #{a.id} {a.operators.join(', ')} in {a.shift}: {a.status}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function ToolPanel({ cncs }: { readonly cncs: readonly EquipmentDto[] }) {
  const tool = useAction(breakTool, (r, machine) =>
    r.action.kind === 'tool-breakage'
      ? `${machine}'s tool breaks at ${timeText(r.action.at)} (${r.action.status}).`
      : 'Done.',
  );
  return (
    <Panel title="Tool breakage" testId="console-tool">
      <div className="mt-2 flex flex-wrap gap-2">
        {cncs.map((m) => (
          <button
            key={m.id}
            type="button"
            className={buttonClass}
            data-testid={`tool-break-${m.id}`}
            disabled={tool.pending}
            onClick={() => {
              tool.act(m.id);
            }}
          >
            Break {m.id}'s tool
          </button>
        ))}
      </div>
      {tool.outcome ? <OutcomeLine outcome={tool.outcome} testId="tool-outcome" /> : null}
    </Panel>
  );
}

function ScenarioPanel({ status }: { readonly status: SimStatus | undefined }) {
  const scenarios = useQuery({
    queryKey: simKeys.scenarios,
    queryFn: ({ signal }) => getScenarios(signal),
  });
  const scenario = useQuery({
    queryKey: simKeys.scenario,
    queryFn: ({ signal }) => getScenario(signal),
    refetchInterval: LIST_POLL_MS,
  });
  const load = useAction(loadScenario, (r) => `Loaded ${r.scenario.name ?? 'the timeline'}.`);
  const loaded = scenario.data?.scenario ?? null;
  return (
    <Panel title="Scenario timeline" testId="console-scenario">
      <p className="mt-1 text-sm text-slate-700">
        A committed timeline loads only while the run is idle (not started) and has no timeline,
        injection or action yet; then start the run.
      </p>
      {scenarios.isError ? (
        <QueryError
          what="the timelines"
          error={scenarios.error}
          onRetry={() => void scenarios.refetch()}
        />
      ) : (
        <ul className="mt-2 flex flex-col gap-1 text-sm" data-testid="scenario-list">
          {(scenarios.data?.scenarios ?? []).map((s) => (
            <li key={s.name} className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={buttonClass}
                data-testid={`scenario-load-${s.name}`}
                disabled={load.pending || loaded !== null || status?.state !== 'idle'}
                onClick={() => {
                  load.act(s.name);
                }}
              >
                Load
              </button>
              <span className="font-mono">{s.name}</span>
              <span className="text-slate-700">{s.description ?? '(does not parse)'}</span>
            </li>
          ))}
        </ul>
      )}
      {load.outcome ? <OutcomeLine outcome={load.outcome} testId="scenario-outcome" /> : null}
      {loaded ? (
        <>
          <h3 className="mt-3 font-semibold" data-testid="scenario-name">
            {loaded.name ?? 'Inline timeline'}: progress
          </h3>
          <table className="mt-1 w-full text-left text-sm" data-testid="scenario-progress">
            <thead>
              <tr className="border-b border-slate-300">
                <th className="py-1">Entry</th>
                <th>Action</th>
                <th>At</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {loaded.entries.map((e) => (
                <tr key={e.entry} className="border-b border-slate-200" data-status={e.status}>
                  <td className="py-1 font-mono">{e.entry}</td>
                  <td>{e.action}</td>
                  <td>{timeText(e.at)}</td>
                  <td>{e.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </Panel>
  );
}

const actionText = (a: SimAction): string => {
  switch (a.kind) {
    case 'lot-block':
    case 'lot-release':
      return `${a.kind} ${a.lot} (${a.material}) at ${timeText(a.at)}`;
    case 'tool-breakage':
      return `tool-breakage ${a.machine} at ${timeText(a.at)}${a.cycles === undefined ? '' : ` after ${String(a.cycles)} cycles`}`;
    case 'operators-absent':
      return `operators-absent ${a.operators.join(', ')} in ${a.shift}`;
  }
};

function ActionsPanel() {
  const actions = useQuery({
    queryKey: simKeys.actions,
    queryFn: ({ signal }) => getActions(signal),
    refetchInterval: LIST_POLL_MS,
  });
  return (
    <Panel title="Console actions" testId="console-actions">
      <List
        query={actions}
        what="the actions"
        testId="action-list"
        items={actions.data?.actions ?? []}
        empty="No console action yet."
        render={(a) => (
          <li
            key={a.id}
            data-testid={`action-${String(a.id)}`}
            data-kind={a.kind}
            data-status={a.status}
          >
            #{a.id} {actionText(a)}: {a.status}
          </li>
        )}
      />
    </Panel>
  );
}

function List<T>({
  query,
  what,
  testId,
  items,
  empty,
  render,
}: {
  readonly query: { isError: boolean; error: unknown; data: unknown; refetch: () => unknown };
  readonly what: string;
  readonly testId: string;
  readonly items: readonly T[];
  readonly empty: string;
  readonly render: (item: T) => ReactNode;
}) {
  if (query.isError) {
    return <QueryError what={what} error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (query.data === undefined) return <p role="status">Loading {what}…</p>;
  if (items.length === 0) return <p className="mt-2 text-sm text-slate-700">{empty}</p>;
  return (
    <ul className="mt-2 flex flex-col gap-0.5 text-sm" data-testid={testId}>
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

/** One event line in short: `seq at type machine`. */
const eventText = (line: string): string => {
  try {
    const event = JSON.parse(line) as {
      seq?: number;
      at?: string;
      type?: string;
      machineId?: string;
    };
    return `${String(event.seq ?? '?')} ${timeText(event.at)} ${event.type ?? '?'}${event.machineId ? ` ${event.machineId}` : ''}`;
  } catch {
    return line;
  }
};

function EventsPanel({ enabled }: { readonly enabled: boolean }) {
  const { lines, connected } = usePlantEvents(enabled);
  return (
    <Panel title="Plant events" testId="console-events">
      <p className="mt-1 text-sm" data-testid="events-connection" data-connected={connected}>
        {connected ? 'Live' : 'Connecting…'} (the last {EVENT_TAIL}, newest first)
      </p>
      <ol className="mt-1 font-mono text-xs" data-testid="event-list">
        {[...lines].reverse().map((line, i) => (
          <li key={`${String(lines.length - i)}-${line.slice(0, 40)}`}>{eventText(line)}</li>
        ))}
      </ol>
    </Panel>
  );
}

/** `/console` (#237, `sim:control`: admin only). */
export function Console() {
  const heading = useHeadingFocus<HTMLHeadingElement>();
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
  // The session ended or lost sim:control (nginx's 401 or 403 on the poll): the event stream,
  // checked only at its upgrade, closes now rather than at the end of its lifetime.
  const denied =
    status.error instanceof SimError &&
    (status.error.status === 401 || status.error.status === 403);
  const machines = [...(equipment.data ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  // Failure codes: the breakdown reasons' last segment (the simulator answers 404 for a code the
  // machine doesn't have).
  const codes = (reasons.data?.reasons ?? [])
    .filter((r) => r.parent === 'BREAKDOWN' && !r.id.endsWith('/UNSPECIFIED'))
    .map((r) => r.id.slice('BREAKDOWN/'.length));
  return (
    <section aria-labelledby="console-title" className="flex flex-col gap-4">
      <h1 id="console-title" ref={heading} tabIndex={-1} className="text-2xl font-bold">
        Simulation console
      </h1>
      {!allowed ? (
        <p role="alert" data-testid="console-forbidden">
          Only an admin drives the simulation (permission{' '}
          <span className="font-mono">sim:control</span>).
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-700">
            The physical world under test: these levers change the simulated plant, not the MES. The
            MES sees their effects only through the machines, as it would on a real shop floor.
          </p>
          {status.isError ? (
            <QueryError what="the run" error={status.error} onRetry={() => void status.refetch()} />
          ) : null}
          <RunPanel status={status.data} />
          <ScenarioPanel status={status.data} />
          <div className="grid gap-4 lg:grid-cols-2">
            <FailurePanel machines={machines} codes={codes} />
            <DriftPanel testers={machines.filter((m) => m.id.startsWith('lkt-'))} />
            <InfrastructurePanel
              opcua={machines.filter((m) => m.interface === 'opcua')}
              modbus={machines.filter((m) => m.interface === 'modbus')}
            />
            <ToolPanel cncs={machines.filter((m) => m.operation === 'OP10')} />
          </div>
          <LotsPanel />
          <OperatorsPanel />
          <ActionsPanel />
          <EventsPanel enabled={!denied} />
        </>
      )}
    </section>
  );
}
