import type {
  HandoverAuditEntryDto,
  HandoverNoteDto,
  ShiftReportDto,
} from '@shopfloor/contracts/mes-api';
import { EQUIPMENT, PLANT, json, problem } from './fixtures.ts';
import {
  CURRENT_SHIFT,
  PREVIOUS_SHIFT,
  REASONS,
  SHIFT,
  SHIFT_END,
  SHIFT_START,
  requestBody,
  requestUrl,
} from './oee-fixtures.ts';
import { auditEntry, report } from './shift-fixtures.ts';

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** What the fake MES holds for shift A; tests change it between reads. */
export interface ShiftState {
  report: ShiftReportDto;
  notes: HandoverNoteDto[];
  history: Record<number, HandoverAuditEntryDto[]>;
  /** Answers a read of the report instead of the report (an error). */
  reportAnswer?: () => Response;
  notesAnswer?: () => Response;
}

export type Write = (method: string, path: string, body: unknown) => Response;

export function shiftState(overrides: Partial<ShiftState> = {}): ShiftState {
  return { report: report(), notes: [], history: {}, ...overrides };
}

/** The MES as the shift screens see it; `write` answers POST and PUT. */
export function shiftMes(state: ShiftState, write: Write = () => json({})) {
  const calls: Call[] = [];
  const withHistory = () =>
    state.notes.map((item) => ({
      note: item,
      history: state.history[item.id] ?? [auditEntry(item)],
    }));
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(requestUrl(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = requestBody(init);
    const path = url.pathname;
    calls.push({ method, path: path + url.search, body });
    if (method !== 'GET') return Promise.resolve(write(method, path, body));
    switch (path) {
      case '/api/v1/equipment':
        return Promise.resolve(json({ equipment: EQUIPMENT }));
      case '/api/v1/plant':
        return Promise.resolve(json(PLANT));
      case '/api/v1/reason-codes':
        return Promise.resolve(json(REASONS));
      case '/api/v1/shifts/current':
        return Promise.resolve(json(CURRENT_SHIFT));
      case '/api/v1/shifts':
        return Promise.resolve(
          json({ from: SHIFT_START, to: SHIFT_END, shifts: [PREVIOUS_SHIFT, SHIFT] }),
        );
      case '/api/v1/shifts/2026-10-15/A': {
        const { report: shown } = state;
        return Promise.resolve(
          json({
            key: shown.key,
            date: shown.date,
            shift: shown.shift,
            epoch: shown.epoch,
            start: shown.start,
            end: shown.end,
            breaks: shown.breaks,
            status: shown.status,
            final: shown.final,
            finalAt: shown.finalAt,
            revision: shown.revision,
          }),
        );
      }
      case '/api/v1/shifts/2026-10-15/A/report':
        return Promise.resolve(
          state.reportAnswer?.() ?? json({ ...state.report, notes: withHistory() }),
        );
      case '/api/v1/shifts/2026-10-15/A/notes':
        return Promise.resolve(
          state.notesAnswer?.() ??
            json({ shiftKey: state.report.key, epoch: state.report.epoch, notes: withHistory() }),
        );
      default: {
        const audit = /^\/api\/v1\/shifts\/2026-10-15\/A\/notes\/(\d+)\/audit$/.exec(path);
        if (audit) {
          const id = Number(audit[1]);
          const found = state.notes.find((item) => item.id === id);
          if (!found)
            return Promise.resolve(problem(404, 'Not Found', `no note ${String(id)}`, path));
          return Promise.resolve(
            json({ note: id, entries: state.history[id] ?? [auditEntry(found)] }),
          );
        }
        return Promise.resolve(problem(404, 'Not Found', 'unknown', path));
      }
    }
  };
  return { calls, fetch };
}

/** An in-memory Storage: Node's own `localStorage` global (without a file) shadows jsdom's. */
export function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
