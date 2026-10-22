import { describe, expect, it } from 'vitest';
import { SCENES } from './demo-plan.ts';
import {
  PUBLISHED_FILES,
  RECORDING,
  SHOWS,
  captionsFromSceneLog,
  heldViewsFromLog,
  holdMs,
  probeInfo,
  publishStaged,
  recordingProblems,
  screenshotName,
  screenshotView,
  viewsOf,
  vttTime,
  type HeldView,
  type PublishSteps,
  type StagedRecording,
} from './demo-record.ts';

/** The demo recording's pure helpers (#282): captions from the scene log, names, ffmpeg's report. */

const VIDEO_START = Date.parse('2026-10-21T10:00:00.000Z');
const wall = (s: number) => new Date(VIDEO_START + s * 1000).toISOString();
const plant = (hhmm: string) => `2026-10-12T${hhmm}:00+03:00`;

/** A scene log like a run's: scene n from `start` to `end` seconds of the video. */
function sceneLog(
  times: readonly (readonly [number, number, string, string])[],
  scenes: readonly (typeof SCENES)[number][] = SCENES,
): string {
  return scenes
    .map((s, i) => {
      const [start, end, plantStart, plantEnd] = times[i] ?? [0, 0, '06:00', '06:00'];
      return JSON.stringify({
        n: s.n,
        id: s.id,
        title: s.title,
        wallStart: wall(start),
        wallEnd: wall(end),
        plantStart: plant(plantStart),
        plantEnd: plant(plantEnd),
        facts: {},
      });
    })
    .join('\n');
}

const TIMES = [
  [0.5, 6, '06:00', '06:05'],
  [6, 20, '06:05', '06:14'],
  [20, 35, '06:14', '06:29'],
  [86, 140, '07:20', '07:52'],
  [208, 230, '09:00', '09:22'],
  [388, 420, '12:00', '12:12'],
  [420, 470, '12:12', '12:26'],
  [470, 490, '12:26', '12:46'],
] as const;

describe('captionsFromSceneLog', () => {
  const vtt = captionsFromSceneLog(sceneLog(TIMES), VIDEO_START);

  it('is WebVTT with one cue per scene, at its offsets in the video', () => {
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    for (const [i, s] of SCENES.entries()) {
      const [start, end] = TIMES[i] ?? [0, 0];
      expect(vtt).toContain(
        `scene-${String(s.n)}\n${vttTime(start * 1000)} --> ${vttTime(end * 1000)}\n${String(s.n)}. ${s.title}`,
      );
      expect(vtt).toContain(SHOWS[s.id]);
    }
  });

  it('names the plant times, and a wait cue only where the walkthrough waits', () => {
    expect(vtt).toContain('4. Alarms and downtime');
    expect(vtt).toContain('(plant 07:20–07:52)');
    expect(vtt).toContain(
      'wait-4\n00:00:35.000 --> 00:01:26.000\nThe run goes on at 60× (plant 06:29 to 07:20)',
    );
    expect(vtt).not.toContain('wait-2');
    expect(vtt).not.toContain('wait-8');
    expect(vtt.match(/^wait-/gm)).toHaveLength(3);
  });

  it('refuses a log without every scene in order, or a scene before the video', () => {
    expect(() => captionsFromSceneLog(sceneLog(TIMES, SCENES.slice(0, 3)), VIDEO_START)).toThrow(
      /scenes 1, 2, 3, 4, 5, 6, 7, 8/,
    );
    expect(() => captionsFromSceneLog(sceneLog(TIMES), VIDEO_START + 1000)).toThrow(
      /outside the video/,
    );
  });
});

describe('the recording’s names and limits', () => {
  it('names each screenshot NN-<scene>.png', () => {
    expect(SCENES.map((s) => screenshotName(s.n, s.id))).toEqual([
      '01-overview.png',
      '02-orders.png',
      '03-console.png',
      '04-alarms.png',
      '05-oee.png',
      '06-spc.png',
      '07-hold.png',
      '08-trace.png',
    ]);
  });

  it('holds the plan’s size limits and the 7-minute length decision', () => {
    expect(RECORDING.limits).toEqual({
      videoBytes: 12 * 1024 * 1024,
      screenshotBytes: 4 * 1024 * 1024,
      seconds: 420,
    });
    expect(RECORDING.video).toEqual({ width: 960, height: 540 });
    expect(RECORDING.heldScenes).toEqual([3, 4, 5, 6, 7, 8]);
    expect(RECORDING.minViewMs).toBe(1_000);
    expect(vttTime(3_723_004)).toBe('01:02:03.004');
  });
});

