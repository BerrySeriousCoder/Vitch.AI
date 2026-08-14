import { describe, expect, it } from "vitest";
import type { Track } from "@tempo/types";
import { sequencesToolExecutors } from "./sequences.tool.js";
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

function baseState(): ProjectState {
  const tracks: Track[] = [
    {
      id: "t1",
      name: "V1",
      type: "video",
      order: 0,
      locked: false,
      visible: true,
      solo: false,
      clips: [clip("a", 0, 2), clip("b", 2, 2)],
    },
  ];
  return {
    tracks,
    transitions: [],
    sequences: [],
    audioMixer: { masterVolume: 1, trackVolumes: {}, trackMutes: {} },
  };
}

describe("sequences tools", () => {
  it("create_sequence empty + list + place + delete", () => {
    let state = baseState();
    const created = sequencesToolExecutors.create_sequence!(
      { name: "Intro" },
      state
    );
    expect(created.result).toMatch(/Created empty sequence/);
    state = created.state;
    const id = state.sequences![0]!.id;

    const listed = sequencesToolExecutors.list_sequences!({}, state);
    expect(listed.result).toContain(id);
    expect(listed.result).toContain("used=0x");

    const placed = sequencesToolExecutors.place_sequence_clip!(
      { sequenceId: id, trackId: "t1", startTime: 5, duration: 3 },
      state
    );
    expect(placed.result).not.toMatch(/^Error/);
    state = placed.state;
    expect(
      state.tracks[0]!.clips.some((c) => c.sourceSequenceId === id)
    ).toBe(true);

    const blocked = sequencesToolExecutors.delete_sequence!(
      { sequenceId: id },
      state
    );
    expect(blocked.result).toMatch(/^Error/);

    state.tracks[0]!.clips = state.tracks[0]!.clips.filter(
      (c) => c.sourceSequenceId !== id
    );
    const deleted = sequencesToolExecutors.delete_sequence!(
      { sequenceId: id },
      state
    );
    expect(deleted.result).toMatch(/Deleted sequence/);
    expect(deleted.state.sequences).toHaveLength(0);
  });

  it("create_sequence from clipIds packs and places nest", () => {
    const state = baseState();
    const out = sequencesToolExecutors.create_sequence!(
      { name: "Pack", clipIds: ["a", "b"] },
      state
    );
    expect(out.result).not.toMatch(/^Error/);
    expect(out.state.sequences).toHaveLength(1);
    expect(out.state.tracks[0]!.clips).toHaveLength(1);
    expect(out.state.tracks[0]!.clips[0]!.sourceSequenceId).toBe(
      out.state.sequences![0]!.id
    );
  });

  it("rename_sequence updates name", () => {
    let state = baseState();
    state = sequencesToolExecutors.create_sequence!({ name: "A" }, state).state;
    const id = state.sequences![0]!.id;
    const out = sequencesToolExecutors.rename_sequence!(
      { sequenceId: id, name: "B" },
      state
    );
    expect(out.result).toMatch(/Renamed/);
    expect(out.state.sequences![0]!.name).toBe("B");
  });
});
