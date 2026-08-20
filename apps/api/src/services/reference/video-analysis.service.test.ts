import { describe, expect, it } from "vitest";
import {
  bisectSceneGroupAtMidpoint,
  buildInlineVideoPart,
  estimateReferenceUsage,
  FULL_DETAIL_CHUNK_CONTEXT_SECONDS,
  FULL_DETAIL_CHUNK_MAX_SCENES,
  FULL_DETAIL_CHUNK_TARGET_SECONDS,
  FULL_DETAIL_FPS,
  FOCUSED_DETAIL_FPS,
  GLOBAL_CONTEXT_MAX_FRAMES,
  MAX_INLINE_VIDEO_BYTES,
  needsInlineVideoProxy,
  parseSceneResponse,
  planFullDetailAnalysisChunks,
  selectGlobalContextScenes,
} from "./video-analysis.service.js";
import { sanitizeSegmentData } from "./vision-analysis.service.js";
import type { SceneSegment } from "./scene-detection.service.js";

function scenesFromDurations(durations: number[]): SceneSegment[] {
  let cursor = 0;
  return durations.map((duration, index) => {
    const scene: SceneSegment = {
      index,
      startTime: cursor,
      endTime: cursor + duration,
      duration,
      thumbnailPath: `/scene-${index}.jpg`,
      framePaths: [`/scene-${index}.jpg`],
    };
    cursor += duration;
    return scene;
  });
}