describe('the views each scene asserts (#303)', () => {
  it('lists every scene’s views, scene 5’s dashboard and order among them', () => {
    for (const s of SCENES) expect(viewsOf(s.n).length).toBeGreaterThan(0);
    expect(viewsOf(5)).toEqual(['oee-line', 'oee-machines', 'oee-pareto', 'order-oee']);
    expect(viewsOf(2)).toEqual([
      'orders',
      'order-PO-2610-301',
      'order-PO-2610-302',
      'order-PO-2610-303',
      'order-PO-2610-304',
    ]);
  });

  it('takes each screenshot at one of its scene’s views: scene 5’s at the OEE figures', () => {
    for (const s of SCENES) expect(viewsOf(s.n)).toContain(screenshotView(s.n));
    expect(screenshotView(5)).toBe('oee-machines');
    expect(screenshotView(8)).toBe('trace-serial');
    expect(screenshotView(7)).toBe('close-refused');
  });

  it('holds every view at least the minimum, a held scene’s last view longest', () => {
    for (const s of SCENES) {
      for (const view of viewsOf(s.n)) {
        expect(holdMs(s.n, view)).toBeGreaterThanOrEqual(RECORDING.minViewMs);
      }
    }
    expect(holdMs(5, 'oee-line')).toBe(RECORDING.viewMs);
    expect(holdMs(5, 'order-oee')).toBe(RECORDING.dwellMs);
    expect(holdMs(2, 'order-PO-2610-304')).toBe(RECORDING.viewMs);
  });

  it('reads the view log into each view’s place in the video and its dwell', () => {
    const log = [
      { n: 5, view: 'oee-line', wallStart: wall(181.5), wallEnd: wall(183.52) },
      { n: 5, view: 'order-oee', wallStart: wall(190), wallEnd: wall(193.004) },
    ]
      .map((v) => JSON.stringify(v))
      .join('\n');
    expect(heldViewsFromLog(`${log}\n`, VIDEO_START)).toEqual([
      { scene: 5, view: 'oee-line', at: 181.5, seconds: 2.02 },
      { scene: 5, view: 'order-oee', at: 190, seconds: 3 },
    ]);
    expect(heldViewsFromLog('', VIDEO_START)).toEqual([]);
  });
});

describe('probeInfo', () => {
  it('reads the duration and size of ffmpeg’s report', () => {
    const report = [
      "Input #0, matroska,webm, from 'walkthrough.webm':",
      '  Duration: 00:06:31.24, start: 0.000000, bitrate: 160 kb/s',
      '  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv, progressive), 1280x720, SAR 1:1 DAR 16:9, 25 fps',
    ].join('\n');
    expect(probeInfo(report)).toEqual({ seconds: 391.24, width: 1280, height: 720 });
    expect(() => probeInfo('Duration: N/A')).toThrow(/no duration/);
  });
});

