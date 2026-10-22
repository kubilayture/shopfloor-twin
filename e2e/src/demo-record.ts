/**
 * The demo recording (#282, Phase 10 plan "Demo recording (P10-07)", docs/demo.md): what
 * `pnpm demo:record` records and the limits it is held to, and the pure helpers its harness
 * (src/demo.ts) uses: the WebVTT captions from the scene log, the screenshots' names, the bundled
 * ffmpeg's path and arguments.
 *
 * The recording is the walkthrough itself (browser/demo/walkthrough.spec.ts), with Playwright's
 * video on its one context and page: nothing is staged that the test doesn't assert, and no
 * caption or overlay is injected into the application's pages (the captions are a separate file).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEMO, SCENES, plantClock, type SceneId } from './demo-plan.ts';

const MiB = 1024 * 1024;

export const RECORDING = {
  /** The page's viewport: the walkthrough's (Playwright's Desktop Chrome). */
  viewport: { width: 1280, height: 720 },
  /**
   * The video's size: the plan's first fallback over the size limit, 960 × 540 (the 1280 × 720
   * viewport scaled down by Playwright). The 60 s probe at 1280 × 720 extrapolated to about 50 MiB
   * for the whole walkthrough (docs/demo.md, "Size probe").
   */
  video: { width: 960, height: 540 },
  /**
   * The views each scene asserts (#303), in the order it shows them: the screens whose content the
   * scene asserts as what it shows (docs/demo.md's scene table, "It shows"), not the forms its
   * actions pass through. Under `pnpm demo:record` each is held once its assertions have passed
   * (e2e/browser/demo/demo.ts `holdView`, scrolled to what it asserts where that is below the fold)
   * and its dwell written to the record; a recording with a view missing or held under
   * `minViewMs` is refused (`recordingProblems`). The first committed recording held only each
   * scene's last view: scene 5 showed its OEE dashboard for under half a second, still loading,
   * and never its order's OEE section.
   */
  views: {
    overview: ['overview'],
    orders: ['orders', ...DEMO.orders.map((o) => `order-${o.id}`)],
    console: ['console'],
    alarms: ['alarm-active', 'alarm-acknowledged', 'downtime-coded'],
    oee: ['oee-line', 'oee-machines', 'oee-pareto', 'order-oee'],
    spc: ['spc-episode'],
    hold: ['hold-opened', 'holds-list', 'hold-detail', 'close-refused'],
    trace: ['trace-carton', 'trace-serial', 'trace-lot'],
  } satisfies Readonly<Record<SceneId, readonly string[]>>,
  /**
   * The view each scene's screenshot shows, where not its last: its main asserted content (#303).
   * Scene 5's is the OEE figures (CNC-01's row among the machines), scene 8's the serial traced
   * back (success criterion 4).
   */
  screenshotViews: { oee: 'oee-machines', trace: 'trace-serial' } as Readonly<
    Partial<Record<SceneId, string>>
  >,
  /** How long the recording holds each asserted view (#303). */
  viewMs: 2_000,
  /**
   * How long it holds the last view of a scene of `heldScenes` instead (#282): the first recording,
   * without a hold, showed scenes 6 and 8 for under a second each (their facts exist long before
   * they open), and scene 6's SPC charts load after its assertions.
   */
  dwellMs: 3_000,
  /**
   * The scenes whose last view gets `dwellMs` (#282 review m5): from scene 3 on. Scenes 1 and 2 run
   * before the timeline's pause at 06:14; their views get `viewMs` only, which keeps the dispatch's
   * acceptance well inside probe D1's envelope (by 06:14).
   */
  heldScenes: [3, 4, 5, 6, 7, 8],
  /** The least a view may be held for the recording to be published (#303). */
  minViewMs: 1_000,
  /** Where `pnpm demo:record` publishes (relative to the repository). */
  dir: 'docs/demo',
  videoFile: 'shopfloor-twin-v1.webm',
  captionsFile: 'demo-v1.vtt',
  limits: {
    videoBytes: 12 * MiB,
    screenshotBytes: 4 * MiB,
    /**
     * The plan's limit is 6 minutes. The walkthrough at 60× can't be shorter than its plant time,
     * 06:00 to past 12:25 (the hold scene's close): over 6 minutes of wall time. The coordinator's
     * decision (#282, docs/demo.md "Length"): at most 7 minutes, a deviation for the owner's review.
     */
    seconds: 7 * 60,
  },
} as const;

