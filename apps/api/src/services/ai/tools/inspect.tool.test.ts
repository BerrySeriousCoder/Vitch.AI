import { describe, it, expect } from "vitest";
import type { Track } from "@tempo/types";
import { inspectToolExecutors } from "./inspect.tool.js";
import { audioToolExecutors } from "./audio.tool.js";
import { createProjectState } from "./index.js";

function videoTrack(): Track {
  return {
    id: "t1",
    name: "Video",
    type: "video",
    order: 0,
    locked: false,
    visible: true,
    solo: false,
    clips: [
      {
        id: "c1",
        trackId: "t1",
        sourceMediaId: "m1",
        startTime: 0,
        duration: 2,
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
      },
      {
        id: "c2",
        trackId: "t1",
        sourceMediaId: "m2",
        startTime: 1.5,
        duration: 2,
        sourceOffset: 0,
        speed: 1,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 },
        opacity: 1,
        blendMode: "normal",
        effects: [],
        keyframes: [],
        mask: null,
        muted: false,
        volume: 0.5,
      },
    ],
  };
}

describe("inspect tools", () => {
  it("reports overlaps and mixer", () => {
    const state = createProjectState([videoTrack()]);
    const { result } = inspectToolExecutors.inspect_timeline!({}, state);
    expect(result).toContain("OVERLAP");
    expect(result).toContain("c1");
    expect(result).toContain("Mixer:");
  });

  it("summarizes project", () => {
    const state = createProjectState([videoTrack()]);
    const { result } = inspectToolExecutors.get_project_summary!({}, state);
    const parsed = JSON.parse(result);
    expect(parsed.clipCount).toBe(2);
    expect(parsed.trackCount).toBe(1);
    expect(parsed.durationSec).toBe(3.5);
  });
});

describe("audio harness tools", () => {
  it("exposes irregular reference impacts without requiring a BPM grid", () => {
    const state = createProjectState([videoTrack()], undefined, {
      editBlueprint: {
        audioAnalysis: {
          bpm: 0,
          beats: [],
          impacts: [{ id: "impact-0", time: 0.37, strength: 0.9, isDownbeat: false, kind: "onset" }],
          energyCurve: [],
          mood: "dramatic",
          genre: "unknown",
          beatSource: "unavailable",
        },
      } as any,
    });
    const output = audioToolExecutors.get_audio_events!({}, state);
    expect(JSON.parse(output.result)).toMatchObject({
      ok: true,
      bpm: 0,
      beatSource: "unavailable",
      impacts: [{ id: "impact-0", time: 0.37, kind: "onset" }],
    });
  });

  it("sets fade_audio on clip", () => {
    const state = createProjectState([videoTrack()]);
    const { result, state: next } = audioToolExecutors.fade_audio!(
      { clipId: "c1", fadeInSec: 0.5, fadeOutSec: 1 },
      state
    );
    expect(result).toContain("fadeIn=0.5");
    expect(next.tracks[0]!.clips[0]!.fadeInSec).toBe(0.5);
    expect(next.tracks[0]!.clips[0]!.fadeOutSec).toBe(1);
  });

  it("updates mixer volumes", () => {
    const state = createProjectState([videoTrack()]);
    audioToolExecutors.set_master_volume!({ volume: 0.4 }, state);
    audioToolExecutors.set_track_volume!({ trackId: "t1", volume: 0.6 }, state);
    audioToolExecutors.mute_track!({ trackId: "t1", muted: true }, state);
    expect(state.audioMixer.masterVolume).toBe(0.4);
    expect(state.audioMixer.trackVolumes.t1).toBe(0.6);
    expect(state.audioMixer.trackMutes.t1).toBe(true);
  });

  it("syncs clips to beats", () => {
    const state = createProjectState([videoTrack()]);
    const { result, state: next } = audioToolExecutors.sync_clips_to_beats!(
      { clipIds: ["c2"], beatTimes: [0, 1, 2, 3] },
      state
    );
    expect(result).toContain("c2");
    // c2 was at 1.5s → nearest beat is 1s (tie breaks toward earlier scanned beat)
    expect(next.tracks[0]!.clips[1]!.startTime).toBe(1);
  });

  it("syncs linked A/V and bound captions to beats while clearing stale transitions", () => {
    const state = createProjectState([videoTrack()]);
    const video = state.tracks[0]!.clips[1]!;
    video.linkGroupId = "linked-av";
    state.tracks.push({
      id: "a1",
      name: "Audio",
      type: "audio",
      order: 1,
      locked: false,
      visible: true,
      solo: false,
      clips: [{ ...structuredClone(video), id: "audio-c2", trackId: "a1" }],
    });
    state.tracks.push({
      id: "captions",
      name: "Captions",
      type: "text",
      order: 2,
      locked: false,
      visible: true,
      solo: false,
      clips: [{
        ...structuredClone(video),
        id: "caption-c2",
        trackId: "captions",
        sourceMediaId: null,
        startTime: 2,
        duration: 0.5,
        linkGroupId: null,
        captionBinding: {
          sourceClipId: "c2",
          sourceMediaId: "m2",
          transcriptRevision: "r1",
          sourceStart: 0.5,
          sourceEnd: 1,
          wordIds: [],
          generatedTiming: true,
        },
      }],
    });
    state.transitions = [{ id: "tx", trackId: "t1", clipAId: "c1", clipBId: "c2", duration: 0.5, type: "crossfade", params: {} }];

    const { state: next } = audioToolExecutors.sync_clips_to_beats!(
      { clipIds: ["c2"], beatTimes: [1] },
      state
    );
    expect(next.tracks[0]!.clips[1]!.startTime).toBe(1);
    expect(next.tracks[1]!.clips[0]!.startTime).toBe(1);
    expect(next.tracks[2]!.clips[0]!.startTime).toBe(1.5);
    expect(next.transitions).toEqual([]);
  });

  it("rejects non-finite mixer values and non-boolean mute values", () => {
    const state = createProjectState([videoTrack()]);
    const before = structuredClone(state);
    expect(audioToolExecutors.set_volume!({ clipId: "c1", volume: "bad" }, state).result).toMatch(/^Error:/);
    expect(audioToolExecutors.set_master_volume!({ volume: Number.NaN }, state).result).toMatch(/^Error:/);
    expect(audioToolExecutors.mute_track!({ trackId: "t1", muted: "false" }, state).result).toMatch(/^Error:/);
    expect(state).toEqual(before);
  });

  it("adds music track", () => {
    const state = createProjectState([], undefined, {
      mediaAssets: [{ id: "music-1", type: "audio", duration: 30, metadata: {} } as any],
    });
    const { result, state: next } = audioToolExecutors.add_music_track!(
      {
        sourceMediaId: "music-1",
        duration: 10,
        fadeInSec: 1,
        volume: 0.5,
      },
      state
    );
    expect(result).toContain("Background Music");
    expect(next.tracks).toHaveLength(1);
    expect(next.tracks[0]!.type).toBe("audio");
    expect(next.tracks[0]!.clips[0]!.fadeInSec).toBe(1);
    expect(next.tracks[0]!.clips[0]!.volume).toBe(0.5);
  });
});
