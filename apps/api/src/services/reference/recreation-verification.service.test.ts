import { describe, expect, it } from "vitest";
import type { EditBlueprint } from "@tempo/types";
import {
  missingVerificationCaptureTimes,
  verificationCaptureTimes,
  verificationTimesForSegment,
} from "./recreation-verification.service.js";

describe("automatic recreation verification sampling", () => {
  it("samples immediately around measured internal events", () => {
    const blueprint = {
      id: "bp", referenceUrl: "", totalDuration: 4, aspectRatio: "16:9", createdAt: "",
      overallStyle: { colorGrading: "", pacing: "fast", mood: "", genre: "" },
      audioAnalysis: { bpm: 0, beats: [], energyCurve: [], mood: "", genre: "" },
      segments: [{ index: 3, startTime: 0, duration: 4, shotType: "wide", motionType: "static", transitionToNext: "cut", energyLevel: 50, visualDescription: "", colorPalette: [], effects: [], textOverlays: [], onBeat: false, speed: 1 }],
      analysisEvidence: { schemaVersion: 1, provider: "tempo-local-cv", analysisFps: 12, width: 192, height: 108, scenes: [{ sceneIndex: 3, startTime: 0, endTime: 4, frames: [], eventTimes: [1.5], maxVisibleComponents: 1 }] },
    } satisfies EditBlueprint;
    const times = verificationTimesForSegment(blueprint, 3);
    expect(times.some((time) => Math.abs(time - (1.5 - 1 / 30)) < 0.002)).toBe(true);
    expect(times.some((time) => Math.abs(time - (1.5 + 1 / 30)) < 0.002)).toBe(true);
  });

  it("builds one deduplicated capture plan across complex ranges", () => {
    const base = {
      id: "bp", referenceUrl: "", totalDuration: 4, aspectRatio: "16:9", createdAt: "",
      overallStyle: { colorGrading: "", pacing: "fast", mood: "", genre: "" },
      audioAnalysis: { bpm: 0, beats: [], energyCurve: [], mood: "", genre: "" },
      segments: [0, 1].map((index) => ({
        index,
        startTime: index * 2,
        duration: 2,
        shotType: "wide" as const,
        motionType: "static" as const,
        transitionToNext: "cut" as const,
        energyLevel: 50,
        visualDescription: "",
        colorPalette: [],
        effects: [],
        textOverlays: [],
        onBeat: false,
        speed: 1,
        composition: {
          replaceBase: true,
          layers: [{
            id: `panel-${index}`,
            role: "panel" as const,
            contentDescription: "",
            zIndex: 1,
            timing: { startRatio: 0, endRatio: 1 },
            viewport: { x: 0, y: 0, width: 1, height: 1 },
            fit: "cover" as const,
          }],
        },
      })),
    } satisfies EditBlueprint;
    const times = verificationCaptureTimes(base);
    expect(times).toEqual([...new Set(times)]);
    expect(times[0]).toBe(0);
    expect(times.at(-1)).toBeCloseTo(3.999, 3);
  });

  it("does not silently stop verification after four text scenes", () => {
    const blueprint = {
      id: "all-text", referenceUrl: "", totalDuration: 6, aspectRatio: "1:1", createdAt: "",
      overallStyle: { colorGrading: "", pacing: "fast" as const, mood: "", genre: "" },
      audioAnalysis: { bpm: 0, beats: [], energyCurve: [], mood: "", genre: "" },
      segments: Array.from({ length: 6 }, (_, index) => ({
        index, startTime: index, duration: 1, shotType: "wide" as const, motionType: "static" as const,
        transitionToNext: "cut" as const, energyLevel: 50, visualDescription: "", colorPalette: [], effects: [],
        textOverlays: [{ text: String(index), style: "bold" as const, position: "center" as const, animation: "static" }],
        onBeat: false, speed: 1,
      })),
    } satisfies EditBlueprint;
    const times = verificationCaptureTimes(blueprint);
    expect(times.some((time) => time >= 5)).toBe(true);
  });

  it("identifies only omitted critique frames for a bounded retry", () => {
    expect(missingVerificationCaptureTimes(
      [0, 1.333, 2.667, 3.999],
      [{ time: 0 }, { time: 1.3334 }, { time: 3.999 }]
    )).toEqual([2.667]);
  });
});
