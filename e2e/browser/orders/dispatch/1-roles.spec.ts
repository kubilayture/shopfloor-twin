import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Browser } from '@playwright/test';
import { account, logIn, type Account } from '../../login.ts';
import { MesClient, mesWrite } from '../../../src/clients.ts';

/**
 * Phase 7 exit criterion 1, its Playwright part (#178), on the live stack of the orders pass
 * before anything is released: an operator sees the order read-only, without a release or dispatch
 * control, and the API answers 403 `urn:shopfloor:forbidden`; an admin manages users on
 * `/admin/users` (creates one, disables it) and gets 403 on a production write; quality and
 * maintenance get 403 on the order writes too. The supervisor's release and dispatch follow in
 * 2-release-dispatch.spec.ts. None of these refusals changes the order (its version is asserted).
 */
const mesUrl = process.env.RECONCILE_MES_URL ?? '';
const results = process.env.RECONCILE_RESULTS;
/** An order the ERP holds and the MES imported (orders-01's first). */
const orderId = process.env.RECONCILE_ROLE_ORDER ?? 'PO-2610-001';
const FORBIDDEN = 'urn:shopfloor:forbidden';
const ORDER_ACTIONS = ['release', 'dispatch', 'cancel', 'redispatch', 'close'] as const;

/** A fresh browser context (its own cookies) logged in as `user`. */
async function session(browser: Browser, user: Account) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cookie = await logIn(page, user);
  return { context, page, cookie };
}

/** POSTs an order write with the order's current version; resolves with status and problem type. */
async function orderWrite(cookie: string, action: string, version: number) {
  const answer = await mesWrite(
    mesUrl,
    'POST',
    `/api/v1/orders/${encodeURIComponent(orderId)}/${action}`,
    { version },
    cookie,
  );
  const type = (JSON.parse(answer.text || '{}') as { type?: string }).type ?? null;
  return { action, status: answer.status, type };
}

test('roles: an operator sees no release or dispatch and is refused; an admin manages users and is refused production writes', async ({
  browser,
}) => {
  test.skip(mesUrl === '', 'runs inside pnpm test:reconcile, which starts the stack');
  test.setTimeout(120_000);
  const refusals: { user: string; action: string; status: number; type: string | null }[] = [];

  // The operator: the detail read-only, no order action, every order write 403.
  const operator = await session(browser, account('operator'));
  const mes = new MesClient(mesUrl, operator.cookie);
  const before = (await mes.order(orderId)).order;
  expect(before.status).toBe('imported');
  await operator.page.goto(`/orders/${orderId}`);
  await expect(operator.page.getByTestId('order-status')).toHaveAttribute(
    'data-status',
    'imported',
  );
  await expect(operator.page.getByTestId('order-read-only')).toBeVisible();
  for (const action of ORDER_ACTIONS) {
    await expect(operator.page.getByTestId(`action-${action}`)).toHaveCount(0);
  }
  for (const action of ['release', 'dispatch', 'close']) {
    const answer = await orderWrite(operator.cookie, action, before.version);
    refusals.push({ user: 'operator', ...answer });
    expect(answer).toEqual({ action, status: 403, type: FORBIDDEN });
  }
  await operator.context.close();

  // The admin: manages users (creates one with a role, disables it), refused production writes.
  const admin = await session(browser, account('admin'));
  await admin.page.goto('/admin/users');
  await expect(admin.page.getByTestId('user-list')).toBeVisible();
  const made = `made-by-admin-${String(Date.now() % 100_000)}`;
  await admin.page.getByTestId('new-username').fill(made);
  await admin.page.getByTestId('new-role-quality').check();
  await admin.page.getByTestId('create-user').click();
  await expect(admin.page.getByTestId('temporary-password')).toBeVisible();
  await expect(admin.page.getByTestId(`user-${made}`)).toBeVisible();
  await expect(admin.page.getByTestId(`user-roles-${made}`)).toContainText(/quality/i);
  await admin.page.getByTestId(`toggle-enabled-${made}`).click();
  // Disabling asks first (UX-10, #334; design system 4.9).
  await admin.page
    .getByTestId('confirm-disable')
    .getByRole('button', { name: 'Disable user', exact: true })
    .click();
  await expect(admin.page.getByTestId(`toggle-enabled-${made}`)).toHaveText('Enable');
  // The admin has no order permission: no action is offered, and the API refuses.
  await admin.page.goto(`/orders/${orderId}`);
  await expect(admin.page.getByTestId('order-read-only')).toBeVisible();
  for (const action of ['release', 'dispatch']) {
    const answer = await orderWrite(admin.cookie, action, before.version);
    refusals.push({ user: 'admin', ...answer });
    expect(answer).toEqual({ action, status: 403, type: FORBIDDEN });
  }
  await admin.context.close();

  // Quality and maintenance: no order permission either (API only).
  for (const name of ['quality', 'maintenance']) {
    const other = await session(browser, account(name));
    for (const action of ['release', 'dispatch']) {
      const answer = await orderWrite(other.cookie, action, before.version);
      refusals.push({ user: name, ...answer });
      expect(answer).toEqual({ action, status: 403, type: FORBIDDEN });
    }
    await other.context.close();
  }

  // Nothing changed the order.
  const supervisor = await session(browser, {
    username: process.env.RECONCILE_USERNAME ?? '',
    password: process.env.RECONCILE_PASSWORD ?? '',
  });
  const after = (await new MesClient(mesUrl, supervisor.cookie).order(orderId)).order;
  expect([after.status, after.version]).toEqual(['imported', before.version]);
  // The supervisor is offered release (dispatch only once released).
  await supervisor.page.goto(`/orders/${orderId}`);
  await expect(supervisor.page.getByTestId('action-release')).toBeVisible();
  await expect(supervisor.page.getByTestId('order-read-only')).toHaveCount(0);
  await supervisor.context.close();

  const summary = { orderId, createdByAdmin: made, refusals };
  console.log(`roles: ${JSON.stringify(summary)}`);
  if (results) await writeFile(join(results, 'roles.json'), JSON.stringify(summary, null, 2));
});