/**
 * The scripted re-encode (the plan's second fallback over the size limit), with Playwright's
 * bundled ffmpeg (it decodes and encodes VP9 only): one pass at constant quality (`-crf 36
 * -b:v 0`, no bitrate cap) with libvpx's `good` deadline, where Playwright records in real time at
 * `-crf 8` up to a bitrate cap. Same size, same frame rate, no audio. Applied by `pnpm demo:record`
 * only when the recorded video is over the size limit. CRF 36 was chosen on the probe's video
 * (docs/demo.md): about 1.2 MiB per minute at 960 × 540, the UI's text still sharp.
 */
export const REENCODE_ARGS = [
  '-c:v',
  'libvpx-vp9',
  '-crf',
  '36',
  '-b:v',
  '0',
  '-deadline',
  'good',
  '-cpu-used',
  '4',
  '-row-mt',
  '1',
  '-an',
] as const;

/** A scene's screenshot in docs/demo/: `NN-<scene>.png`. */
export const screenshotName = (n: number, id: string): string =>
  `${String(n).padStart(2, '0')}-${id}.png`;

/** A scene's asserted views (RECORDING.views), by its number. */
export function viewsOf(n: number): readonly string[] {
  const scene = SCENES.find((s) => s.n === n);
  if (!scene) throw new Error(`no scene ${String(n)}`);
  return RECORDING.views[scene.id];
}

/** The view a scene's screenshot is taken at: its RECORDING.screenshotViews entry, or its last. */
export function screenshotView(n: number): string {
  const views = viewsOf(n);
  const id = SCENES.find((s) => s.n === n)?.id;
  return (id && RECORDING.screenshotViews[id]) ?? views[views.length - 1] ?? '';
}

/** How long the recording holds a scene's view: `dwellMs` for a held scene's last, else `viewMs`. */
export function holdMs(n: number, view: string): number {
  const views = viewsOf(n);
  const last = views[views.length - 1] === view;
  return last && (RECORDING.heldScenes as readonly number[]).includes(n)
    ? RECORDING.dwellMs
    : RECORDING.viewMs;
}

/** A held view as the recording's record has it: where in the video, and for how long. */
export interface HeldView {
  readonly scene: number;
  readonly view: string;
  /** Its start in the video, s. */
  readonly at: number;
  /** How long it was held, s: from the end of its scroll to the walkthrough's next action. */
  readonly seconds: number;
}

/** The held views from the run's view log (`views.jsonl`, a line per held view) and the video's start. */
export function heldViewsFromLog(text: string, videoStartMs: number): HeldView[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const v = JSON.parse(line) as { n: number; view: string; wallStart: string; wallEnd: string };
      const start = Date.parse(v.wallStart);
      return {
        scene: v.n,
        view: v.view,
        at: Number(((start - videoStartMs) / 1000).toFixed(2)),
        seconds: Number(((Date.parse(v.wallEnd) - start) / 1000).toFixed(2)),
      };
    });
}

/** What each scene shows, for its caption (docs/demo.md's scene table, shortened). */
export const SHOWS: Readonly<Record<string, string>> = {
  overview: 'The operator sees the six machines live; the plant clock follows the run at 60×.',
  orders:
    'The supervisor releases and dispatches the four ERP orders; each CNC accepts its job (OPC UA LoadOrder).',
  console:
    'The admin sees the run paused by the timeline at 06:14, its progress list; resume, pause, resume.',
  alarms:
    'Maintenance acknowledges the spindle overload on CNC-01; after the repair, codes its breakdown.',
  oee: 'The supervisor sees CNC-01’s availability loss, the line’s bottleneck (ASM-01), an order’s OEE and first-pass yield.',
  spc: 'The quality user sees the leak test’s SPC chart with the drift’s first episode.',
  hold: 'A hold from the episode, its scope on the holds screen; the order’s close refused while held.',
  trace:
    'A packed serial traced back to its lots, machines, operator and leak value; its blank lot forward to its cartons.',
};

