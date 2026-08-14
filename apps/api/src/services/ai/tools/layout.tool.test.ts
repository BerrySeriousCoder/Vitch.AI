import { describe, expect, it } from "vitest";
import type { Track } from "@tempo/types";
import { createProjectState } from "./index.js";
import { layoutToolExecutors } from "./layout.tool.js";

function graphicTrack(): Track {
  return {
    id: "text",
    name: "Titles",
    type: "text",
    order: 1,
    locked: false,
    visible: true,
    solo: false,
    clips: [{
      id: "hero-title",
      trackId: "text",
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
        text: "Exact title",
        fontFamily: "Inter",
        fontSize: 72,
        fontWeight: "700",
        color: "#FFFFFF",
        textAlign: "center",
        lineHeight: 1.2,
      },
    }],
  };
}

describe("creative-director layout tools", () => {
  it("preserves exact pixel geometry for reference replication", () => {
    const state = createProjectState([graphicTrack()], undefined, {
      settings: {
        width: 1080,
        height: 1920,
        fps: 30,
        duration: 3,
        backgroundColor: "#000000",
        sampleRate: 44100,
      },
    });
    const output = layoutToolExecutors.set_graphic_layout!({
      clipId: "hero-title",
      mode: "absolute",
      x: 540,
      y: 420,
      width: 700,
      height: 120,
      safety: "none",
      overflow: "allow",
    }, state);

    expect(output.state.tracks[0]!.clips[0]!.layout).toMatchObject({
      mode: "absolute",
      x: 540,
      y: 420,
      width: 700,
      height: 120,
    });
    expect(JSON.parse(output.result).geometry.centerY).toBe(420);
  });

  it("reports platform chrome collisions in a reel", () => {
    const state = createProjectState([graphicTrack()], undefined, {
      settings: {
        width: 1080,
        height: 1920,
        fps: 30,
        duration: 3,
        backgroundColor: "#000000",
        sampleRate: 44100,
      },
    });
    const output = layoutToolExecutors.set_graphic_layout!({
      clipId: "hero-title",
      mode: "normalized",
      x: 0.92,
      y: 0.7,
      width: 0.16,
      height: 0.2,
      safety: "none",
      overflow: "warn",
    }, state);

    expect(JSON.parse(output.result).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "platform_ui_occlusion" })])
    );
  });
});