describe('recordingProblems', () => {
  /** Every view of `scenes` held 2 s, one after the other. */
  const heldAll = (scenes: readonly number[]): HeldView[] =>
    scenes.flatMap((n) =>
      viewsOf(n).map((view, i) => ({ scene: n, view, at: n * 40 + i * 3, seconds: 2 })),
    );
  const ALL = SCENES.map((s) => s.n);
  const ok: StagedRecording = {
    bytes: 4_866_985,
    seconds: 396.5,
    width: 960,
    height: 540,
    screenshotBytes: 969_618,
    texts: ['WEBVTT\n\nscene-1', '{"commit":"577d8ce"}'],
    scenes: ALL,
    views: heldAll(ALL),
  };
  const secrets = ['3f9a0c1e5b7d2468ace0f13579bdf024', 'a-generated-password-of-the-run'];

  it('finds none in a recording within every limit', () => {
    expect(recordingProblems(ok, secrets)).toEqual([]);
  });

  it('names each limit broken, the size, a secret in a text file', () => {
    expect(
      recordingProblems(
        {
          bytes: 12 * 1024 * 1024 + 1,
          seconds: 420.1,
          width: 1280,
          height: 720,
          screenshotBytes: 4 * 1024 * 1024 + 1,
          texts: ['WEBVTT', `{"note":"${secrets[1] ?? ''}"}`],
          scenes: ALL,
          views: heldAll(ALL),
        },
        secrets,
      ),
    ).toEqual([
      'the video is 12.00 MiB',
      'the video is 420.1 s long',
      'the video is 1280×720',
      'the screenshots are 4.00 MiB together',
      'the captions or the record hold a secret of the run',
    ]);
    expect(recordingProblems(ok, ['', ...secrets])).toEqual([]);
  });

  it('refuses a view a scene asserts that is not held, or held under 1 s (#303)', () => {
    // The first committed recording: scene 5's dashboard on screen for 0.4 s, its order's OEE
    // section never in view.
    const views = heldAll(ALL)
      .filter((v) => !(v.scene === 5 && v.view === 'order-oee'))
      .map((v) => (v.scene === 5 && v.view === 'oee-machines' ? { ...v, seconds: 0.4 } : v));
    expect(recordingProblems({ ...ok, views }, secrets)).toEqual([
      "scene 5's view oee-machines is held 0.40 s, under 1 s",
      "scene 5's view order-oee is not held",
    ]);
    const atMinimum = heldAll(ALL).map((v) => ({ ...v, seconds: 1 }));
    expect(recordingProblems({ ...ok, views: atMinimum }, secrets)).toEqual([]);
    const justUnder = atMinimum.map((v) => (v.scene === 8 ? { ...v, seconds: 0.99 } : v));
    expect(recordingProblems({ ...ok, views: justUnder }, secrets)).toHaveLength(viewsOf(8).length);
    // A view held twice counts by its shorter hold.
    const twice = [...heldAll(ALL), { scene: 1, view: 'overview', at: 1, seconds: 0.2 }];
    expect(recordingProblems({ ...ok, views: twice }, secrets)).toEqual([
      "scene 1's view overview is held 0.20 s, under 1 s",
    ]);
  });

  it('checks the views of the scenes recorded only (the size probe’s 1 to 3)', () => {
    const probe = { ...ok, scenes: [1, 2, 3] };
    expect(recordingProblems({ ...probe, views: heldAll([1, 2, 3]) }, secrets)).toEqual([]);
    expect(recordingProblems({ ...probe, views: [] }, secrets)).toHaveLength(
      viewsOf(1).length + viewsOf(2).length + viewsOf(3).length,
    );
  });
});

describe('publishStaged', () => {
  /** A fake file system recording each step; `out` starts with an old recording. */
  function fakeSteps(existing: string[]) {
    const calls: string[] = [];
    const steps: PublishSteps = {
      mkdir: (dir) => {
        calls.push(`mkdir ${dir}`);
        return Promise.resolve();
      },
      readdir: (dir) => {
        calls.push(`readdir ${dir}`);
        return Promise.resolve(existing);
      },
      rm: (path) => {
        calls.push(`rm ${path}`);
        return Promise.resolve();
      },
      copyFile: (from, to) => {
        calls.push(`copy ${from} ${to}`);
        return Promise.resolve();
      },
    };
    return { calls, steps };
  }

  it('refuses a recording with a problem without touching docs/demo/', async () => {
    const { calls, steps } = fakeSteps(['shopfloor-twin-v1.webm', '01-overview.png']);
    await expect(
      publishStaged('/r/publish', '/repo/docs/demo', ['the video is 13.00 MiB'], steps),
    ).rejects.toThrow(/refused \(docs\/demo\/ unchanged\): the video is 13\.00 MiB/);
    expect(calls).toEqual([]);
  });

  it('replaces every published file and removes a screenshot no scene has', async () => {
    const { calls, steps } = fakeSteps([
      'shopfloor-twin-v1.webm',
      '01-overview.png',
      '09-retired.png',
      'notes.txt',
    ]);
    await publishStaged('/r/publish', '/repo/docs/demo', [], steps);
    expect(calls).toEqual([
      'mkdir /repo/docs/demo',
      'readdir /repo/docs/demo',
      'rm /repo/docs/demo/09-retired.png',
      ...PUBLISHED_FILES.map((name) => `copy /r/publish/${name} /repo/docs/demo/${name}`),
    ]);
    expect(PUBLISHED_FILES).toHaveLength(10);
  });
});
