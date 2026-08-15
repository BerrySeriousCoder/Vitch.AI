import { describe, expect, it } from "vitest";
import { parseTempoProjectFile, projectFileData } from "./project-file";

describe("portable project files", () => {
  it("restores every advanced persisted surface and ignores unrelated fields", () => {
    const parsed = parseTempoProjectFile(JSON.stringify({
      name: "Advanced edit",
      settings: { width: 1920, height: 1080, fps: 30, duration: 10, backgroundColor: "#000000", sampleRate: 44100 },
      tracks: [{ id: "v1", name: "Video 1", type: "video", order: 0, locked: false, visible: true, solo: false, clips: [] }],
      audioMixer: { masterVolume: 0.8, trackVolumes: {}, trackMutes: {} },
      transitions: [{ id: "tx" }],
      editPlan: { id: "plan" },
      styleDnaLibrary: [{ id: "dna" }],
      sequences: [{ id: "seq" }],
      cameras: [{ id: "camera" }],
      lights: [{ id: "light" }],
      markers: [{ id: "marker" }],
      brandKit: { name: "Brand" },
      graphicTemplates: [{ id: "template" }],
      userId: "must-not-import",
    }));
    expect(parsed).not.toBeNull();
    const data = projectFileData(parsed!);
    expect(Object.keys(data)).toEqual([
      "tracks", "audioMixer", "transitions", "editPlan", "styleDnaLibrary", "sequences",
      "cameras", "lights", "markers", "brandKit", "graphicTemplates",
    ]);
    expect(data.transitions).toEqual([{ id: "tx" }]);
    expect(data.sequences).toEqual([{ id: "seq" }]);
    expect(data.brandKit).toEqual({ name: "Brand" });
    expect(data).not.toHaveProperty("userId");
  });

  it("rejects malformed envelopes", () => {
    expect(parseTempoProjectFile(JSON.stringify({ name: "Missing timeline", settings: {} }))).toBeNull();
    expect(parseTempoProjectFile(JSON.stringify({
      name: "Corrupt clip",
      settings: { width: 1920, height: 1080, fps: 30, duration: 10, backgroundColor: "#000000", sampleRate: 44100 },
      tracks: [{ id: "v1", name: "V1", type: "video", order: 0, locked: false, visible: true, solo: false, clips: [{ id: "bad", trackId: "v1", startTime: -2 }] }],
    }))).toBeNull();
    expect(parseTempoProjectFile(JSON.stringify({
      name: "Duplicate ids",
      settings: { width: 1920, height: 1080, fps: 30, duration: 10, backgroundColor: "#000000", sampleRate: 44100 },
      tracks: [
        { id: "v1", name: "V1", type: "video", order: 0, locked: false, visible: true, solo: false, clips: [] },
        { id: "v1", name: "V2", type: "video", order: 1, locked: false, visible: true, solo: false, clips: [] },
      ],
    }))).toBeNull();
  });
});
