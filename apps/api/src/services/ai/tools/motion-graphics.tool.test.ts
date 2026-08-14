import { describe, expect, it } from "vitest";
import type { Track } from "@tempo/types";
import { createProjectState } from "./index.js";
import { motionGraphicsToolExecutors } from "./motion-graphics.tool.js";

function textTrack(): Track {
  return {
    id: "text-1",
    name: "Text",
    type: "text",
    order: 0,
    locked: false,
    visible: true,
    solo: false,
    clips: [{
      id: "title-1",
      trackId: "text-1",
      sourceMediaId: null,
      startTime: 0,
      duration: 3,
      sourceOffset: 0,
      speed: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: false,
      volume: 1,
      textParams: {
        text: "Make it hit",
        fontFamily: "Inter",
        fontSize: 48,
        fontWeight: "600",
        color: "#FFFFFF",
        textAlign: "center",
        lineHeight: 1.3,
      },
    }],
  };
}

function shapeTrack(): Track {
  return {
    id: "shape-1",
    name: "Shapes",
    type: "shape",
    order: 0,
    locked: false,
    visible: true,
    solo: false,
    clips: [{
      id: "shape-clip-1",
      trackId: "shape-1",
      sourceMediaId: null,
      startTime: 0,
      duration: 3,
      sourceOffset: 0,
      speed: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: false,
      volume: 1,
      shapeParams: {
        shape: "rect",
        fill: "#3B82F6",
        stroke: "transparent",
        strokeWidth: 0,
        width: 200,
        height: 200,
      },
    }],
  };
}

