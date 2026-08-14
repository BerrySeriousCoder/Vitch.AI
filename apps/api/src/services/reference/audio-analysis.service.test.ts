import { describe, expect, it } from "vitest";
import { detectSpectralOnsetsFromPcm, finalizeRhythmDetection } from "./audio-analysis.service.js";

describe("reference audio impact retention", () => {
  it("retains irregular impacts when no BPM grid is trustworthy", () => {
    const beats = [0.1, 0.47, 1.32].map((time) => ({ time, strength: 0.9, isDownbeat: false }));
    const impacts = beats.map((beat, index) => ({ ...beat, id: `impact-${index}`, kind: "onset" as const }));
    expect(finalizeRhythmDetection(beats, impacts, 0, 0.05)).toMatchObject({
      bpm: 0,
      beats: [],
      impacts: [
        { id: "impact-0", time: 0.1 },
        { id: "impact-1", time: 0.47 },
        { id: "impact-2", time: 1.32 },
      ],
      beatSource: "unavailable",
    });
  });

  it("labels impacts as beats only after validating a periodic grid", () => {
    const beats = [0, 0.5, 1, 1.5].map((time) => ({ time, strength: 1, isDownbeat: false }));
    const impacts = beats.map((beat, index) => ({ ...beat, id: `impact-${index}`, kind: "onset" as const }));
    const result = finalizeRhythmDetection(beats, impacts, 120, 0.9);
    expect(result.beatSource).toBe("detected");
    expect(result.impacts.every((impact) => impact.kind === "beat")).toBe(true);
  });

  it("detects irregular transient attacks without requiring a loudness spike", () => {
    const rate = 22_050;
    const samples = new Float32Array(rate * 2);
    for (const attack of [0.25, 0.83, 1.42]) {
      const start = Math.round(attack * rate);
      for (let index = 0; index < 420; index++) {
        samples[start + index] = Math.sin(index * 1.91) * Math.exp(-index / 90) * 0.7;
      }
    }
    const times = detectSpectralOnsetsFromPcm(samples, rate).map((onset) => onset.time);
    for (const expected of [0.25, 0.83, 1.42]) {
      expect(times.some((time) => Math.abs(time - expected) < 0.08)).toBe(true);
    }
  });
});
