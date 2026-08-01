import { describe, expect, it } from "vitest";
import type { Track } from "@tempo/types";
import {
  mergeIntervals,
  voiceActivityWindows,
  musicDuckBreakpoints,
  normalizeDuckSettings,
  ffmpegVolumeExprFromBreakpoints,
} from "./audio-duck";

function track(
  id: string,
  clips: Array<{ id: string; start: number; dur: number }>
): Track {
  return {
    id,
    name: id,
    type: "audio",
    order: 0,
    locked: false,
    visible: true,
    solo: false,
    clips: clips.map((c) => ({
      id: c.id,
      trackId: id,
      sourceMediaId: "m",
      startTime: c.start,
      duration: c.dur,
      sourceOffset: 0,
      speed: 1,
      transform: {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        anchorX: 0.5,
        anchorY: 0.5,
      },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: false,
      volume: 1,
    })),
  };
}

describe("audio-duck", () => {
  it("merges voice windows", () => {
    expect(
      mergeIntervals([
        { start: 0, end: 2 },
        { start: 1.5, end: 3 },
        { start: 5, end: 6 },
      ])
    ).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 6 },
    ]);
  });

  it("builds duck breakpoints for overlapping music", () => {
    const mixer = {
      masterVolume: 1,
      trackVolumes: {},
      trackMutes: {},
      trackRoles: { voice: "voice" as const, music: "music" as const },
      duck: normalizeDuckSettings({
        enabled: true,
        level: 0.2,
        attackSec: 0,
        releaseSec: 0,
      }),
    };
    const windows = voiceActivityWindows(
      [track("voice", [{ id: "v1", start: 1, dur: 2 }]), track("music", [])],
      mixer
    );
    expect(windows).toEqual([{ start: 1, end: 3 }]);
    const bp = musicDuckBreakpoints(0, 5, windows, mixer.duck!);
    const mid = bp.find((p) => p.t >= 1 && p.t <= 3);
    expect(mid?.gain).toBeCloseTo(0.2);
  });

  it("emits ffmpeg volume expression", () => {
    const expr = ffmpegVolumeExprFromBreakpoints(
      [
        { t: 0, gain: 1 },
        { t: 1, gain: 0.25 },
        { t: 2, gain: 1 },
      ],
      1
    );
    expect(expr).toContain("between");
    expect(expr).toContain("0.25");
  });

  it("ignores non-solo voice when another track is solo", () => {
    const voice = track("voice", [{ id: "v1", start: 0, dur: 2 }]);
    const music = track("music", []);
    music.solo = true;
    const mixer = {
      masterVolume: 1,
      trackVolumes: {},
      trackMutes: {},
      trackRoles: { voice: "voice" as const, music: "music" as const },
      duck: normalizeDuckSettings({ enabled: true, level: 0.2 }),
    };
    expect(voiceActivityWindows([voice, music], mixer)).toEqual([]);
    voice.solo = true;
    expect(voiceActivityWindows([voice, music], mixer)).toEqual([
      { start: 0, end: 2 },
    ]);
  });

  it("ramps attack/release instead of stepping instantly", () => {
    const duck = normalizeDuckSettings({
      enabled: true,
      level: 0.25,
      attackSec: 0.5,
      releaseSec: 0.5,
    });
    const bp = musicDuckBreakpoints(0, 10, [{ start: 2, end: 5 }], duck);
    const atAttackStart = bp.find((p) => Math.abs(p.t - 2) < 1e-3);
    const atAttackEnd = bp.find((p) => Math.abs(p.t - 2.5) < 1e-3);
    expect(atAttackStart?.gain).toBeCloseTo(1);
    expect(atAttackEnd?.gain).toBeCloseTo(0.25);
  });

  it("treats NaN duck level as off (safe ffmpeg)", () => {
    const duck = normalizeDuckSettings({
      enabled: true,
      level: Number.NaN,
    });
    expect(duck.level).toBe(0.25);
    const expr = ffmpegVolumeExprFromBreakpoints(
      musicDuckBreakpoints(0, 2, [{ start: 0, end: 1 }], duck),
      1
    );
    expect(expr).not.toMatch(/NaN/i);
  });
});
