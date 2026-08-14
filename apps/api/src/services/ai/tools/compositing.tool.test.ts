import { describe, expect, it } from "vitest";
import type { Track } from "@tempo/types";
import { compositingToolExecutors } from "./compositing.tool.js";
import type { ProjectState } from "./project-state.js";

function state(): ProjectState {
  const tracks: Track[] = [{
    id: "v1", name: "Video", type: "video", order: 0, locked: false, visible: true, solo: false,
    clips: ["source", "target"].map((id) => ({
      id, trackId: "v1", sourceMediaId: id, startTime: 0, duration: 3, sourceOffset: 0, speed: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 },
      opacity: 1, blendMode: "normal" as const, effects: [], keyframes: [], mask: null, muted: false, volume: 1,
    })),
  }];
  return { tracks, audioMixer: { masterVolume: 1, trackVolumes: {}, trackMutes: {} } };
}

describe("compositing tools", () => {
  it("creates a controller and parents a clip without allowing a cycle", async () => {
    const project = state();
    const controller = await compositingToolExecutors.add_null_controller!({ name: "Title rig", duration: 3 }, project);
    const { clipId } = JSON.parse(controller.result) as { clipId: string };
    expect(controller.state.tracks.at(-1)?.type).toBe("null");

    const parented = await compositingToolExecutors.set_clip_parent!({ clipId: "target", parentClipId: clipId }, controller.state);
    expect(parented.state.tracks[0]!.clips[1]!.parentId).toBe(clipId);
    expect((await compositingToolExecutors.set_clip_parent!({ clipId, parentClipId: "target" }, parented.state)).result).toMatch(/cycle/i);
  });

  it("creates a multicam clip and writes non-destructive live cuts", () => {
    const project = state();
    project.tracks[0]!.clips[0]!.sourceOffset = 1.25;
    project.tracks[0]!.clips[1]!.sourceOffset = 2.5;
    const created = compositingToolExecutors.create_multicam_clip!({ angleClipIds: ["source", "target"], name: "Interview" }, project) as { result: string; state: typeof project };
    const info = JSON.parse(created.result) as { clipId: string; angles: Array<{ id: string }> };
    const multicam = created.state.tracks.at(-1)!.clips[0]!;
    expect(multicam.multicam?.angles).toHaveLength(2);
    expect(multicam.sourceOffset).toBe(1.25);
    const cut = compositingToolExecutors.cut_multicam_angle!({ clipId: info.clipId, angleId: info.angles[1]!.id, time: 1 }, created.state) as { state: typeof project };
    expect(cut.state.tracks.at(-1)!.clips[0]!.multicam?.switches.at(-1)).toEqual({ time: 1, angleId: info.angles[1]!.id });

    const audio = compositingToolExecutors.set_multicam_audio_angle!({ clipId: info.clipId, angleId: info.angles[1]!.id }, cut.state) as { state: typeof project };
    expect(audio.state.tracks.at(-1)!.clips[0]).toMatchObject({
      sourceMediaId: "target",
      sourceOffset: 2.5,
    });
  });

  it("sets and clears alpha/luma mattes", async () => {
    const project = state();
    const set = await compositingToolExecutors.set_track_matte!({ clipId: "target", matteClipId: "source", type: "luma" }, project);
    expect(set.state.tracks[0]!.clips[1]!.trackMatte).toEqual({ sourceClipId: "source", type: "luma" });
    const clear = await compositingToolExecutors.clear_track_matte!({ clipId: "target" }, set.state);
    expect(clear.state.tracks[0]!.clips[1]!.trackMatte).toBeNull();
  });

  it("refines an existing matte non-destructively", () => {
    const project = state();
    const matte = compositingToolExecutors.set_track_matte!({ clipId: "target", matteClipId: "source", type: "luma" }, project) as { state: typeof project };
    const result = compositingToolExecutors.refine_track_matte!({ clipId: "target", threshold: 0.62, feather: 0.04, inverted: true }, matte.state) as { state: typeof project };
    expect(result.state.tracks[0]!.clips[1]!.trackMatte).toMatchObject({ sourceClipId: "source", type: "luma", refinement: { threshold: 0.62, feather: 0.04, inverted: true } });
  });

  it("adds and clears a roto holdout region without replacing the matte", () => {
    const project = state();
    const matte = compositingToolExecutors.set_track_matte!({ clipId: "target", matteClipId: "source", type: "luma" }, project) as { state: typeof project };
    const result = compositingToolExecutors.set_roto_matte_region!({ clipId: "target", region: "holdout", shape: "ellipse", x: 0.2, y: 0.3, width: 0.4, height: 0.5, feather: 0.1 }, matte.state) as { state: typeof project };
    expect(result.state.tracks[0]!.clips[1]!.trackMatte).toMatchObject({ sourceClipId: "source", holdoutMask: { shape: "ellipse", x: 0.2, y: 0.3, width: 0.4, height: 0.5 } });
    const cleared = compositingToolExecutors.set_roto_matte_region!({ clipId: "target", region: "holdout", clear: true }, result.state) as { state: typeof project };
    expect(cleared.state.tracks[0]!.clips[1]!.trackMatte?.holdoutMask).toBeUndefined();
  });

  it("stores bounded, editable stabilization samples", () => {
    const project = state();
    const result = compositingToolExecutors.set_stabilization!({
      clipId: "target", samples: [{ time: 0, x: 0.4, y: 0.5 }, { time: 3, x: 0.7, y: 0.6 }], smoothness: 2, cropScale: 3,
    }, project) as { state: typeof project };
    expect(result.state.tracks[0]!.clips[1]!.stabilization).toMatchObject({ enabled: true, smoothness: 1, cropScale: 1.5 });
    const cleared = compositingToolExecutors.clear_stabilization!({ clipId: "target" }, result.state) as { state: typeof project };
    expect(cleared.state.tracks[0]!.clips[1]!.stabilization).toBeNull();
  });

  it("stores editable motion tracking samples", () => {
    const project = state();
    const result = compositingToolExecutors.set_motion_track!({
      clipId: "target",
      sourceClipId: "source",
      subject: "presenter",
      samples: [{ time: 0, x: 0.2, y: 0.4 }, { time: 3, x: 0.8, y: 0.6, confidence: 0.7 }],
    }, project) as { result: string; state: typeof project };
    expect(result.state.tracks[0]!.clips[1]!.motionTrack?.samples).toHaveLength(2);
    const cleared = compositingToolExecutors.clear_motion_track!({ clipId: "target" }, result.state) as { result: string; state: typeof project };
    expect(cleared.state.tracks[0]!.clips[1]!.motionTrack).toBeNull();
  });

  it("stores and clears editable four-corner planar tracking", () => {
    const project = state();
    const samples = [0, 3].map((time) => ({ time, corners: [
      { x: 0.2, y: 0.2 }, { x: 0.7, y: 0.2 }, { x: 0.7, y: 0.6 }, { x: 0.2, y: 0.6 },
    ] }));
    const result = compositingToolExecutors.set_planar_track!({ clipId: "target", sourceClipId: "source", surface: "phone screen", samples }, project) as { state: typeof project };
    expect(result.state.tracks[0]!.clips[1]!.planarTrack).toMatchObject({ surface: "phone screen", samples: expect.arrayContaining([expect.objectContaining({ corners: expect.any(Array) })]) });
    const cleared = compositingToolExecutors.clear_planar_track!({ clipId: "target" }, result.state) as { state: typeof project };
    expect(cleared.state.tracks[0]!.clips[1]!.planarTrack).toBeNull();
  });

  it("configures bounded shutter motion blur", () => {
    const project = state();
    const result = compositingToolExecutors.set_motion_blur!(
      { clipId: "target", enabled: true, shutterAngle: 480, samples: 99 },
      project
    ) as { result: string; state: typeof project };
    expect(result.state.tracks[0]!.clips[1]!.motionBlur).toEqual({ enabled: true, shutterAngle: 360, samples: 32 });
  });

  it("enables a bounded perspective 3D layer", () => {
    const project = state();
    const result = compositingToolExecutors.set_3d_transform!(
      { clipId: "target", enabled: true, z: 240, rotationY: 25 },
      project
    ) as { result: string; state: typeof project };
    expect(result.state.tracks[0]!.clips[1]!.transform3D).toMatchObject({ z: 240, rotationY: 25, scaleZ: 1 });
  });

  it("attaches a validated procedural motion graph", () => {
    const project = state();
    const graph = { id: "float", name: "Float", nodes: [
      { id: "sine", type: "sine", params: { amplitude: 12, frequency: 1 } },
      { id: "out", type: "output", params: { property: "transform.y" } },
    ], edges: [{ id: "edge", fromNodeId: "sine", fromPort: "value", toNodeId: "out", toPort: "value" }] };
    const result = compositingToolExecutors.set_motion_graph!({ clipId: "target", graph }, project) as { result: string; state: typeof project };
    expect(result.state.tracks[0]!.clips[1]!.motionGraphId).toBe("float");
  });

  it("creates project-level camera and light rig controls", () => {
    const project = state();
    const camera = compositingToolExecutors.add_3d_camera!({ name: "Hero camera", fov: 55 }, project) as { result: string; state: typeof project };
    expect(camera.state.cameras?.[0]).toMatchObject({ name: "Hero camera", fov: 55, enabled: true });
    const light = compositingToolExecutors.add_3d_light!({ type: "directional", intensity: 1.5 }, camera.state) as { result: string; state: typeof project };
    expect(light.state.lights?.[0]).toMatchObject({ type: "directional", intensity: 1.5, enabled: true });
  });
});
