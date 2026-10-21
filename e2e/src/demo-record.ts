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
import { SCENES, plantClock } from './demo-plan.ts';

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
export function captionsFromSceneLog(text: string, videoStartMs: number): string {
  const scenes = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LoggedScene);
  const expected = SCENES.map((s) => s.n);
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
