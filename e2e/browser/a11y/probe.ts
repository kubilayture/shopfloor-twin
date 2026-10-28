import { AxeBuilder } from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import {
  followsSkip,
  fromAxe,
  keyboardCapError,
  skipTableOf,
  TAB_PRESS_CAP,
  tableRuns,
  type SkipFacts,
  TABLE_RUN_LIMIT,
  type FocusStop,
  type ImpactCounts,
  type OverlayCheck,
  type Violation,
} from '../../src/a11y-report.ts';

/**
 * What the harness measures on a page (UX-1g, #321). Everything here reads: it loads pages,
 * presses Tab and Escape, opens and closes overlays and clicks only on non-interactive points.
 * Nothing it finds throws; findings go into the report.
 */

/** axe's WCAG 2.0, 2.1 and 2.2 A and AA rules (design system section 7). */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

/** One axe run is given this long; a page past it is reported as failed, not waited for. */
const AXE_TIMEOUT_MS = 45_000;

/** The viewport height for a width: a phone's below 768, a laptop's otherwise. */
export const heightFor = (width: number) => (width < 768 ? 844 : 900);

/** Two frames and a short pause: layout, a chart's resize observer and transitions settle. */
export async function frames(page: Page, ms = 250): Promise<void> {
  await page.evaluate(
    (pause) =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, pause))),
      ),
    ms,
  );
}

/**
 * Waits until the page shows a heading and no "Loading…" text is left (the screens' loading
 * texts all end in an ellipsis); resolves false when it had not settled after `timeoutMs`.
 */
export async function settle(page: Page, timeoutMs = 15_000): Promise<boolean> {
  const ok = await page
    .waitForFunction(
      () => {
        const root = document.querySelector('main') ?? document.body;
        return document.querySelector('h1') !== null && !/Loading[^\n]*…/.test(root.innerText);
      },
      undefined,
      { timeout: timeoutMs },
    )
    .then(
      () => true,
      () => false,
    );
  await frames(page);
  return ok;
}

export interface PageMeasure {
  readonly title: string;
  readonly overflowX: boolean;
  readonly counts: ImpactCounts;
  readonly violations: readonly Violation[];
  readonly axeVersion: string;
}

/** axe on the page as it is, the title, and whether the page scrolls sideways. */
export async function measure(page: Page): Promise<PageMeasure> {
  const axe = new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    axe,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`axe took longer than ${String(AXE_TIMEOUT_MS)} ms`));
      }, AXE_TIMEOUT_MS);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
  const { title, overflowX } = await page.evaluate(() => ({
    title: document.title,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  }));
  return { title, overflowX, ...fromAxe(result), axeVersion: result.testEngine.version };
}

/** A screenshot from the top: the whole page up to 6000 px tall (a long table is cut there). */
export async function screenshot(page: Page, path: string, width: number): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.screenshot({
    path,
    type: 'jpeg',
    quality: 70,
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
    ...(height > 6000 ? { clip: { x: 0, y: 0, width, height: 6000 } } : {}),
  });
}

/**
 * Activates the focused skip link the way the keyboard would: DataTable's (`data-skip-link`) by
 * its own handler, which focuses the target; any other by focusing its target, so the browser's
 * hash navigation (and the router) is left alone.
 */
function followSkipLink(): void {
  const link = document.activeElement;
  if (!(link instanceof HTMLAnchorElement)) return;
  const target = document.getElementById(
    decodeURIComponent((link.getAttribute('href') ?? '').slice(1)),
  );
  if (link.hasAttribute('data-skip-link')) link.click();
  if (target instanceof HTMLElement && document.activeElement !== target) target.focus();
}

