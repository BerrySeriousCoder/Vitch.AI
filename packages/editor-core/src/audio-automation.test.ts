import { describe, expect, it } from "vitest";
import type { Clip } from "@tempo/types";
import {
  audioAutomationValueAt,
  ffmpegAudioAutomationExpr,
  multiplyAudioAutomationBreakpoints,
  normalizeAudioAutomationPoints,
  resolveAudioAutomationBreakpoints,
} from "./audio-automation";

const clip: Pick<Clip, "startTime" | "duration" | "audioAutomation"> = {
  startTime: 10,
  duration: 4,
  audioAutomation: {
    volume: [{ time: 0, value: 1 }, { time: 4, value: 0.5 }],
    pan: [{ time: 1, value: -0.25 }, { time: 3, value: 0.5 }],
  },
};

describe("audio automation", () => {
  it("normalizes, bounds, and coalesces envelope points", () => {
    expect(normalizeAudioAutomationPoints([
      { time: 3, value: 5 },
      { time: -1, value: -2 },
      { time: 3, value: 0.25 },
    ], "volume", 4)).toEqual([
      { time: 0, value: 0, interpolation: "linear" },
      { time: 3, value: 0.25, interpolation: "linear" },
    ]);
  });

  it("evaluates held and linear values", () => {
    expect(audioAutomationValueAt([{ time: 0, value: 0, interpolation: "hold" }, { time: 2, value: 1 }], "volume", 1)).toBe(0);
    expect(audioAutomationValueAt([{ time: 0, value: 0 }, { time: 2, value: 1 }], "volume", 1)).toBe(0.5);
  });

  it("combines clip-local and absolute track automation", () => {
    const points = resolveAudioAutomationBreakpoints(clip, {
      trackAutomation: { a1: { volume: [{ time: 10, value: 0.5 }, { time: 14, value: 1 }] } },
    }, "a1", "volume");
    expect(points.map((point) => [point.t, point.value])).toEqual([[0, 0.5], [4, 0.5]]);
  });

  it("multiplies gain envelopes and generates an FFmpeg-safe expression", () => {
    const combined = multiplyAudioAutomationBreakpoints(2, [{ t: 0, value: 1 }, { t: 2, value: 0.5 }], [{ t: 1, value: 0.5 }]);
    expect(combined.map((point) => point.value)).toEqual([0.5, 0.375, 0.25]);
    expect(ffmpegAudioAutomationExpr(combined, 1)).toContain("between(t,0.0000,1.0000)");
  });
});
