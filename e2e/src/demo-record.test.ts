import { describe, expect, it } from 'vitest';
import { SCENES } from './demo-plan.ts';
import {
  RECORDING,
  SHOWS,
  captionsFromSceneLog,
  probeInfo,
  screenshotName,
  vttTime,
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
    expect(vttTime(3_723_004)).toBe('01:02:03.004');
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
