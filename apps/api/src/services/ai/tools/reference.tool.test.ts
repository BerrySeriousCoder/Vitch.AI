import { describe, expect, it } from "vitest";
import type { EditBlueprint, MediaAsset } from "@tempo/types";
import { referenceToolExecutors } from "./reference.tool.js";
import { createProjectState } from "./index.js";
import { comparisonSamplePairs, referenceInspectionFps } from "../../critique/reference-comparison.service.js";
import { getToolDefinitions } from "./index.js";

const blueprint: EditBlueprint = {
  id: "bp-1",
  referenceUrl: "https://example.com/reference",
  referenceAssetId: "ref-1",
  totalDuration: 4,
  aspectRatio: "9:16",
  segments: [{
    index: 0,
    startTime: 0,
    duration: 4,
    shotType: "other",
    motionType: "static",
    transitionToNext: "none",
    energyLevel: 50,
    visualDescription: "Black title card",
    colorPalette: ["#000000"],
    effects: [],
    textOverlays: [],
    onBeat: false,
    speed: 1,
  }],
  audioAnalysis: { bpm: 0, beats: [], energyCurve: [], mood: "spoken", genre: "unknown" },
  overallStyle: { colorGrading: "dark", pacing: "moderate", mood: "spoken", genre: "unknown" },
  createdAt: "2026-08-11T00:00:00.000Z",
};

function referenceAsset(withTranscript = true): MediaAsset {
  return {
    id: "ref-1",
    projectId: "p1",
    name: "Reference video (analysis)",
    type: "video",
    url: "/uploads/media/reference-video/ref.mp4",
    thumbnailUrl: null,
    proxyUrl: null,
    waveformUrl: null,
    duration: 4,
    status: "ready",
    createdAt: "2026-08-11T00:00:00.000Z",
    metadata: {
      fileSize: 100,
      mimeType: "video/mp4",
      referenceVideo: { sourceUrl: blueprint.referenceUrl, blueprintId: blueprint.id, importedAt: blueprint.createdAt },
      ...(withTranscript ? {
        audioTranscript: {
          kind: "speech" as const,
          summary: "ballu tumahri jail se pharar",
          segments: [{ id: "s1", start: 1, end: 2, text: "ballu tumahri jail se pharar" }],
          model: "whisper-1",
          analyzedAt: blueprint.createdAt,
        },
      } : {}),
    },
  };
}

describe("reference evidence tools", () => {
  it("uses adaptive high temporal detail for short correction ranges", () => {
    expect(referenceInspectionFps(2)).toBe(30);
    expect(referenceInspectionFps(5)).toBe(20);
    expect(referenceInspectionFps(10)).toBe(12);
    expect(referenceInspectionFps(20)).toBe(8);
    expect(referenceInspectionFps(5, 99)).toBe(30);
  });

  it("registers the forensic reference/current-edit comparison tool", () => {
    const tool = getToolDefinitions().find((definition) => definition.name === "compare_reference_to_edit");
    expect((tool?.parameters as { required?: string[] } | undefined)?.required).toEqual([
      "referenceStartTime",
      "referenceEndTime",
      "question",
    ]);
  });

  it("aligns different-duration reference and edit ranges by normalized time", () => {
    const pairs = comparisonSamplePairs(5, 7, 10, 14, 5);
    expect(pairs).toHaveLength(5);
    expect(pairs[0]).toEqual({ referenceTime: 5, editTime: 10 });
    expect(pairs[2]).toEqual({ referenceTime: 6, editTime: 12 });
    expect(pairs.at(-1)!.referenceTime).toBeCloseTo(6.999, 6);
    expect(pairs.at(-1)!.editTime).toBeCloseTo(13.999, 6);
  });

  it("searches the retained reference transcript and records evidence", () => {
    const state = createProjectState([], undefined, { mediaAssets: [referenceAsset()], editBlueprint: blueprint });
    const { result } = referenceToolExecutors.get_reference_transcript(
      { query: "jail" },
      state
    );
    expect(JSON.parse(result).matches[0].text).toContain("jail");
    expect(state.referenceEvidence?.at(-1)?.kind).toBe("transcript");
  });

  it("reports missing ASR as unavailable rather than a no-match", () => {
    const state = createProjectState([], undefined, { mediaAssets: [referenceAsset(false)], editBlueprint: blueprint });
    const { result } = referenceToolExecutors.get_reference_transcript(
      { query: "jail" },
      state
    );
    expect(result).toMatch(/^Error: .*no transcript metadata/);
  });
});
