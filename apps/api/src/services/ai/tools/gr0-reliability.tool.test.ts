import { describe, expect, it } from "vitest";
import { motionGraphicsToolExecutors } from "./motion-graphics.tool.js";
import { transitionsToolExecutors } from "./transitions.tool.js";
import type { ProjectState } from "./project-state.js";
import { DEFAULT_AUDIO_MIXER } from "./project-state.js";
import type { Track } from "@tempo/types";

function emptyState(tracks: Track[] = []): ProjectState {
  return {
    tracks,
    audioMixer: { ...DEFAULT_AUDIO_MIXER },
    transitions: [],
    sequences: [],
  };
}

describe("G-R0 structured creates + edit points", () => {
  it("add_text_clip returns JSON clipId and accepts fontId", async () => {
    const state = emptyState();
    const { result, state: next } = await motionGraphicsToolExecutors.add_text_clip!(
      {
        text: "AD",
        startTime: 0,
        duration: 2,
        fontId: "google:Oswald",
        shadow: "2px 2px 4px rgba(0,0,0,0.5)",
      },
      state
    );
    const json = JSON.parse(result);
    expect(json.ok).toBe(true);
    expect(json.clipId).toMatch(
      /^[0-9a-f-]{36}$/i
    );
    const clip = next.tracks[0]!.clips[0]!;
    expect(clip.id).toBe(json.clipId);
    expect(clip.textParams?.fontId).toBe("google:Oswald");
    expect(clip.textParams?.shadow).toContain("rgba");
  });

  it("list_edit_points + add_transition recovery on cross-track", () => {
    const video: Track = {
      id: "tv",
      name: "V1",
      type: "video",
      order: 0,
      locked: false,
      visible: true,
      solo: false,
      clips: [
        {
          id: "a",
          trackId: "tv",
          sourceMediaId: "m1",
          startTime: 0,
          duration: 2,
          sourceOffset: 0,
          speed: 1,
          transform: {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotation: 0,
            anchorX: 0,
            anchorY: 0,
          },
          opacity: 1,
          blendMode: "normal",
          effects: [],
          keyframes: [],
          mask: null,
          muted: false,
          volume: 1,
        },
        {
          id: "b",
          trackId: "tv",
          sourceMediaId: "m2",
          startTime: 2,
          duration: 2,
          sourceOffset: 0,
          speed: 1,
          transform: {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotation: 0,
            anchorX: 0,
            anchorY: 0,
          },
          opacity: 1,
          blendMode: "normal",
          effects: [],
          keyframes: [],
          mask: null,
          muted: false,
          volume: 1,
        },
      ],
    };
    const text: Track = {
      id: "tt",
      name: "Text",
      type: "text",
      order: 1,
      locked: false,
      visible: true,
      solo: false,
      clips: [
        {
          id: "title",
          trackId: "tt",
          sourceMediaId: null,
          startTime: 0,
          duration: 3,
          sourceOffset: 0,
          speed: 1,
          transform: {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotation: 0,
            anchorX: 0,
            anchorY: 0,
          },
          opacity: 1,
          blendMode: "normal",
          effects: [],
          keyframes: [],
          mask: null,
          muted: false,
          volume: 1,
          textParams: {
            text: "Hi",
            fontFamily: "Inter",
            fontSize: 48,
            fontWeight: "600",
            color: "#fff",
            textAlign: "center",
            lineHeight: 1.3,
          },
        },
      ],
    };
    const state = emptyState([video, text]);
    state.mediaAssets = [
      {
        id: "m1",
        projectId: "p",
        name: "a",
        type: "video",
        url: "/a",
        duration: 10,
        metadata: { duration: 10 },
        status: "ready",
        createdAt: new Date().toISOString(),
      } as any,
      {
        id: "m2",
        projectId: "p",
        name: "b",
        type: "video",
        url: "/b",
        duration: 10,
        metadata: { duration: 10 },
        status: "ready",
        createdAt: new Date().toISOString(),
      } as any,
    ];

    const listed = transitionsToolExecutors.list_edit_points!(
      { abuttingOnly: true },
      state
    );
    const pts = JSON.parse(listed.result);
    expect(pts.editPoints[0]).toMatchObject({
      clipAId: "a",
      clipBId: "b",
      trackId: "tv",
    });

    const bad = transitionsToolExecutors.add_transition!(
      { clipAId: "a", clipBId: "title", type: "dip-black" },
      state
    );
    const err = JSON.parse(bad.result);
    expect(err.ok).toBe(false);
    expect(err.suggestedPairs?.[0]?.clipAId).toBe("a");
    expect(err.fixHint).toMatch(/list_edit_points|different tracks/i);
  });
});