/** The focused element as the report shows it, with the facts of a skip link; `null` on the body. */
function focusedNow():
  | (Omit<FocusStop, 'skipsTable'> & { onScreen: boolean; covered: boolean; skip: SkipFacts })
  | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return null;
  const cs = getComputedStyle(el);
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  const ring = cs.boxShadow !== 'none' && el.matches(':focus-visible');
  // A ring drawn by a pseudo-element around a larger hit area (the terminal picker's whole-tile
  // link, UX-7): its `::after` (or `::before`) outline counts.
  const pseudo = ['::after', '::before'].some((p) => {
    const ps = getComputedStyle(el, p);
    return ps.content !== 'none' && ps.outlineStyle !== 'none' && parseFloat(ps.outlineWidth) > 0;
  });
  const r = el.getBoundingClientRect();
  const onScreen =
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > 0 &&
    r.right > 0 &&
    r.top < window.innerHeight &&
    r.left < window.innerWidth;
  // 2.4.11: a sticky header or panel must not cover the focused element.
  const x = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
  const y = Math.min(Math.max(r.top + Math.min(r.height / 2, 8), 0), window.innerHeight - 1);
  const top = onScreen ? document.elementFromPoint(x, y) : null;
  const covered = top !== null && top !== el && !el.contains(top) && !top.contains(el);
  // A table's own focusable scroll frame (DataTable's named region, when the table is wider than
  // the screen) is a stop of that table: it is the first of its Tab run, right after a skip link.
  const table =
    el.closest('table') ??
    (el.getAttribute('role') === 'region' && el.querySelectorAll('table').length === 1
      ? el.querySelector('table')
      : null);
  const tables = [...document.querySelectorAll('table')];
  // A skip link ("Skip past the units", G-33): the first table between it and its target.
  const href = el instanceof HTMLAnchorElement ? (el.getAttribute('href') ?? '') : '';
  const target = href.startsWith('#')
    ? document.getElementById(decodeURIComponent(href.slice(1)))
    : null;
  const table_ =
    target === null
      ? -1
      : tables.findIndex(
          (t) =>
            (el.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
            (t.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
            !t.contains(target),
        );
  // The Tab stops a skip link passes over: tabbable, rendered, between it and its target.
  const targetAfter =
    target !== null &&
    (el.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const between = targetAfter
    ? [
        ...document.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, summary, [tabindex]',
        ),
      ].filter(
        (c) =>
          (el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
          (c.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
          c.tabIndex >= 0 &&
          !(c as HTMLButtonElement).disabled &&
          c.closest('[inert]') === null &&
          c.getClientRects().length > 0,
      ).length
    : 0;
  const label =
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
      ? (el.labels?.[0]?.innerText ?? el.getAttribute('placeholder') ?? el.name)
      : el.innerText;
  const name = (el.getAttribute('aria-label') ?? label).trim().replace(/\s+/g, ' ').slice(0, 40);
  const region = el.closest('nav')
    ? 'nav'
    : el.closest('header')
      ? 'header'
      : el.closest('main')
        ? 'main'
        : 'other';
  return {
    element: `${el.getAttribute('role') ?? el.tagName.toLowerCase()} "${name}"`,
    region,
    visible: outline || ring || pseudo,
    inTable: table ? tables.indexOf(table) : null,
    // Whether the link can take the focus anywhere: its target rendered (a box, not inert) and
    // focusable, or a skip link that moves the focus to it (`data-skip-link`, DataTable).
    skip: {
      table: table_,
      targetRendered:
        target !== null &&
        target.getClientRects().length > 0 &&
        getComputedStyle(target).visibility !== 'hidden' &&
        target.closest('[inert]') === null,
      targetFocusable:
        target !== null &&
        (target.hasAttribute('tabindex') ||
          (target instanceof HTMLElement && target.tabIndex >= 0) ||
          el.hasAttribute('data-skip-link')),
      marked: el.hasAttribute('data-skip-link'),
      targetAfter,
      between,
    },
    onScreen,
    covered,
  };
}

/**
 * Tab-order and focus-visibility sampling (as the UX-0 keyboard pass did): from the top of the
 * page, up to `presses` Tab presses; each stop's element, region, whether a focus indicator shows,
 * whether it is on screen and not covered, and the longest run inside one table (G-33).
 */
export async function sampleKeyboard(
  page: Page,
  presses = TAB_PRESS_CAP,
): Promise<{
  stops: FocusStop[];
  longestTableRun: number;
  skippedByLinkRun: number;
  hidden: string[];
  offScreen: string[];
  covered: string[];
  findings: string[];
  error?: string;
}> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const stops: FocusStop[] = [];
  const findings: string[] = [];
  const hidden: string[] = [];
  const offScreen: string[] = [];
  const covered: string[] = [];
  let bodies = 0;
  /** The most stops one followed skip link passed over. */
  let followed = 0;
  // The whole page (UX-F1 review): until the focus wraps round or leaves the page twice, so no
  // table's run is cut short; a page still going at `presses` is a sample not taken.
  let ended = false;
  let pressed = 0;
  for (; pressed < presses && !ended; pressed += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(focusedNow);
    if (stop === null) {
      bodies += 1;
      ended = bodies > 1;
      continue;
    }
    // Wrapped round to the first stop: the page's whole order was seen.
    if (stops.length > 0 && stop.element === stops[0]?.element && stop.region === stops[0].region) {
      ended = true;
      continue;
    }
    const { onScreen, covered: isCovered, skip, ...rest } = stop;
    const kept: FocusStop = { ...rest, skipsTable: skipTableOf(skip) };
    stops.push(kept);
    if (!kept.visible) hidden.push(kept.element);
    if (!onScreen) offScreen.push(kept.element);
    else if (isCovered) covered.push(kept.element);
    // A skip link: follow it, as a keyboard user would, and go on from its target (UX-F1).
    if (followsSkip(skip)) {
      followed = Math.max(followed, skip.between ?? 0);
      await page.evaluate(followSkipLink);
    }
  }
  if (hidden.length > 0)
    findings.push(
      `no visible focus indicator on ${String(hidden.length)}: ${hidden.slice(0, 5).join(', ')}`,
    );
  if (offScreen.length > 0)
    findings.push(
      `focus off screen or on a zero-size element: ${offScreen.slice(0, 5).join(', ')}`,
    );
  if (covered.length > 0)
    findings.push(`focused element covered by another (2.4.11): ${covered.slice(0, 5).join(', ')}`);
  // A run right after a skip link past its table is reported apart, not as a finding (G-33).
  const runs = tableRuns(stops);
  if (runs.longest >= TABLE_RUN_LIMIT)
    findings.push(`${String(runs.longest)} stops inside one table before leaving it (G-33)`);
  const error = keyboardCapError(pressed, presses, ended);
  return {
    ...(error === undefined ? {} : { error }),
    stops,
    longestTableRun: runs.longest,
    skippedByLinkRun: Math.max(runs.skippedByLink, followed),
    hidden,
    offScreen,
    covered,
    findings,
  };
}

/** The visible overlay opened last, marked `data-a11y-overlay`; its kind and whether modal. */
async function findOverlay(page: Page): Promise<{ kind: string; modal: boolean } | null> {
  return page.evaluate(() => {
    document.querySelector('[data-a11y-overlay]')?.removeAttribute('data-a11y-overlay');
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none')
        return false;
      if (el.closest('[inert]')) return false;
      if (el instanceof HTMLDialogElement && !el.open) return false;
      if (el.hasAttribute('popover') && !el.matches(':popover-open')) return false;
      return true;
    };
    const candidates = [
      ...document.querySelectorAll(
        'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [popover]',
      ),
    ].filter(shown);
    const el = candidates.at(-1);
    if (!el) return null;
    el.setAttribute('data-a11y-overlay', '');
    const modal = el.matches(':modal') || el.getAttribute('aria-modal') === 'true';
    const role = el.getAttribute('role') ?? (el.tagName === 'DIALOG' ? 'dialog' : 'popover');
    return { kind: modal ? `modal ${role}` : role, modal };
  });
}

const overlayOpen = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-a11y-overlay]');
    if (!el?.isConnected) return false;
    if (el instanceof HTMLDialogElement && !el.open) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  });