interface LoggedScene {
  readonly n: number;
  readonly id: string;
  readonly title: string;
  readonly wallStart: string;
  readonly wallEnd: string;
  readonly plantStart: string;
  readonly plantEnd: string;
}

/** `HH:MM:SS.mmm` of a WebVTT cue. */
export function vttTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const pad = (v: number, n = 2) => String(v).padStart(n, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(t % 1000, 3)}`;
}

const hhmm = (iso: string) => plantClock(Date.parse(iso)).slice(0, 5);

/**
 * The captions (WebVTT) from the run's scene log (`scenes.jsonl`) and the video's start (the wall
 * time its page was opened, ms): one cue per scene from its start to its end, naming it, what it
 * shows and its plant times; between scenes, where the walkthrough waits for the plant, a cue
 * saying so. Refused unless the log holds scenes 1 to 8 in order.
 */
export function captionsFromSceneLog(
  text: string,
  videoStartMs: number,
  expected: readonly number[] = SCENES.map((s) => s.n),
): string {
  const scenes = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LoggedScene);
  if (JSON.stringify(scenes.map((s) => s.n)) !== JSON.stringify(expected)) {
    throw new Error(`the scene log must hold scenes ${expected.join(', ')} in order`);
  }
  const cues: string[] = ['WEBVTT', ''];
  let previous: LoggedScene | undefined;
  for (const scene of scenes) {
    const start = Date.parse(scene.wallStart) - videoStartMs;
    const end = Date.parse(scene.wallEnd) - videoStartMs;
    if (start < 0 || end < start) {
      throw new Error(`scene ${String(scene.n)} is outside the video (${String(start)} ms)`);
    }
    if (previous) {
      const gapStart = Date.parse(previous.wallEnd) - videoStartMs;
      if (start - gapStart >= 2_000) {
        cues.push(
          `wait-${String(scene.n)}`,
          `${vttTime(gapStart)} --> ${vttTime(start)}`,
          `The run goes on at 60× (plant ${hhmm(previous.plantEnd)} to ${hhmm(scene.plantStart)}); scene ${String(scene.n)} opens at ${hhmm(scene.plantStart)}.`,
          '',
        );
      }
    }
    cues.push(
      `scene-${String(scene.n)}`,
      `${vttTime(start)} --> ${vttTime(end)}`,
      `${String(scene.n)}. ${scene.title} (plant ${hhmm(scene.plantStart)}–${hhmm(scene.plantEnd)})`,
      SHOWS[scene.id] ?? '',
      '',
    );
    previous = scene;
  }
  return cues.join('\n');
}

/**
 * The ffmpeg Playwright records with (its own build, `playwright install` puts it beside the
 * browsers): the revision from playwright-core's browsers.json, under PLAYWRIGHT_BROWSERS_PATH or
 * the default cache directory.
 */
export function bundledFfmpeg(): string {
  // @playwright/test → playwright → playwright-core (pnpm keeps each one's dependencies its own).
  const test = createRequire(import.meta.url).resolve('@playwright/test/package.json');
  const playwright = createRequire(test).resolve('playwright/package.json');
  const core = dirname(createRequire(playwright).resolve('playwright-core/package.json'));
  const { browsers } = JSON.parse(readFileSync(join(core, 'browsers.json'), 'utf8')) as {
    browsers: { name: string; revision: string }[];
  };
  const revision = browsers.find((b) => b.name === 'ffmpeg')?.revision;
  if (!revision) throw new Error('playwright-core lists no ffmpeg');
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === 'darwin'
      ? join(homedir(), 'Library/Caches/ms-playwright')
      : join(homedir(), '.cache/ms-playwright'));
  const binary =
    process.platform === 'darwin'
      ? 'ffmpeg-mac'
      : process.platform === 'win32'
        ? 'ffmpeg-win64.exe'
        : 'ffmpeg-linux';
  return join(root, `ffmpeg-${revision}`, binary);
}

/** The duration and size `ffmpeg -i` reports for a video (its stderr), or throws. */
export function probeInfo(stderr: string): { seconds: number; width: number; height: number } {
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const size = /Video: .*?, (\d+)x(\d+)/.exec(stderr);
  if (!duration || !size) throw new Error(`ffmpeg reported no duration or size:\n${stderr}`);
  return {
    seconds: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
    width: Number(size[1]),
    height: Number(size[2]),
  };
}

/** What `pnpm demo:record` has staged and checks before it publishes anything. */
export interface StagedRecording {
  readonly bytes: number;
  readonly seconds: number;
  readonly width: number;
  readonly height: number;
  readonly screenshotBytes: number;
  /** The text files to publish or keep (captions, the record): searched for secrets. */
  readonly texts: readonly string[];
  /** The scenes recorded: all eight (the size probe's, 1 to 3). */
  readonly scenes: readonly number[];
  /** Each view held, from the view log (#303). */
  readonly views: readonly HeldView[];
}

/**
 * Why a staged recording must not be published (none: it may be): the video over 12 MiB or the
 * length limit or not at RECORDING.video's size, the screenshots over 4 MiB together, a secret of
 * the run in a text file, a view a recorded scene asserts not held or held under
 * RECORDING.minViewMs (#303).
 */
export function recordingProblems(staged: StagedRecording, secrets: readonly string[]): string[] {
  const { limits, video } = RECORDING;
  const mib = (bytes: number) => `${(bytes / MiB).toFixed(2)} MiB`;
  const problems: string[] = [];
  if (staged.bytes > limits.videoBytes) problems.push(`the video is ${mib(staged.bytes)}`);
  if (staged.seconds > limits.seconds) {
    problems.push(`the video is ${staged.seconds.toFixed(1)} s long`);
  }
  if (staged.width !== video.width || staged.height !== video.height) {
    problems.push(`the video is ${String(staged.width)}×${String(staged.height)}`);
  }
  if (staged.screenshotBytes > limits.screenshotBytes) {
    problems.push(`the screenshots are ${mib(staged.screenshotBytes)} together`);
  }
  if (secrets.some((secret) => secret !== '' && staged.texts.some((t) => t.includes(secret)))) {
    problems.push('the captions or the record hold a secret of the run');
  }
  for (const n of staged.scenes) {
    for (const view of viewsOf(n)) {
      const held = staged.views.filter((v) => v.scene === n && v.view === view);
      if (held.length === 0) {
        problems.push(`scene ${String(n)}'s view ${view} is not held`);
        continue;
      }
      const shortest = Math.min(...held.map((v) => v.seconds));
      if (shortest * 1000 < RECORDING.minViewMs) {
        problems.push(
          `scene ${String(n)}'s view ${view} is held ${shortest.toFixed(2)} s, under ${String(RECORDING.minViewMs / 1000)} s`,
        );
      }
    }
  }
  return problems;
}

