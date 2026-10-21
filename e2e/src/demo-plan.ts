/**
 * The demo's plan (#281, Phase 10 plan "Demo scenario (P10-06)", docs/demo.md): what the timeline
 * `demo-v1` and the ERP dataset `config/erp/demo-v1.yaml` give, and when the walkthrough opens each
 * scene. Shared by probe D1 (src/demo-probe.ts, which measures each scene's margin in every
 * acceptance-time variant), the walkthrough's harness (src/demo.ts) and its scenes
 * (browser/demo). Times are plant time, Istanbul (+03:00).
 */

/** A plant time of the demo's Monday, `HH:MM`, in epoch ms. */
export const plantTime = (hhmm: string): number => Date.parse(`2026-10-12T${hhmm}:00+03:00`);

/** `HH:MM:SS` plant time of an instant (Istanbul has no daylight saving time since 2016). */
export const plantClock = (ms: number): string =>
  new Date(ms + 3 * 3_600_000).toISOString().slice(11, 19);

export const DEMO = {
  timeline: 'demo-v1',
  probe: 'demo-v1-probe',
  seed: 20261012,
  start: '2026-10-12T06:00:00+03:00',
  shift: '2026-10-12/A',
  speed: 60,
  /** The orders' planned start, the dispatch's NotBefore (config/erp/demo-v1.yaml). */
  plannedStart: plantTime('06:15'),
  /**
   * The timeline's pause, one minute before the planned start: every order the walkthrough
   * dispatches is accepted by then (while the run is paused there at the latest), so its job starts
   * at the planned start whatever the walkthrough's pace.
   */
  pauseAt: plantTime('06:14'),
  /**
   * The orders in release and dispatch order, with the CNC the MES's dispatch rule chooses (ideal
   * times, the queue; apps/mes-server/src/modules/orders/dispatch-rule.ts) and probe D1 assumes.
   */
  orders: [
    { id: 'PO-2610-301', machine: 'cnc-01', quantity: 20 },
    { id: 'PO-2610-302', machine: 'cnc-02', quantity: 60 },
    { id: 'PO-2610-303', machine: 'cnc-01', quantity: 60 },
    { id: 'PO-2610-304', machine: 'cnc-02', quantity: 40 },
  ],
  machines: ['asm-01', 'cnc-01', 'cnc-02', 'lkt-01', 'pck-01', 'wsh-01'],
  failure: { machine: 'cnc-01', code: 'SPINDLE-OVERLOAD', at: plantTime('07:15') },
  /** The material whose lots the timeline blocks: OP10 starves with `MATERIAL:BLANK-100`. */
  blockedMaterial: 'BLANK-100',
  toolBreakage: { machine: 'cnc-02', at: plantTime('09:00') },
  drift: { machine: 'lkt-01', characteristic: 'leak-rate', at: plantTime('11:45') },
  /** ADR-0036: the line's bottleneck by ideal times (OP30, 150 s for VB-100). */
  bottleneck: 'asm-01',
} as const;

/**
 * The scenes, in order, and the plant time the walkthrough waits for before opening each (none:
 * right after the one before). The facts a scene shows must exist by then in every variant probe D1
 * runs inside the envelope (acceptance by the pause); its margin is how long before.
 */
export const SCENES = [
  { n: 1, id: 'overview', title: 'Overview: six machines live at 60×', at: null },
  { n: 2, id: 'orders', title: 'Orders: release and dispatch; the CNCs accept', at: null },
  { n: 3, id: 'console', title: 'Console: status, timeline progress, pause and resume', at: null },
  { n: 4, id: 'alarms', title: 'Alarms and downtime: acknowledged, breakdown coded', at: '07:20' },
  { n: 5, id: 'oee', title: 'OEE: availability loss, bottleneck, an order’s OEE', at: '09:00' },
  { n: 6, id: 'spc', title: 'SPC: the leak test’s drift episode', at: '12:00' },
  { n: 7, id: 'hold', title: 'Hold: from the episode; the close refused', at: '12:00' },
  {
    n: 8,
    id: 'trace',
    title: 'Traceability: a packed serial back, its blank lot forward',
    at: null,
  },
] as const;

/** Scene 4 codes the breakdown no earlier than this (its repair has ended by then). */
export const CODE_AT = '07:50';

/** Scene 7 tries the close no earlier than this (the held order completed by then). */
export const CLOSE_AT = '12:25';

export type SceneId = (typeof SCENES)[number]['id'];

/** The plant time a scene waits for, in epoch ms, or null. */
export function sceneAt(id: SceneId): number | null {
  const at = SCENES.find((s) => s.id === id)?.at ?? null;
  return at === null ? null : plantTime(at);
}

/**
 * The scenes a run's scene log (`scenes.jsonl`, one JSON record per scene) holds, refused unless
 * it is exactly scenes 1 to 8 in order: a walkthrough that was skipped or stopped early exits 0
 * from Playwright too, and must not count as a demo run.
 */
export function checkSceneLog(text: string): number[] {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const scenes = lines.map((line) => {
    try {
      return (JSON.parse(line) as { n?: unknown }).n;
    } catch {
      return undefined;
    }
  });
  const expected = SCENES.map((s) => s.n);
  if (JSON.stringify(scenes) !== JSON.stringify(expected)) {
    throw new Error(
      `the scene log must record scenes ${expected.join(', ')} once each, in order; it has ${
        lines.length === 0 ? 'nothing' : JSON.stringify(scenes)
      }`,
    );
  }
  return expected;
}