describe("motion graphics tools", () => {
  it("sets a scoped rotation and fill-color animator stack", async () => {
    const state = createProjectState([textTrack()]);
    const output = await motionGraphicsToolExecutors.set_text_animators!(
      {
        clipId: "title-1",
        split: "word",
        animators: [
          {
            property: "rotation",
            offsetSec: 0,
            durationSec: 0.2,
            staggerSec: 0.08,
            from: -12,
            to: 0,
            ease: "ease-out",
            range: [1, 3],
          },
          {
            property: "color",
            offsetSec: 0,
            durationSec: 0.2,
            staggerSec: 0.08,
            fromColor: "#ff00aa",
            toColor: "#ffffff",
            ease: "ease-out",
          },
        ],
      },
      state
    );

    expect(output.result).toMatch(/Updated kinetic animators/);
    const params = output.state.tracks[0]!.clips[0]!.textParams!;
    expect(params.split).toBe("word");
    expect(params.animators?.[0]?.range).toEqual([1, 3]);
    expect(params.animators?.[1]?.fromColor).toBe("#FF00AA");
  });

  it("rejects color animators without valid hex endpoints", async () => {
    const state = createProjectState([textTrack()]);
    const output = await motionGraphicsToolExecutors.set_text_animators!(
      {
        clipId: "title-1",
        animators: [{ property: "color", fromColor: "pink", toColor: "#FFFFFF" }],
      },
      state
    );
    expect(output.result).toMatch(/INVALID_ANIMATORS/);
  });

  it("keeps advanced graphic paint controls on a text layer", async () => {
    const state = createProjectState([textTrack()]);
    const output = await motionGraphicsToolExecutors.update_text_clip!(
      {
        clipId: "title-1",
        fillGradient: { type: "linear", from: "#FFFFFF", to: "#7C3AED", angle: 35 },
        fillEnabled: false,
        shadowStyle: { color: "#000000", offsetX: 4, offsetY: 6, blur: 12, opacity: 0.6 },
        glow: { color: "#A855F7", blur: 18, opacity: 0.75 },
      },
      state
    );
    expect(output.result).toMatch(/fillGradient/);
    expect(output.state.tracks[0]!.clips[0]!.textParams).toMatchObject({
      fillEnabled: false,
      fillGradient: { type: "linear", to: "#7C3AED" },
      glow: { blur: 18 },
    });
  });

  it("stores ordered rich-text runs on a single graphic text layer", async () => {
    const state = createProjectState([textTrack()]);
    const output = await motionGraphicsToolExecutors.update_text_clip!(
      { clipId: "title-1", richTextRuns: [
        { text: "MAKE ", color: "#FFFFFF", fontWeight: "900" },
        { text: "IT", color: "#F97316", italic: true, underline: true },
      ] },
      state
    );
    expect(output.result).toMatch(/richTextRuns/);
    expect(output.state.tracks[0]!.clips[0]!.textParams!.richTextRuns).toHaveLength(2);
  });

  it("rejects an unknown font without partially applying the text patch", async () => {
    const state = createProjectState([textTrack()]);
    const before = structuredClone(state.tracks[0]!.clips[0]!.textParams);
    const output = await motionGraphicsToolExecutors.update_text_clip!(
      { clipId: "title-1", color: "#FF0000", fontId: "google:DefinitelyMissing" },
      state
    );

    expect(output.result).toMatch(/UNKNOWN_FONT/);
    expect(output.state.tracks[0]!.clips[0]!.textParams).toEqual(before);
  });

  it("does not leave an orphan track when text creation validation fails", async () => {
    const state = createProjectState([]);
    const badFont = await motionGraphicsToolExecutors.add_text_clip!(
      { text: "Title", startTime: 0, duration: 2, fontId: "google:DefinitelyMissing" },
      state
    );
    expect(badFont.result).toMatch(/UNKNOWN_FONT/);
    expect(badFont.state.tracks).toEqual([]);

    const badPaint = await motionGraphicsToolExecutors.add_text_clip!(
      { text: "Title", startTime: 0, duration: 2, fillGradient: { type: "linear", from: "bad", to: "#FFFFFF" } },
      state
    );
    expect(badPaint.result).toMatch(/INVALID_TEXT/);
    expect(badPaint.state.tracks).toEqual([]);
  });

  it("validates and stores advanced shape styling", async () => {
    const state = createProjectState([shapeTrack()]);
    const output = await motionGraphicsToolExecutors.update_shape_clip!(
      {
        clipId: "shape-clip-1",
        shape: "star",
        points: 7,
        innerRadius: 0.35,
        fillGradient: { type: "radial", from: "#FFFFFF", to: "#7C3AED" },
        shadow: { color: "#000000", offsetX: 3, offsetY: 8, blur: 18, opacity: 0.5 },
        glow: { color: "#A855F7", blur: 24, opacity: 0.7 },
      },
      state
    );

    expect(output.result).toMatch(/Updated shape clip/);
    expect(output.state.tracks[0]!.clips[0]!.shapeParams).toMatchObject({
      shape: "star",
      points: 7,
      innerRadius: 0.35,
      fillGradient: { type: "radial", to: "#7C3AED" },
      glow: { blur: 24 },
    });
  });

  it("creates arbitrary cubic vector paths for alpha track mattes", async () => {
    const state = createProjectState([shapeTrack()]);
    const output = await motionGraphicsToolExecutors.add_shape_clip!({
      trackId: "shape-1",
      shape: "path",
      startTime: 0,
      duration: 2,
      width: 800,
      height: 500,
      fill: "#FFFFFF",
      pathClosed: true,
      pathPoints: [
        { x: 0.05, y: 0.8, outX: 0.2, outY: 0.2 },
        { x: 0.5, y: 0.1, inX: 0.3, inY: 0.1, outX: 0.7, outY: 0.1 },
        { x: 0.95, y: 0.8, inX: 0.8, inY: 0.2 },
      ],
    }, state);
    expect(output.result).toContain('"ok":true');
    expect(output.state.tracks[0]!.clips[1]!.shapeParams).toMatchObject({
      shape: "path",
      pathClosed: true,
      pathPoints: [{ x: 0.05, y: 0.8 }, { x: 0.5, y: 0.1 }, { x: 0.95, y: 0.8 }],
    });
  });

  it("rejects incomplete vector handles without creating a path", async () => {
    const state = createProjectState([shapeTrack()]);
    const output = await motionGraphicsToolExecutors.add_shape_clip!({
      trackId: "shape-1",
      shape: "path",
      startTime: 0,
      duration: 2,
      pathPoints: [{ x: 0, y: 0, outX: 0.2 }, { x: 1, y: 1 }],
    }, state);
    expect(output.result).toMatch(/INVALID_SHAPE/);
    expect(output.state.tracks[0]!.clips).toHaveLength(1);
  });

  it("rejects invalid shape paint atomically", async () => {
    const state = createProjectState([shapeTrack()]);
    const before = structuredClone(state.tracks[0]!.clips[0]!.shapeParams);
    const output = await motionGraphicsToolExecutors.update_shape_clip!(
      {
        clipId: "shape-clip-1",
        width: 320,
        points: 2.5,
        fillGradient: { type: "linear", from: "not-a-color", to: "#FFFFFF" },
      },
      state
    );

    expect(output.result).toMatch(/INVALID_SHAPE/);
    expect(output.state.tracks[0]!.clips[0]!.shapeParams).toEqual(before);
  });

  it("rejects invalid shape timing and incompatible tracks without creating a clip", async () => {
    const state = createProjectState([textTrack()]);
    const invalidTiming = await motionGraphicsToolExecutors.add_shape_clip!(
      { shape: "rect", startTime: -1, duration: 2 },
      state
    );
    expect(invalidTiming.result).toMatch(/INVALID_SHAPE/);
    expect(invalidTiming.state.tracks).toHaveLength(1);

    const wrongTrack = await motionGraphicsToolExecutors.add_shape_clip!(
      { trackId: "text-1", shape: "rect", startTime: 0, duration: 2 },
      state
    );
    expect(wrongTrack.result).toMatch(/WRONG_TRACK_TYPE/);
    expect(wrongTrack.state.tracks[0]!.clips).toHaveLength(1);
  });
});