const focusIn = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const container = document.querySelector(s);
    return container?.contains(document.activeElement) === true;
  }, selector);

/**
 * A point to click "outside" the overlay that hits nothing interactive (so the click can only
 * dismiss): a free spot of the page, or a modal's backdrop. `null` when there is none.
 */
async function outsidePoint(page: Page, overlay: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const w = window.innerWidth;
    const h = window.innerHeight;
    const points = [
      [w - 12, h - 12],
      [12, h - 12],
      [w - 12, Math.round(h / 2)],
      [12, Math.round(h / 2)],
      [Math.round(w / 2), h - 12],
    ];
    const interactive =
      'a, button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [tabindex]:not([tabindex="-1"]), [contenteditable]';
    for (const [x = 0, y = 0] of points) {
      const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      if (inside) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit) continue;
      // A modal's backdrop hits the dialog element itself, outside its box.
      if (hit === el) return { x, y };
      if (el.contains(hit) || hit.closest(interactive)) continue;
      return { x, y };
    }
    return null;
  }, overlay);
}

/**
 * Tab `presses` times; whether no stop landed on the page outside `container`. A stop on the body
 * is the focus leaving for the browser's own controls past the last element, as a modal dialog
 * allows too, not an escape into the page behind.
 */
async function tabsStayIn(page: Page, container: string, presses: number): Promise<boolean> {
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.press('Tab');
    const escaped = await page.evaluate((s) => {
      const active = document.activeElement;
      if (active === null || active === document.body) return false;
      return document.querySelector(s)?.contains(active) !== true;
    }, container);
    if (escaped) return false;
  }
  return true;
}

