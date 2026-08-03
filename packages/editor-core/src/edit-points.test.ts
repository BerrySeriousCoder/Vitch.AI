import { describe, expect, it } from "vitest";
import { toolOk, toolErr } from "./tool-result";
import { listEditPoints, transitionSameTrackHint } from "./edit-points";
import type { Track } from "@tempo/types";

describe("tool-result", () => {
  it("formats ok with clipId", () => {
    const s = toolOk("Added text", { clipId: "c1", trackId: "t1" });
    expect(JSON.parse(s)).toEqual({
      ok: true,
      summary: "Added text",
      clipId: "c1",
      trackId: "t1",
    });
  });

  it("formats errors with fixHint", () => {
    const s = toolErr("Both clips must exist on the same track", {
      code: "DIFFERENT_TRACK",
      fixHint: "Use list_edit_points",
    });
    const j = JSON.parse(s);
    expect(j.ok).toBe(false);
    expect(j.fixHint).toContain("list_edit_points");
  });

  it("keeps reserved result fields authoritative", () => {
    const ok = JSON.parse(toolOk("Actual summary", { summary: "ignored", ok: false }));
    const err = JSON.parse(toolErr("Actual error", { error: "ignored", ok: true, summary: "Context" }));

    expect(ok).toMatchObject({ ok: true, summary: "Actual summary" });
    expect(err).toMatchObject({ ok: false, error: "Actual error", summary: "Context" });
  });
});

describe("listEditPoints", () => {
  const tracks: Track[] = [
    {
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
    },
    {
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
    },
  ];

  it("finds abutting video pair", () => {
    const pts = listEditPoints(tracks, { abuttingOnly: true });
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({
      clipAId: "a",
      clipBId: "b",
      trackId: "tv",
      abutting: true,
    });
  });

  it("hints when clips are on different tracks", () => {
    const hint = transitionSameTrackHint(tracks, "a", "title");
    expect(hint.clipLocations).toHaveLength(2);
    expect(hint.suggestedPairs[0]?.clipAId).toBe("a");
    expect(hint.fixHint).toMatch(/different tracks|list_edit_points/i);
  });
});