/** The files `pnpm demo:record` publishes in docs/demo/: the video, the captions, the screenshots. */
export const PUBLISHED_FILES: readonly string[] = [
  RECORDING.videoFile,
  RECORDING.captionsFile,
  ...SCENES.map((s) => screenshotName(s.n, s.id)),
];

/** The file-system steps of a publish, injected (node:fs/promises in the harness). */
export interface PublishSteps {
  mkdir(dir: string): Promise<unknown>;
  readdir(dir: string): Promise<string[]>;
  rm(path: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
}

/**
 * Publishes a staged recording (every file of PUBLISHED_FILES in `staged`) to `out`, only when it
 * has no problem; otherwise throws before touching `out`, which then keeps the last recording
 * whole. A screenshot in `out` that the recording doesn't have (`NN-<scene>.png` of a scene since
 * removed) is removed.
 */
export async function publishStaged(
  staged: string,
  out: string,
  problems: readonly string[],
  steps: PublishSteps,
): Promise<void> {
  if (problems.length > 0) {
    throw new Error(`the recording is refused (docs/demo/ unchanged): ${problems.join('; ')}`);
  }
  await steps.mkdir(out);
  for (const name of await steps.readdir(out)) {
    if (/^\d\d-.+\.png$/.test(name) && !PUBLISHED_FILES.includes(name)) {
      await steps.rm(join(out, name));
    }
  }
  for (const name of PUBLISHED_FILES) await steps.copyFile(join(staged, name), join(out, name));
}