const describe = async (trigger: Locator) => {
  const name =
    (await trigger.getAttribute('aria-label')) ?? (await trigger.innerText().catch(() => ''));
  return name.trim().replace(/\s+/g, ' ').slice(0, 40) || '(no name)';
};

const finding = (checks: Record<string, boolean | null>) =>
  Object.entries(checks)
    .filter(([, v]) => v === false)
    .map(([k]) => `${k}: no`);

/**
 * The overlays a page's own controls open (dialogs, sheets, menus, listboxes, popovers): up to
 * `max` triggers in `main` (`aria-haspopup`, or `aria-expanded="false"` with `aria-controls`),
 * each opened and checked for focus moving in, containment and `inert` behind (modal), Escape
 * closing and the focus going back to the trigger, and an outside click closing it. Generic on
 * purpose: it finds UX-1e's components when they land, and needs none of them.
 */
export async function checkOverlays(
  page: Page,
  route: string,
  width: number,
  max = 3,
): Promise<OverlayCheck[]> {
  const selector =
    'main [aria-haspopup]:not([aria-haspopup="false"]):not([disabled]), main [aria-expanded="false"][aria-controls]:not([disabled])';
  const triggers = page.locator(selector);
  const count = Math.min(await triggers.count(), max);
  const results: OverlayCheck[] = [];
  for (let i = 0; i < count; i += 1) {
    const trigger = triggers.nth(i);
    if (!(await trigger.isVisible())) continue;
    const name = await describe(trigger);
    await trigger.evaluate((el) => {
      el.setAttribute('data-a11y-trigger', '');
    });
    try {
      await trigger.click({ timeout: 3_000 });
      await frames(page, 300);
      const overlay = await findOverlay(page);
      if (!overlay) {
        // A disclosure that opens inline content: nothing to contain or dismiss.
        await trigger.click({ timeout: 3_000 }).catch(() => undefined);
        continue;
      }
      const sel = '[data-a11y-overlay]';
      const checks: Record<string, boolean | null> = {
        focusMovesIn: await focusIn(page, sel),
        inertBehind: overlay.modal
          ? await page.evaluate(
              () =>
                document.querySelector('[data-a11y-overlay]')?.matches(':modal') === true ||
                document.querySelector('main')?.closest('[inert]') !== null,
            )
          : null,
        focusContained: overlay.modal ? await tabsStayIn(page, sel, 12) : null,
        escapeCloses: null,
        focusReturns: null,
        outsideClickCloses: null,
      };
      await page.keyboard.press('Escape');
      await frames(page, 200);
      checks.escapeCloses = !(await overlayOpen(page));
      checks.focusReturns = checks.escapeCloses
        ? await page.evaluate(
            () => document.activeElement?.hasAttribute('data-a11y-trigger') === true,
          )
        : null;
      if (checks.escapeCloses) {
        await trigger.click({ timeout: 3_000 });
        await frames(page, 300);
        if (await findOverlay(page)) {
          const point = await outsidePoint(page, sel);
          if (point) {
            await page.mouse.click(point.x, point.y);
            await frames(page, 200);
            checks.outsideClickCloses = !(await overlayOpen(page));
          }
          if (await overlayOpen(page)) await page.keyboard.press('Escape');
        }
      }
      results.push({
        route,
        width,
        kind: overlay.kind,
        trigger: name,
        checks,
        findings: finding(checks),
      });
    } catch (error) {
      results.push({
        route,
        width,
        kind: 'unknown',
        trigger: name,
        checks: {},
        findings: [
          `could not be checked: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`,
        ],
      });
    } finally {
      await page
        .evaluate(() => {
          document.querySelector('[data-a11y-trigger]')?.removeAttribute('data-a11y-trigger');
        })
        .catch(() => undefined);
    }
  }
  return results;
}

