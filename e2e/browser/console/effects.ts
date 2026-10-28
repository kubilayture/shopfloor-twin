import { setTimeout as sleep } from 'node:timers/promises';
import { expect, type Page } from '@playwright/test';

/**
 * Helpers of the console effect checks (#270, P9-F3, Phase 9 plan exit criterion 4): each action
 * is taken through `/console` as admin, and its effect read where the plant shows it, the MES (the
 * plant event stream's end: OPC UA, the gateway, MQTT/UNS, ingest), through nginx with admin's
 * session, and the simulator's own reads with the control token (the test's, never the browser's).
 */
const simUrl = process.env.CONSOLE_SIM_URL ?? '';
const simToken = process.env.CONSOLE_SIM_TOKEN ?? '';

export const insideConsoleRun = (): boolean =>
  (process.env.RECONCILE_WEB_URL ?? '') !== '' && simUrl !== '' && simToken !== '';

/** A read of the control API with its token: what the simulator holds now. */
export async function sim<T>(path: string): Promise<T> {
  const response = await fetch(`${simUrl}/api/v1${path}`, {
    headers: { authorization: `Bearer ${simToken}` },
  });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

export interface SimStatus {
  state: string;
  speed: number;
  simTime: string;
  events: number;
}

/** A read of the MES as the logged-in page's user (through nginx's `/api/`). */
export async function mes<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.status(), path).toBe(200);
  return (await response.json()) as T;
}

export interface DowntimeRecord {
  equipment: string;
  epoch: number;
  start: string;
  end: string | null;
  intervalStart: string;
  state: string;
  cause: string | null;
}

export interface AlarmOccurrence {
  equipment: string;
  epoch: number;
  code: string;
  raisedAt: string;
  active: boolean;
}

/** The MES's downtime records overlapping [from, to) (plant time). */
export const downtime = async (page: Page, from: number, to: number) =>
  (
    await mes<{ records: DowntimeRecord[] }>(
      page,
      `/api/v1/downtime?${new URLSearchParams({
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      }).toString()}`,
    )
  ).records;

/**
 * Every alarm occurrence the MES holds raised in [from, to) (plant time), whatever its state: the
 * four operator views together (an unacknowledged cleared alarm is in `active`; `history` holds
 * only closed ones).
 */
export async function alarmsRaised(page: Page, from: number, to: number) {
  const views = ['active', 'acknowledged', 'shelved', 'history'] as const;
  const lists = await Promise.all(
    views.map(
      async (view) =>
        (
          await mes<{ alarms: AlarmOccurrence[] }>(
            page,
            `/api/v1/alarms?${new URLSearchParams({
              view,
              limit: '500',
              from: new Date(from).toISOString(),
              to: new Date(to).toISOString(),
            }).toString()}`,
          )
        ).alarms,
    ),
  );
  return lists.flat();
}

/**
 * Polls `attempt` every 500 ms until it finds what it looks for, at most `timeoutMs` of wall
 * time; then fails naming what was expected, what was last seen and the simulator's status.
 */
export async function eventually<T>(
  what: string,
  timeoutMs: number,
  attempt: () => Promise<{ found: T } | { seen: string }>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let seen: string;
  for (;;) {
    try {
      const result = await attempt();
      if ('found' in result) return result.found;
      seen = result.seen;
    } catch (error) {
      seen = `read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (Date.now() > deadline) {
      const status = await sim<SimStatus>('/status').then(
        (s) => JSON.stringify(s),
        (error: unknown) => `status unreadable: ${String(error)}`,
      );
      throw new Error(
        `${what}: not seen within ${String(timeoutMs)} ms of wall time.\n` +
          `Last seen: ${seen}\nSimulator: ${status}`,
      );
    }
    await sleep(500);
  }
}

/** A console outcome line that reports success. */
export async function outcome(page: Page, testId: string, pattern: RegExp): Promise<void> {
  const line = page.getByTestId(testId);
  await expect(line).toHaveText(pattern);
  await expect(line).toHaveAttribute('data-kind', 'done');
}

/**
 * Gives the confirmation a lever that cannot be taken back asks for (UX-10, #334; design system
 * 4.9): the button that repeats the verb in the dialog `testId`.
 */
export async function confirm(page: Page, testId: string, label: string): Promise<void> {
  const dialog = page.getByTestId(testId);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Gives a confirmation the simulator refuses: the dialog stays open with the refusal inside it
 * (UX-10 review), and Cancel closes it.
 */
export async function confirmRefused(page: Page, testId: string, label: string): Promise<void> {
  const dialog = page.getByTestId(testId);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await expect(dialog.getByTestId(`${testId}-refusal`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Sets the speed through the console's speed control. */
export async function setSpeed(page: Page, speed: number): Promise<void> {
  await page.getByTestId('sim-speed-input').fill(String(speed));
  await page.getByTestId('sim-speed-apply').click();
  await outcome(page, 'run-outcome', new RegExp(`Speed ${String(speed)}×`));
}

/** Resumes (or starts) the run through the console. */
export async function resume(page: Page): Promise<void> {
  await page.getByTestId('sim-resume').click();
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'running');
}

/** Pauses the run through the console. */
export async function pause(page: Page): Promise<void> {
  await page.getByTestId('sim-pause').click();
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'paused');
}

/** A compact list of downtime records for a diagnostic. */
export const describeRecords = (records: readonly DowntimeRecord[]): string =>
  records.length === 0
    ? 'no record'
    : records
        .map(
          (r) =>
            `${r.equipment}#${String(r.epoch)} ${r.state}/${r.cause ?? '-'} from ${r.intervalStart}`,
        )
        .join('; ');
