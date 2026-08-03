import { describe, expect, it } from "vitest";
import { normalizeMulticam, resolveMulticamAngleAtTime, setMulticamSwitch } from "./multicam";

const input = {
  angles: [
    { id: "a", name: "Wide", sourceClipId: "wide-clip", sourceMediaId: "wide-media", sourceOffset: 1.2 },
    { id: "b", name: "Close", sourceClipId: "close-clip", sourceMediaId: "close-media", sourceOffset: 1.4 },
  ],
  switches: [{ time: 0, angleId: "a" }, { time: 2, angleId: "b" }],
  audioAngleId: "a",
};

describe("multicam", () => {
  it("resolves non-destructive angle switches by clip-local time", () => {
    const multicam = normalizeMulticam(input)!;
    expect(resolveMulticamAngleAtTime(multicam, 1)?.id).toBe("a");
    expect(resolveMulticamAngleAtTime(multicam, 2)?.id).toBe("b");
  });

  it("replaces a cut at the same timestamp", () => {
    const multicam = setMulticamSwitch(normalizeMulticam(input), 2, "a")!;
    expect(multicam.switches).toEqual([{ time: 0, angleId: "a" }, { time: 2, angleId: "a" }]);
  });

  it("preserves bounded audio-sync provenance for editable angle offsets", () => {
    const multicam = normalizeMulticam({ ...input, sync: { mode: "audio-correlation", referenceAngleId: "a", confidenceByAngle: { a: 1, b: 4 }, analysedAt: "2026-08-11T00:00:00.000Z" } })!;
    expect(multicam.sync).toMatchObject({ mode: "audio-correlation", referenceAngleId: "a", confidenceByAngle: { a: 1, b: 1 } });
  });
});