describe("whole-video reference analysis helpers", () => {
  it("caps focused inspections at Gemini's supported 24 FPS", () => {
    expect(FULL_DETAIL_FPS).toBe(24);
    expect(FOCUSED_DETAIL_FPS).toBeLessThanOrEqual(24);
  });

  it("uses inline video parts and clamps Gemini sampling to 24 FPS", () => {
    const part = buildInlineVideoPart("encoded-video", 60, { startTime: 2.5, endTime: 4.75 });
    expect(part).toEqual({
      inlineData: { mimeType: "video/mp4", data: "encoded-video" },
      videoMetadata: { fps: 24, startOffset: "2.5s", endOffset: "4.75s" },
    });
    expect(part).not.toHaveProperty("fileData");
  });

  it("creates an analysis proxy only after the inline source budget is exceeded", () => {
    expect(needsInlineVideoProxy(MAX_INLINE_VIDEO_BYTES)).toBe(false);
    expect(needsInlineVideoProxy(MAX_INLINE_VIDEO_BYTES + 1)).toBe(true);
  });

  it("keeps the proven short-reference path on one unchanged full-detail request", () => {
    const scenes = scenesFromDurations(Array.from({ length: 18 }, () => 16.4 / 18));
    const chunks = planFullDetailAnalysisChunks(scenes, 16.4);
    expect(FULL_DETAIL_CHUNK_TARGET_SECONDS).toBe(30);
    expect(FULL_DETAIL_CHUNK_MAX_SCENES).toBe(20);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.scenes.map((scene) => scene.index)).toEqual(scenes.map((scene) => scene.index));
  });

  it("starts a 55-second reference as two balanced scene-boundary chunks", () => {
    const scenes = scenesFromDurations(Array.from({ length: 11 }, () => 5));
    const chunks = planFullDetailAnalysisChunks(scenes, 55);
    expect(chunks.map((chunk) => chunk.scenes.map((scene) => scene.index))).toEqual([
      [0, 1, 2, 3, 4],
      [5, 6, 7, 8, 9, 10],
    ]);
    expect(chunks[1]).toMatchObject({
      startTime: 25,
      endTime: 55,
      contextStartTime: 25 - FULL_DETAIL_CHUNK_CONTEXT_SECONDS,
      contextEndTime: 55,
    });
  });

  it("plans the observed 57-second eleven-scene reference as two initial requests", () => {
    const scenes = scenesFromDurations([4, 4, 4, 5.67, 8, 8.41, 4, 4, 4, 4.59, 6.337]);
    const chunks = planFullDetailAnalysisChunks(scenes, 57.007);
    expect(chunks).toHaveLength(2);
    expect(chunks.flatMap((chunk) => chunk.scenes.map((scene) => scene.index)))
      .toEqual(scenes.map((scene) => scene.index));
    expect(chunks[0]!.endTime).toBe(chunks[1]!.startTime);
    expect(chunks[0]!.endTime).toBeCloseTo(25.67, 3);
  });

  it("does not invent a cut inside one long detected scene", () => {
    const scenes = scenesFromDurations([27, 4, 4]);
    const chunks = planFullDetailAnalysisChunks(scenes, 35);
    expect(chunks[0]!.scenes.map((scene) => scene.index)).toEqual([0]);
    expect(chunks[0]!.startTime).toBe(0);
    expect(chunks[0]!.endTime).toBe(27);
  });

  it("adaptively bisects a failed range only at the closest detected scene boundary", () => {
    const scenes = scenesFromDurations([3, 4, 8, 2, 5]);
    const [left, right] = bisectSceneGroupAtMidpoint(scenes);
    expect(left.map((scene) => scene.index)).toEqual([0, 1]);
    expect(right.map((scene) => scene.index)).toEqual([2, 3, 4]);
    expect(left.at(-1)!.endTime).toBe(right[0]!.startTime);
  });

  it("also bounds response size when many short scenes fit inside the time limit", () => {
    const scenes = scenesFromDurations(Array.from({ length: 25 }, () => 0.5));
    const chunks = planFullDetailAnalysisChunks(scenes, 12.5);
    expect(chunks.map((chunk) => chunk.scenes.length)).toEqual([12, 13]);
    expect(chunks.every((chunk) => chunk.scenes.length <= FULL_DETAIL_CHUNK_MAX_SCENES)).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.scenes.map((scene) => scene.index))).toEqual(
      scenes.map((scene) => scene.index)
    );
  });

  it("recovers complete scene objects from a truncated provider response", () => {
    const raw = '{"scenes":[{"index":0,"visualDescription":"a {nested} string"},{"index":1,"composition":{"layers":[]}},{"index":2,"visualDescription":"unterminated';
    const parsed = parseSceneResponse(raw);
    expect(parsed.complete).toBe(false);
    expect(parsed.scenes).toEqual([
      { index: 0, visualDescription: "a {nested} string" },
      { index: 1, composition: { layers: [] } },
    ]);
    expect(parsed.error).toContain("JSON");
  });

  it("marks a valid provider response complete", () => {
    expect(parseSceneResponse('{"scenes":[{"index":4}]}')).toEqual({
      scenes: [{ index: 4 }],
      complete: true,
    });
  });

  it("rejects valid JSON which uses the wrong root response shape", () => {
    expect(parseSceneResponse('{"scene":{"index":10}}')).toEqual({
      scenes: [],
      complete: false,
      error: "Response contract requires a root scenes array",
    });
  });

  it("selects an ordered global storyboard spanning the complete reference", () => {
    const scenes = scenesFromDurations(Array.from({ length: 30 }, () => 1));
    const selected = selectGlobalContextScenes(scenes);
    expect(selected).toHaveLength(GLOBAL_CONTEXT_MAX_FRAMES);
    expect(selected[0]!.index).toBe(0);
    expect(selected.at(-1)!.index).toBe(29);
    expect(selected.map((scene) => scene.index)).toEqual(
      [...selected].sort((left, right) => left.index - right.index).map((scene) => scene.index)
    );
  });
  it("keeps exclusive text timing and full-frame background evidence", () => {
    const scene = sanitizeSegmentData({
      textOverlays: [{
        text: "ballu",
        style: "bold",
        position: "center",
        animation: "none",
        sequenceMode: "exclusive",
        sequenceGroupId: "escape-line",
        backgroundMode: "full-frame",
        appearance: {
          fontFamilyClass: "display",
          fontFamilyHint: "Bebas Neue",
          fontWidth: "condensed",
          color: "#ffffff",
          backgroundColor: "#000000",
          backgroundOpacity: 1,
        },
        timing: { startRatio: 0.1, endRatio: 0.2, confidence: 0.95 },
      }],
    });
    expect(scene.textOverlays[0]).toMatchObject({
      text: "ballu",
      sequenceMode: "exclusive",
      sequenceGroupId: "escape-line",
      backgroundMode: "full-frame",
      timing: { startRatio: 0.1, endRatio: 0.2 },
      appearance: {
        fontFamilyClass: "display",
        fontFamilyHint: "Bebas Neue",
        fontWidth: "condensed",
        color: "#FFFFFF",
        backgroundColor: "#000000",
        backgroundOpacity: 1,
      },
    });
  });

  it("preserves dense caption sequences and their phase indices beyond 24 states", () => {
    const rawOverlays = Array.from({ length: 40 }, (_, index) => ({
      text: `word-${index}`,
      style: "bold",
      position: "center",
      animation: "none",
      timing: { startRatio: index / 40, endRatio: (index + 1) / 40 },
    }));
    const scene = sanitizeSegmentData({
      textOverlays: rawOverlays,
      composition: {
        replaceBase: true,
        layers: [{
          id: "background", role: "background", contentDescription: "plate", zIndex: 0,
          timing: { startRatio: 0, endRatio: 1 }, viewport: { x: 0, y: 0, width: 1, height: 1 }, fit: "cover",
        }],
        phases: [{
          id: "captions", label: "dense captions", startRatio: 0, endRatio: 1,
          activeLayerIds: ["background"], activeTextOverlayIndices: Array.from({ length: 40 }, (_, index) => index),
        }],
      },
    });
    expect(scene.textOverlays).toHaveLength(40);
    expect(scene.composition?.phases?.[0]?.activeTextOverlayIndices).toHaveLength(40);
    expect(scene.composition?.phases?.[0]?.activeTextOverlayIndices.at(-1)).toBe(39);
  });

  it("reports token and transcription estimates separately", () => {
    const usage = estimateReferenceUsage({
      promptTokenCount: 17_500,
      candidatesTokenCount: 2_000,
      thoughtsTokenCount: 500,
      totalTokenCount: 20_000,
    }, 0.001224);
    expect(usage).toMatchObject({
      promptTokens: 17_500,
      outputTokens: 2_000,
      thinkingTokens: 500,
      estimatedInputUsd: 0.013125,
      estimatedOutputUsd: 0.009375,
      estimatedTranscriptionUsd: 0.001224,
      estimatedTotalUsd: 0.023724,
    });
  });

  it("retains measured matte, panel, and character-motion evidence", () => {
    const scene = sanitizeSegmentData({
      textOverlays: [{
        text: "MOUNTAIN",
        style: "kinetic",
        position: "center",
        animation: "characters reveal without moving the word",
        fillMode: "media-matte",
        animationSpec: {
          unit: "char",
          channels: [{
            property: "opacity",
            from: 0,
            to: 1,
            offsetRatio: 0.05,
            durationRatio: 0.1,
            staggerRatio: 0.04,
            easing: "linear",
          }],
          confidence: 0.95,
        },
      }],
      composition: {
        replaceBase: true,
        backgroundColor: "#000000",
        layers: [{
          id: "matte-fill",
          role: "matte-fill",
          contentDescription: "moving mountain footage",
          zIndex: 0,
          timing: { startRatio: 0, endRatio: 1 },
          viewport: { x: 0, y: 0, width: 1, height: 1 },
          fit: "cover",
          matteTextOverlayIndex: 0,
        }, {
          id: "panel-tr",
          role: "panel",
          contentDescription: "top right landscape panel",
          zIndex: 1,
          timing: { startRatio: 0.5, endRatio: 1 },
          viewport: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
          fit: "cover",
          motion: { keyframes: [
            { timeRatio: 0, viewport: { x: 0.99, y: 0, width: 0.01, height: 0.5 } },
            { timeRatio: 0.2, viewport: { x: 0.5, y: 0, width: 0.5, height: 0.5 } },
          ] },
        }],
      },
    });
    expect(scene.textOverlays[0]).toMatchObject({
      fillMode: "media-matte",
      animationSpec: { unit: "char", channels: [expect.objectContaining({ property: "opacity", staggerRatio: 0.04 })] },
    });
    expect(scene.composition).toMatchObject({
      replaceBase: true,
      backgroundColor: "#000000",
      layers: [
        expect.objectContaining({ id: "matte-fill", role: "matte-fill", matteTextOverlayIndex: 0 }),
        expect.objectContaining({ id: "panel-tr", viewport: { x: 0.5, y: 0, width: 0.5, height: 0.5 } }),
      ],
    });
  });

});