/** The shell's menu button (UX-1b): the nav drawer below 1280 px. */
export const menuButton = (page: Page) => page.getByRole('button', { name: 'Menu', exact: true });

/**
 * The nav drawer (UX-1b; ux-plan: "containment checked in a real browser by UX-1g"): opened from
 * the menu button, the focus moves in, the top bar and `main` are inert, Tab stays in the nav,
 * the page behind is scroll-locked, Escape closes it and the focus returns to the menu button, a
 * click on the backdrop closes it.
 */
export async function checkDrawer(page: Page, route: string, width: number): Promise<OverlayCheck> {
  const button = menuButton(page);
  const checks: Record<string, boolean | null> = {
    opens: null,
    focusMovesIn: null,
    inertBehind: null,
    focusContained: null,
    scrollLocked: null,
    escapeCloses: null,
    focusReturns: null,
    outsideClickCloses: null,
  };
  if (!(await button.isVisible())) {
    return {
      route,
      width,
      kind: 'nav drawer',
      trigger: 'Menu',
      checks,
      findings: ['no menu button at this width'],
    };
  }
  const navId = (await button.getAttribute('aria-controls')) ?? '';
  const nav = `[id="${navId}"]`;
  const isOpen = () =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el || el.hasAttribute('inert')) return false;
      const r = el.getBoundingClientRect();
      return r.right > 0 && r.width > 0;
    }, nav);
  await button.click({ timeout: 3_000 });
  await frames(page, 400);
  checks.opens = await isOpen();
  if (checks.opens) {
    checks.focusMovesIn = await focusIn(page, nav);
    checks.inertBehind = await page.evaluate(
      () =>
        document.querySelector('main')?.closest('[inert]') !== null &&
        document.querySelector('header')?.closest('[inert]') !== null,
    );
    checks.scrollLocked = await page.evaluate(
      () =>
        getComputedStyle(document.documentElement).overflowY === 'hidden' ||
        getComputedStyle(document.body).overflowY === 'hidden' ||
        getComputedStyle(document.body).position === 'fixed',
    );
    checks.focusContained = await tabsStayIn(page, nav, 30);
    await page.keyboard.press('Escape');
    await frames(page, 400);
    checks.escapeCloses = !(await isOpen());
    checks.focusReturns = await button.evaluate((el) => el === document.activeElement);
    await button.click({ timeout: 3_000 });
    await frames(page, 400);
    if (await isOpen()) {
      const box = await page.evaluate(
        (s) => document.querySelector(s)?.getBoundingClientRect().right ?? 0,
        nav,
      );
      const x = Math.round((box + width) / 2);
      if (x > box + 4) {
        await page.mouse.click(x, Math.round(heightFor(width) / 2));
        await frames(page, 400);
        checks.outsideClickCloses = !(await isOpen());
      }
      if (await isOpen()) await page.keyboard.press('Escape');
    }
  }
  return { route, width, kind: 'nav drawer', trigger: 'Menu', checks, findings: finding(checks) };
}

/**
 * How the open drawer locks the page behind it, for the iOS rule of thumb (#321's comment from the
 * #351 review): `overflow: hidden` on the root alone does not stop touch scrolling in iOS Safari;
 * `touch-action: none` on the backdrop, or a `position: fixed` body, does.
 */
export async function scrollLockStyles(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const html = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const nav = document.querySelector('nav[data-open="true"]');
    const backdrop = document.querySelector('[data-testid="nav-backdrop"]');
    return {
      htmlOverflowY: html.overflowY,
      bodyOverflowY: body.overflowY,
      bodyPosition: body.position,
      navOverscrollBehaviorY: nav ? getComputedStyle(nav).overscrollBehaviorY : 'no open nav',
      backdropTouchAction: backdrop ? getComputedStyle(backdrop).touchAction : 'no backdrop',
    };
  });
}
