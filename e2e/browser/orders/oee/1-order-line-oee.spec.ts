import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { logIn } from '../../login.ts';

/**
 * Phase 9 exit criterion 2, on screen (#233): after the drain, with the simulator paused, the
 * reconciliation has judged every order completed in shift A and shift A's line OEE final and
 * equal to the live truth through the API. Here the supervisor opens each order's detail and the
 * OEE dashboard for shift A, waits until the page calls the values final, and reads them from the
 * page: the four-decimal text and the exact fraction (`data-fraction`) of the order's OEE, A, P,
 * Q, first-pass yield and line OEE, and of shift A's line OEE with the bottleneck per product.
 * It writes them to `oee-screen.json`; the reconciliation compares them with the live truth, so a
 * page that shows anything but the truth's values fails the pass (a missing file too).
 */
const results = process.env.RECONCILE_RESULTS;
const orders = (process.env.RECONCILE_OEE_ORDERS ?? '').split(',').filter((id) => id !== '');
const shiftKey = process.env.RECONCILE_SHIFT ?? '2026-10-12/A';
/** Finality reached through the API already: the page only has to read it and render. */
const FINAL_MS = 30_000;

interface ScreenRatio {
  readonly decimal: string;
  readonly fraction: string;
}

async function ratio(locator: Locator): Promise<ScreenRatio> {
  return {
    decimal: ((await locator.textContent()) ?? '').trim(),
    fraction: (await locator.getAttribute('data-fraction')) ?? '',
  };
}

async function readOrder(page: Page, id: string) {
  await page.goto(`/orders/${encodeURIComponent(id)}`);
  const section = page.getByTestId('order-oee');
  await expect(section).toHaveAttribute('data-final', 'true', { timeout: FINAL_MS });
  await expect(section.getByTestId('order-fpy')).toHaveAttribute('data-final', 'true');
  await expect(section.getByTestId('order-line-oee')).toHaveAttribute('data-final', 'true');
  await section.scrollIntoViewIfNeeded();
  if (results) {
    await section.screenshot({ path: join(results, `oee-order-${id}.png`) });
  }
  return {
    final: await section.getAttribute('data-final'),
    incidents: await section.getAttribute('data-incidents'),
    revision: await section.getAttribute('data-revision'),
    oee: await ratio(section.getByTestId('order-oee-oee')),
    availability: await ratio(section.getByTestId('order-oee-availability')),
    performance: await ratio(section.getByTestId('order-oee-performance')),
    quality: await ratio(section.getByTestId('order-oee-quality')),
    firstPassYield: {
      final: await section.getByTestId('order-fpy').getAttribute('data-final'),
      yield: await ratio(section.getByTestId('order-fpy-yield')),
      firstPassGood: Number(await section.getByTestId('order-fpy-good').textContent()),
      started: Number(await section.getByTestId('order-fpy-started').textContent()),
    },
    line: {
      final: await section.getByTestId('order-line-oee').getAttribute('data-final'),
      oee: await ratio(section.getByTestId('order-line-oee-value')),
    },
    jobs: await section.locator('[data-testid^="order-oee-job-"]').evaluateAll((rows) =>
      rows.map((row) => ({
        id: (row.getAttribute('data-testid') ?? '').slice('order-oee-job-'.length),
        oee: row.getAttribute('data-oee'),
        final: row.getAttribute('data-final'),
      })),
    ),
  };
}

test('the order detail and the OEE dashboard show the final order and line OEE of shift A', async ({
  page,
}) => {
  test.skip(orders.length === 0, 'runs inside pnpm test:reconcile with RECONCILE_OEE_ORDERS');
  test.setTimeout(60_000 + orders.length * 30_000);
  await logIn(page);

  const shown: Record<string, Awaited<ReturnType<typeof readOrder>>> = {};
  for (const id of orders) shown[id] = await readOrder(page, id);

  await page.goto(`/oee?shift=${encodeURIComponent(shiftKey)}`);
  const card = page.getByTestId('line-oee-card');
  await expect(card).toHaveAttribute('data-key', shiftKey, { timeout: FINAL_MS });
  await expect(card).toHaveAttribute('data-final', 'true', { timeout: FINAL_MS });
  await expect(card.getByTestId('line-bottlenecks')).toBeVisible();
  if (results) await card.screenshot({ path: join(results, 'oee-line-card.png') });
  const line = {
    key: await card.getAttribute('data-key'),
    final: await card.getAttribute('data-final'),
    aboveOne: await card.getAttribute('data-above-one'),
    oee: await ratio(card.getByTestId('line-oee-value')),
    bottlenecks: await card.locator('[data-testid^="line-bottleneck-"]').evaluateAll((items) =>
      items.map((item) => ({
        product: (item.getAttribute('data-testid') ?? '').slice('line-bottleneck-'.length),
        operation: item.getAttribute('data-operation'),
        equipment: item.getAttribute('data-equipment'),
      })),
    ),
    workCenterBottleneck: await page.locator('[data-testid^="bottleneck-"]').evaluateAll((items) =>
      items.map((item) => ({
        id: item.getAttribute('data-testid'),
        equipment: item.getAttribute('data-equipment'),
      })),
    ),
  };

  if (results) {
    await writeFile(
      join(results, 'oee-screen.json'),
      `${JSON.stringify({ orders: shown, line }, null, 2)}\n`,
    );
  }
});
