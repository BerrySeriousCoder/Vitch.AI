import { describe, it, expect } from "vitest";
import type { Clip, Track, MediaAsset } from "@tempo/types";
import { transitionsToolExecutors } from "./transitions.tool.js";
import { createProjectState } from "./index.js";

function clip(partial: Partial<Clip> & { id: string; trackId: string }): Clip {
  return {
    sourceMediaId: "m1",
    startTime: 0,
    duration: 5,
    sourceOffset: 0,
    speed: 1,
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    blendMode: "normal",
    effects: [],
    keyframes: [],
    mask: null,
    muted: false,
    volume: 1,
    ...partial,
  };
}

function track(clips: Clip[]): Track {
  return {
    id: "t1",
    name: "V1",
    type: "video",
    order: 0,
    locked: false,
    visible: true,
    solo: false,
    clips,
  };
}

function asset(id: string, duration: number): MediaAsset {
  return {
    id,
    projectId: "p1",
    name: id,
    type: "video",
    url: "/uploads/x.mp4",
    thumbnailUrl: null,
    proxyUrl: null,
    waveformUrl: null,
    duration,
    status: "ready",
    createdAt: new Date().toISOString(),
    metadata: { fileSize: 1, mimeType: "video/mp4", duration },
  };
}

describe("transitions tools", () => {
  it("lists transition types", () => {
    const state = createProjectState([]);
    const { result } = transitionsToolExecutors.list_transitions!({}, state);
    const parsed = JSON.parse(result);
    expect(parsed.types.some((t: { type: string }) => t.type === "crossfade")).toBe(
      true
    );
  });

  it("add_transition mutates tracks and transitions", () => {
    const state = createProjectState(
      [
        track([
          clip({
            id: "a",
            trackId: "t1",
            sourceMediaId: "m1",
            startTime: 0,
            duration: 5,
            sourceOffset: 0,
          }),
          clip({
            id: "b",
            trackId: "t1",
            sourceMediaId: "m2",
            startTime: 5,
            duration: 5,
            sourceOffset: 2,
          }),
        ]),
      ],
      undefined,
      {
        mediaAssets: [asset("m1", 30), asset("m2", 30)],
      }
    );

    const { result, state: next } = transitionsToolExecutors.add_transition!(
      { clipAId: "a", clipBId: "b", type: "crossfade", duration: 1 },
      state
    );
    expect(result).toMatch(/Added crossfade/);
    expect(next.transitions).toHaveLength(1);
    expect(next.tracks[0]!.clips.find((c) => c.id === "a")!.duration).toBe(6);
  });

  it.each([
    ["fade", "crossfade"],
    ["dissolve", "crossfade"],
    ["swipe", "wipe"],
  ])("normalizes the friendly %s alias to %s", (alias, canonical) => {
    const state = createProjectState(
      [
        track([
          clip({ id: "a", trackId: "t1", sourceMediaId: "m1", startTime: 0, duration: 5, sourceOffset: 0 }),
          clip({ id: "b", trackId: "t1", sourceMediaId: "m2", startTime: 5, duration: 5, sourceOffset: 2 }),
        ]),
      ],
      undefined,
      { mediaAssets: [asset("m1", 30), asset("m2", 30)] }
    );

    const { result, state: next } = transitionsToolExecutors.add_transition!(
      { clipAId: "a", clipBId: "b", type: alias, duration: 0.5 },
      state
    );

    expect(JSON.parse(result)).toMatchObject({ ok: true });
    expect(next.transitions?.[0]?.type).toBe(canonical);
  });

  it("treats an equivalent friendly alias as an idempotent success", () => {
    const state = createProjectState(
      [
        track([
          clip({ id: "a", trackId: "t1", sourceMediaId: "m1", startTime: 0, duration: 5.5, sourceOffset: 0 }),
          clip({ id: "b", trackId: "t1", sourceMediaId: "m2", startTime: 5, duration: 5, sourceOffset: 2 }),
        ]),
      ],
      undefined,
      {
        mediaAssets: [asset("m1", 30), asset("m2", 30)],
        transitions: [
          { id: "tx-existing", trackId: "t1", clipAId: "a", clipBId: "b", type: "crossfade", duration: 0.5, params: {} },
        ],
      }
    );

    const { result, state: next } = transitionsToolExecutors.add_transition!(
      { clipAId: "a", clipBId: "b", type: "fade", duration: 0.5 },
      state
    );

    expect(JSON.parse(result)).toMatchObject({
      ok: true,
      transitionId: "tx-existing",
      alreadyExists: true,
    });
    expect(next.transitions).toHaveLength(1);
  });

  it("adds wipe without hardcoded enum rejection", () => {
    const state = createProjectState(
      [
        track([
          clip({
            id: "a",
            trackId: "t1",
            sourceMediaId: "m1",
            startTime: 0,
            duration: 5,
            sourceOffset: 0,
          }),
          clip({
            id: "b",
            trackId: "t1",
            sourceMediaId: "m2",
            startTime: 5,
            duration: 5,
            sourceOffset: 0,
          }),
        ]),
      ],
      undefined,
      { mediaAssets: [asset("m1", 30), asset("m2", 30)] }
    );

    const { result, state: next } = transitionsToolExecutors.add_transition!(
      {
        clipAId: "a",
        clipBId: "b",
        type: "wipe",
        duration: 0.5,
        direction: "right",
        softness: 0.12,
      },
      state
    );
    expect(result).toMatch(/Added wipe/);
    expect(next.transitions).toHaveLength(1);
    expect(next.transitions![0]!.type).toBe("wipe");
    expect(next.transitions![0]!.params.direction).toBe("right");
    expect(next.transitions![0]!.params.softness).toBe(0.12);
  });

  it("refuses insufficient handles", () => {
    const state = createProjectState(
      [
        track([
          clip({
            id: "a",
            trackId: "t1",
            sourceMediaId: "m1",
            startTime: 0,
            duration: 5,
            sourceOffset: 28, // almost no tail on 30s media
          }),
          clip({
            id: "b",
            trackId: "t1",
            sourceMediaId: "m2",
            startTime: 5,
            duration: 5,
            sourceOffset: 0,
          }),
        ]),
      ],
      undefined,
      { mediaAssets: [asset("m1", 30), asset("m2", 30)] }
    );
    const { result } = transitionsToolExecutors.add_transition!(
      { clipAId: "a", clipBId: "b", type: "crossfade", duration: 1 },
      state
    );
    expect(JSON.parse(result)).toMatchObject({ ok: false, code: "TRANSITION_APPLY_FAILED" });
  });
});
