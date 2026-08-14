import { describe, expect, it } from "vitest";
import type { Track, Transition } from "@tempo/types";
import { timelineToolExecutors } from "./timeline.tool.js";
import type { ProjectState } from "./project-state.js";

function clip(
  id: string,
  startTime: number,
  duration: number,
  extras: Record<string, unknown> = {}
) {
  return {
    id,
    trackId: "t1",
    sourceMediaId: "m1",
    startTime,
    duration,
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
    blendMode: "normal" as const,
    effects: [],
    keyframes: [],
    mask: null,
    muted: false,
    volume: 1,
    ...extras,
  };
}

function baseState(transitions: Transition[] = []): ProjectState {
  const tracks: Track[] = [
    {
      id: "t1",
      name: "V1",
      type: "video",
      order: 0,
      locked: false,
      visible: true,
      solo: false,
      clips: [
        clip("a", 0, 2),
        clip("b", 2, 2),
        clip("c", 4, 2),
      ],
    },
  ];
  return { tracks, transitions, audioMixer: { masterVolume: 1, tracks: {} } as any };
}

function addBoundCaption(state: ReturnType<typeof baseState>, sourceClipId: string, sourceStart = 0.5, sourceEnd = 1) {
  let track = state.tracks.find((candidate) => candidate.id === "captions");
  if (!track) {
    track = {
      id: "captions",
      name: "Captions",
      type: "text",
      order: state.tracks.length,
      locked: false,
      visible: true,
      solo: false,
      clips: [],
    };
    state.tracks.push(track);
  }
  track.clips.push(clip(`caption-${sourceClipId}`, sourceStart, sourceEnd - sourceStart, {
    trackId: "captions",
    sourceMediaId: null,
    captionBinding: {
      sourceClipId,
      sourceMediaId: "m1",
      transcriptRevision: "r1",
      sourceStart,
      sourceEnd,
    },
  }));
}

