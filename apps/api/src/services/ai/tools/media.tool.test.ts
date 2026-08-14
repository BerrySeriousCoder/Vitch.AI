import { describe, it, expect } from "vitest";
import type { MediaAsset } from "@tempo/types";
import { mediaToolExecutors } from "./media.tool.js";
import { createProjectState } from "./index.js";
import { formatMediaForPrompt } from "../../media/media-analysis.service.js";

function asset(partial: Partial<MediaAsset> & { id: string; name: string }): MediaAsset {
  return {
    projectId: "p1",
    type: "video",
    url: "/uploads/media/x.mp4",
    thumbnailUrl: null,
    proxyUrl: null,
    waveformUrl: null,
    duration: 5,
    status: "ready",
    createdAt: new Date().toISOString(),
    metadata: {
      fileSize: 1000,
      mimeType: "video/mp4",
      analysisStatus: "ready",
      analysis: {
        summary: "A sunny beach wide shot with waves",
        tags: ["beach", "sunset", "ocean"],
        subjects: ["waves"],
        shotType: "wide",
        mood: "calm",
        bestFor: ["B-roll", "open"],
        model: "gemini-3.1-flash-lite",
        analyzedAt: new Date().toISOString(),
      },
    },
    ...partial,
  };
}

describe("media tools", () => {
  it("lists media with analysis", async () => {
    const state = createProjectState([], undefined, {
      mediaAssets: [asset({ id: "m1", name: "beach.mp4" })],
    });
    const { result } = await mediaToolExecutors.list_media!({}, state);
    expect(result).toContain("m1");
    expect(result).toContain("beach");
    expect(result).toContain("wide");
  });

  it("searches by tag/mood", async () => {
    const state = createProjectState([], undefined, {
      mediaAssets: [
        asset({ id: "m1", name: "beach.mp4" }),
        asset({
          id: "m2",
          name: "city.mp4",
          metadata: {
            fileSize: 1,
            mimeType: "video/mp4",
            analysisStatus: "ready",
            analysis: {
              summary: "Night city traffic",
              tags: ["city", "night"],
              subjects: ["cars"],
              shotType: "medium",
              mood: "energetic",
              model: "test",
              analyzedAt: new Date().toISOString(),
            },
          },
        }),
      ],
    });
    const { result } = await mediaToolExecutors.search_media!(
      { query: "sunset beach" },
      state
    );
    expect(result).toContain("m1");
    expect(result).not.toContain("m2");
  });

  it("returns full analysis json", async () => {
    const state = createProjectState([], undefined, {
      mediaAssets: [asset({ id: "m1", name: "beach.mp4" })],
    });
    const { result } = await mediaToolExecutors.get_media_analysis!(
      { mediaId: "m1" },
      state
    );
    const parsed = JSON.parse(result);
    expect(parsed.analysis.shotType).toBe("wide");
    expect(parsed.analysisStatus).toBe("ready");
  });
});

describe("formatMediaForPrompt", () => {
  it("includes analysis fields when ready", () => {
    const line = formatMediaForPrompt(asset({ id: "m1", name: "beach.mp4" }));
    expect(line).toContain("summary:");
    expect(line).toContain("beach");
    expect(line).toContain("shot: wide");
  });

  it("includes skipped analysis summary", () => {
    const line = formatMediaForPrompt(
      asset({
        id: "m3",
        name: "x.mp4",
        metadata: {
          fileSize: 1,
          mimeType: "video/mp4",
          analysisStatus: "skipped",
          analysis: {
            summary: "Skipped stub",
            tags: [],
            subjects: [],
            model: "none",
            analyzedAt: new Date().toISOString(),
          },
        },
      })
    );
    expect(line).toContain("Skipped stub");
    expect(line).toContain("analysis: skipped");
  });
});
