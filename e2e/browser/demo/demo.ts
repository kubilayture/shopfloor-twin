import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, type Page } from '@playwright/test';
import { DEMO, plantClock } from '../../src/demo-plan.ts';
import { logIn, type Account } from '../login.ts';

/**
 * Helpers of the demo walkthrough (#281, browser/demo/walkthrough.spec.ts), run only inside
 * `pnpm demo` (src/demo.ts), which passes the web's address, the users and the control API's
 * address and token. The test reads the control API itself, with the token, only to know the
 * simulated time (when to open a scene) and for the simulator's own truth where a scene compares
 * with it; the browser never has the token.
 */
const simUrl = process.env.DEMO_SIM_URL ?? '';
const simToken = process.env.DEMO_SIM_TOKEN ?? '';
const results = process.env.RECONCILE_RESULTS;

export const insideDemoRun = (): boolean =>
  (process.env.RECONCILE_WEB_URL ?? '') !== '' && simUrl !== '' && simToken !== '';

/** A read of the control API with its token. */
export async function sim<T>(path: string): Promise<T> {
  const response = await fetch(`${simUrl}/api/v1${path}`, {
    headers: { authorization: `Bearer ${simToken}` },
  });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

export interface SimStatus {
  readonly state: 'idle' | 'running' | 'paused' | 'finished';
  readonly speed: number;
  readonly simTime: string;
}

export const simStatus = (): Promise<SimStatus> => sim<SimStatus>('/status');

/**
 * Waits until the simulation has reached `at` (plant time, ms), polling its status. The wall time
 * allowed is the simulated time left at the run's speed plus `slackMs`; a run that is paused
 * (other than by the walkthrough's own scene 3, which resumes it) fails the wait.
 */
export async function untilPlantTime(at: number, slackMs = 30_000): Promise<SimStatus> {
  const first = await simStatus();
  const deadline = Date.now() + Math.max(0, at - Date.parse(first.simTime)) / DEMO.speed + slackMs;
  for (;;) {
    const status = await simStatus();
    if (Date.parse(status.simTime) >= at) return status;
    if (Date.now() > deadline) {
      throw new Error(`the run did not reach ${plantClock(at)} in time: ${JSON.stringify(status)}`);
    }
    await sleep(250);
  }
}

/** A GET of the MES through nginx as the page's user (same origin, the page's session). */
export async function mes<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.status(), path).toBe(200);
  return (await response.json()) as T;
}

/** Logs the page's user out (if any) and `user` in, on the same page: one page for the demo. */
export async function switchTo(page: Page, user: Account): Promise<string> {
  const signedIn = page.getByTestId('signed-in-user');
  if ((await signedIn.count()) > 0) {
    await page.getByTestId('logout').click();
    await expect(signedIn).toHaveCount(0);
  }
  return logIn(page, user);
}

/** Polls `attempt` every 500 ms until it finds what it looks for, at most `timeoutMs` of wall time. */
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
      const status = await simStatus().then(
        (s) => JSON.stringify(s),
        (error: unknown) => `status unreadable: ${String(error)}`,
      );
      throw new Error(
        `${what}: not seen within ${String(timeoutMs)} ms.\nLast seen: ${seen}\nSimulator: ${status}`,
      );
    }
    await sleep(500);
  }
}

/** One scene's record in the scene log (`scenes.jsonl`): wall and plant times, what it showed. */
export interface SceneRecord {
  readonly n: number;
  readonly id: string;
  readonly title: string;
  readonly wallStart: string;
  readonly wallEnd: string;
  readonly plantStart: string;
  readonly plantEnd: string;
  readonly facts: Record<string, unknown>;
}

/** Appends a scene's record to the run's scene log (e2e/results/demo/scenes.jsonl). */
export async function recordScene(record: SceneRecord): Promise<void> {
  console.log(`scene ${String(record.n)} (${record.id}): ${JSON.stringify(record.facts)}`);
  if (results) await appendFile(join(results, 'scenes.jsonl'), `${JSON.stringify(record)}\n`);
}