describe("timeline edit tools", () => {
  it("rejects add_clip when speed-adjusted source consumption exceeds media", () => {
    const state = baseState();
    state.tracks[0]!.clips = [];
    state.mediaAssets = [{
      id: "m1",
      projectId: "p1",
      name: "short.mp4",
      type: "video",
      url: "/uploads/short.mp4",
      thumbnailUrl: null,
      proxyUrl: null,
      waveformUrl: null,
      duration: 5,
      metadata: { fileSize: 1, mimeType: "video/mp4" },
      status: "ready",
      createdAt: "2026-08-11T00:00:00.000Z",
    }];
    const out = timelineToolExecutors.add_clip!(
      { trackId: "t1", sourceMediaId: "m1", startTime: 0, duration: 3, sourceOffset: 1, speed: 2 },
      state
    );
    expect(JSON.parse(out.result)).toMatchObject({ ok: false, code: "SOURCE_RANGE_OVERRUN" });
    expect(out.state.tracks[0]!.clips).toHaveLength(0);
  });

  it("preserves aspect ratio with cover and warns on portrait/landscape mismatch", () => {
    const state = baseState();
    state.settings = {
      width: 1080,
      height: 1920,
      fps: 30,
      duration: 10,
      backgroundColor: "#000000",
      sampleRate: 44100,
    };
    state.tracks[0]!.clips = [];
    state.mediaAssets = [{
      id: "wide",
      projectId: "p1",
      name: "wide.mp4",
      type: "video",
      url: "/uploads/wide.mp4",
      thumbnailUrl: null,
      proxyUrl: null,
      waveformUrl: null,
      duration: 5,
      metadata: { fileSize: 1, mimeType: "video/mp4", displayWidth: 1920, displayHeight: 1080 },
      status: "ready",
      createdAt: "2026-08-11T00:00:00.000Z",
    }];
    const out = timelineToolExecutors.add_clip!(
      { trackId: "t1", sourceMediaId: "wide", startTime: 0, duration: 2 },
      state
    );
    expect(out.state.tracks[0]!.clips[0]!.mediaLayout?.fit).toBe("cover");
    expect(JSON.parse(out.result)).toMatchObject({
      ok: true,
      sourceOrientation: "landscape",
      targetOrientation: "portrait",
      fit: "cover",
    });
    expect(JSON.parse(out.result).warning).toMatch(/may remove substantial frame area/);
  });

  it("ripple_delete_clip pulls C and strips TX", () => {
    const transitions: Transition[] = [
      {
        id: "tx1",
        trackId: "t1",
        clipAId: "a",
        clipBId: "b",
        duration: 0.4,
        type: "crossfade",
        params: {},
      },
    ];
    const out = timelineToolExecutors.ripple_delete_clip!(
      { clipId: "b" },
      baseState(transitions)
    );
    expect(out.result).not.toMatch(/^Error/);
    expect(out.state.tracks[0]!.clips.map((c) => c.id)).toEqual(["a", "c"]);
    expect(out.state.tracks[0]!.clips.find((c) => c.id === "c")!.startTime).toBeCloseTo(2);
    expect(out.state.transitions?.find((t) => t.id === "tx1")).toBeUndefined();
  });

  it("delete_clip leaves gap but removes TX", () => {
    const transitions: Transition[] = [
      {
        id: "tx1",
        trackId: "t1",
        clipAId: "a",
        clipBId: "b",
        duration: 0.4,
        type: "crossfade",
        params: {},
      },
    ];
    const out = timelineToolExecutors.delete_clip!(
      { clipId: "b" },
      baseState(transitions)
    );
    expect(out.result).not.toMatch(/^Error/);
    expect(out.state.tracks[0]!.clips.map((c) => c.id)).toEqual(["a", "c"]);
    expect(out.state.tracks[0]!.clips.find((c) => c.id === "c")!.startTime).toBe(4);
    expect(out.state.transitions?.length ?? 0).toBe(0);
  });

  it("close_gap tightens spaced clips", () => {
    const state = baseState();
    state.tracks[0]!.clips = [clip("a", 0, 2), clip("b", 5, 2)];
    const out = timelineToolExecutors.close_gap!({ trackId: "t1" }, state);
    expect(out.result).not.toMatch(/^Error/);
    expect(out.state.tracks[0]!.clips.find((c) => c.id === "b")!.startTime).toBeCloseTo(2);
  });

  it("replace_clip_media clamps short media", () => {
    const state = baseState();
    state.tracks[0]!.clips = [
      clip("a", 0, 5, { sourceOffset: 10, sourceMediaId: "m1" }),
    ];
    state.mediaAssets = [
      {
        id: "m2",
        projectId: "p",
        name: "short",
        type: "video",
        url: "/x",
        duration: 6,
        metadata: {},
        createdAt: new Date().toISOString(),
      } as any,
    ];
    const out = timelineToolExecutors.replace_clip_media!(
      {
        clipId: "a",
        sourceMediaId: "m2",
        fit: "keep-duration",
        sourceOffset: 10,
      },
      state
    );
    expect(out.result).not.toMatch(/^Error/);
    const c = out.state.tracks[0]!.clips[0]!;
    expect(c.sourceMediaId).toBe("m2");
    expect(c.duration).toBe(5);
    expect(c.sourceOffset).toBeCloseTo(1);
  });

  it("keeps reference-bound phase clips replaceable in place", () => {
    const state = baseState();
    const binding = {
      blueprintId: "bp",
      kind: "composition-layer" as const,
      segmentIndex: 0,
      layerId: "matte-0",
      expectedStartTime: 0,
      expectedDuration: 2,
    };
    state.tracks[0] = {
      ...state.tracks[0]!,
      name: "Reference Layer 0:matte-0",
      clips: [
        clip("phase-a", 0, 1.5, { referenceEditBinding: binding }),
        clip("phase-b", 1, 1.5, { referenceEditBinding: { ...binding, layerId: "matte-0" } }),
      ],
    };
    state.mediaAssets = [{ id: "m2", duration: 10, metadata: {} } as any];
    const out = timelineToolExecutors.replace_clip_media!({
      clipId: "phase-a",
      sourceMediaId: "m2",
      fit: "fit-media",
      sourceOffset: 2,
    }, state);
    expect(out.result).not.toMatch(/^Error/);
    expect(out.state.tracks[0]!.clips[0]!.duration).toBe(1.5);
    expect(out.state.tracks[0]!.clips[0]!.startTime).toBe(0);
  });

  it("refuses destructive deletes of reference-bound clips", () => {
    const state = baseState();
    state.tracks[0]!.clips[0]!.referenceEditBinding = {
      blueprintId: "bp",
      kind: "composition-layer",
      segmentIndex: 0,
      layerId: "matte-0",
      expectedStartTime: 0,
      expectedDuration: 2,
    };
    const out = timelineToolExecutors.delete_clip!({ clipId: "a" }, state);
    expect(out.result).toMatch(/reference-bound/);
    expect(out.state.tracks[0]!.clips).toHaveLength(3);
  });

  it("locks generated reference tracks even when provenance is missing", () => {
    const state = baseState();
    state.tracks[0] = { ...state.tracks[0]!, name: "Reference Layer 0:matte-0" };
    const out = timelineToolExecutors.delete_clip!({ clipId: "a" }, state);
    expect(out.result).toMatch(/reference-bound/);
    expect(out.state.tracks[0]!.clips).toHaveLength(3);
  });

  it("re-syncs bound captions after a slip edit", () => {
    const state = baseState();
    addBoundCaption(state, "a");
    state.mediaAssets = [{ id: "m1", duration: 10, metadata: {} } as any];

    const out = timelineToolExecutors.slip_edit!({ clipId: "a", deltaSourceSec: 0.25 }, state);
    expect(out.result).not.toMatch(/^Error/);
    const caption = out.state.tracks.find((track) => track.id === "captions")!.clips[0]!;
    expect(caption.startTime).toBeCloseTo(0.25);
    expect(caption.duration).toBeCloseTo(0.5);
    expect(caption.captionBinding?.stale).toBe(false);
  });

  it("removing a track removes its transitions and stales captions bound to its sources", () => {
    const state = baseState([{ id: "tx", trackId: "t1", clipAId: "a", clipBId: "b", duration: 0.2, type: "crossfade", params: {} }]);
    addBoundCaption(state, "a");

    const out = timelineToolExecutors.remove_track!({ trackId: "t1" }, state);
    expect(out.result).not.toMatch(/^Error/);
    expect(out.state.transitions).toEqual([]);
    expect(out.state.tracks).toHaveLength(1);
    expect(out.state.tracks[0]!.clips[0]!.captionBinding?.stale).toBe(true);
  });

  it("linked ripple delete stales removed bindings and re-syncs shifted followers", () => {
    const state = baseState();
    state.tracks[0]!.clips = [
      clip("a", 0, 2, { linkGroupId: "g" }),
      clip("follower", 2, 2),
    ];
    state.tracks.push({
      id: "audio",
      name: "A1",
      type: "audio",
      order: 1,
      locked: false,
      visible: true,
      solo: false,
      clips: [clip("audio-a", 0, 2, { trackId: "audio", linkGroupId: "g" })],
    });
    addBoundCaption(state, "a");
    addBoundCaption(state, "follower", 0.5, 1);

    const out = timelineToolExecutors.ripple_delete_linked_group!({ clipId: "a" }, state);
    expect(out.result).not.toMatch(/^Error/);
    const captions = out.state.tracks.find((track) => track.id === "captions")!.clips;
    expect(captions.find((caption) => caption.captionBinding?.sourceClipId === "a")!.captionBinding?.stale).toBe(true);
    expect(captions.find((caption) => caption.captionBinding?.sourceClipId === "follower")!.startTime).toBeCloseTo(0.5);
  });

  it("source_edit ripples linked A/V and its bound captions through the agent surface", () => {
    const state = baseState();
    state.tracks[0]!.clips = [clip("linked-video", 2, 2, { linkGroupId: "g" })];
    state.tracks.push({
      id: "audio",
      name: "A1",
      type: "audio",
      order: 1,
      locked: false,
      visible: true,
      solo: false,
      clips: [clip("linked-audio", 2, 2, { trackId: "audio", linkGroupId: "g" })],
    });
    addBoundCaption(state, "linked-video", 0.5, 1);

    const out = timelineToolExecutors.source_edit!({
      trackId: "t1",
      sourceMediaId: "new-media",
      startTime: 2,
      duration: 1,
      sourceOffset: 0,
      mode: "insert",
    }, state);

    expect(out.result).not.toMatch(/^Error/);
    expect(out.state.tracks[0]!.clips.find((item) => item.id === "linked-video")!.startTime).toBe(3);
    expect(out.state.tracks[1]!.clips.find((item) => item.id === "linked-audio")!.startTime).toBe(3);
    expect(out.state.tracks.find((track) => track.id === "captions")!.clips[0]!.startTime).toBeCloseTo(3.5);
  });

  it("moves linked A/V together and clears transitions invalidated by the move", () => {
    const state = baseState([{ id: "tx", trackId: "t1", clipAId: "a", clipBId: "b", duration: 0.2, type: "crossfade", params: {} }]);
    state.tracks[0]!.clips.find((candidate) => candidate.id === "a")!.linkGroupId = "linked";
    state.tracks.push({
      id: "audio",
      name: "A1",
      type: "audio",
      order: 1,
      locked: false,
      visible: true,
      solo: false,
      clips: [clip("audio-a", 0, 2, { trackId: "audio", linkGroupId: "linked" })],
    });

    const out = timelineToolExecutors.move_clip!({ clipId: "a", newStartTime: 3 }, state);

    expect(out.result).not.toMatch(/^Error/);
    expect(out.state.tracks[0]!.clips.find((candidate) => candidate.id === "a")!.startTime).toBe(3);
    expect(out.state.tracks[1]!.clips[0]!.startTime).toBe(3);
    expect(out.state.transitions).toEqual([]);
  });

  it("trims and splits every linked member with a fresh right-side link group", () => {
    const state = baseState();
    state.tracks[0]!.clips = [clip("a", 1, 4, { sourceOffset: 1, linkGroupId: "linked" })];
    state.tracks.push({
      id: "audio",
      name: "A1",
      type: "audio",
      order: 1,
      locked: false,
      visible: true,
      solo: false,
      clips: [clip("audio-a", 1, 4, { trackId: "audio", sourceOffset: 1, linkGroupId: "linked" })],
    });

    const trimmed = timelineToolExecutors.trim_clip!({ clipId: "a", startTime: 1.5, duration: 3 }, state);
    expect(trimmed.result).not.toMatch(/^Error/);
    expect(trimmed.state.tracks[0]!.clips[0]).toMatchObject({ startTime: 1.5, duration: 3, sourceOffset: 1.5 });
    expect(trimmed.state.tracks[1]!.clips[0]).toMatchObject({ startTime: 1.5, duration: 3, sourceOffset: 1.5 });

    const split = timelineToolExecutors.split_clip!({ clipId: "a", time: 3 }, trimmed.state);
    expect(split.result).not.toMatch(/^Error/);
    expect(split.state.tracks[0]!.clips).toHaveLength(2);
    expect(split.state.tracks[1]!.clips).toHaveLength(2);
    const videoRight = split.state.tracks[0]!.clips.find((candidate) => candidate.id !== "a")!;
    const audioRight = split.state.tracks[1]!.clips.find((candidate) => candidate.id !== "audio-a")!;
    expect(videoRight.linkGroupId).toBe(audioRight.linkGroupId);
    expect(videoRight.linkGroupId).not.toBe("linked");
    expect(videoRight.sourceOffset).toBe(3);
    expect(audioRight.sourceOffset).toBe(3);
  });

  it("rejects corrupt timing, string booleans, and edits on locked tracks", () => {
    const state = baseState();
    const corruptMove = timelineToolExecutors.move_clip!({ clipId: "a", newStartTime: Number.NaN }, state);
    expect(corruptMove.result).toMatch(/^Error/);
    expect(corruptMove.state.tracks[0]!.clips[0]!.startTime).toBe(0);

    const flags = timelineToolExecutors.set_track_flags!({ trackId: "t1", visible: "false" }, state);
    expect(flags.result).toMatch(/^Error/);
    expect(flags.state.tracks[0]!.visible).toBe(true);

    state.tracks[0]!.locked = true;
    const lockedTrim = timelineToolExecutors.trim_clip!({ clipId: "a", duration: 1 }, state);
    expect(lockedTrim.result).toMatch(/locked/);
    expect(lockedTrim.state.tracks[0]!.clips[0]!.duration).toBe(2);
  });
});
