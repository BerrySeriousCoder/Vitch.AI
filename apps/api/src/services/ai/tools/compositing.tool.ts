import { randomUUID } from "crypto";
import {
  setClipParent,
  setClipTrackMatte,
  normalizeMotionTrack,
  normalizePlanarTrack,
  normalizeRotoMatteRefinement,
  normalizeRotoRegion,
  normalizeMotionBlur,
  normalizeStabilization,
  normalizeMulticam,
  setMulticamSwitch,
  normalizeTransform3D,
  validateMotionGraph,
} from "@tempo/editor-core";
import type { Clip, Track } from "@tempo/types";
import type { ProjectState } from "./project-state.js";
import { trackSubjectInClip } from "../../media/motion-tracking.service.js";
import { trackGlobalMotionInClip } from "../../media/optical-flow.service.js";
import { trackPlanarSurfaceInClip } from "../../media/planar-tracking.service.js";
import { synchronizeMulticam } from "../../media/multicam-sync.service.js";
import { createSamVideoMatte } from "../../media/replicate-sam.service.js";
import { env } from "../../../config/env.js";
import { resolveLocalMediaPath } from "../../media/audio-understanding.service.js";
import { stat, readFile } from "fs/promises";

const DEFAULT_TRANSFORM = {
  x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0,
};

function findClip(state: ProjectState, clipId: string): { clip: Clip; track: Track } | null {
  for (const track of state.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

export const compositingToolDefinitions = [
  {
    name: "create_multicam_clip",
    description: "Create a non-destructive multicam clip from two or more synchronized, overlapping timeline video clips. It preserves every angle and starts a new multicam track; source angles remain untouched so hide/mute them only after reviewing the new edit.",
    parameters: {
      type: "object" as const,
      properties: {
        angleClipIds: { type: "array", items: { type: "string" }, description: "At least two overlapping forward video clips, in preferred angle order" },
        name: { type: "string", description: "Optional multicam track name" },
        audioAngleClipId: { type: "string", description: "Which angle supplies the clip audio/export audio" },
      },
      required: ["angleClipIds"],
    },
  },
  {
    name: "cut_multicam_angle",
    description: "Add or replace a live multicam angle cut at a clip-local time. This changes only the embedded EDL; the original camera angles remain available.",
    parameters: { type: "object" as const, properties: { clipId: { type: "string" }, angleId: { type: "string" }, time: { type: "number", description: "Seconds from the multicam clip start" } }, required: ["clipId", "angleId", "time"] },
  },
  {
    name: "set_multicam_audio_angle",
    description: "Choose which synchronized camera angle supplies the multicam clip's audio for export. Video switching stays independent.",
    parameters: { type: "object" as const, properties: { clipId: { type: "string" }, angleId: { type: "string" } }, required: ["clipId", "angleId"] },
  },
  {
    name: "analyze_multicam_sync",
    description: "Automatically align an existing multicam clip's local camera angles using deterministic audio-waveform correlation. It writes editable per-angle source offsets and confidence metadata; inspect low-confidence results or recordings without usable shared audio.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "Existing multicam clip" },
        referenceAngleId: { type: "string", description: "Optional angle used as timeline zero; defaults to the current audio angle" },
        strategy: { type: "string", enum: ["auto", "timecode", "clap", "audio"], description: "auto prefers embedded SMPTE timecode, then waveform correlation; clap pairs the strongest audio onset with a visual frame-motion confirmation when available" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "add_null_controller",
    description: "Create a non-rendering null/controller layer. Parent text, shapes, logos, or footage to it for coordinated motion. Returns exact trackId and clipId.",
    parameters: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Optional controller name" },
        startTime: { type: "number", description: "Timeline start in seconds (default 0)" },
        duration: { type: "number", description: "Controller duration in seconds (default 10)" },
      },
      required: [],
    },
  },
  {
    name: "set_clip_parent",
    description: "Parent a clip to another clip or null controller. Parent transform and opacity are inherited; rejects cycles.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        parentClipId: { type: "string", description: "Existing clip or null-controller clip id" },
      },
      required: ["clipId", "parentClipId"],
    },
  },
  {
    name: "clear_clip_parent",
    description: "Remove a clip's parent relationship while preserving its own local transform values.",
    parameters: { type: "object" as const, properties: { clipId: { type: "string" } }, required: ["clipId"] },
  },
  {
    name: "set_track_matte",
    description: "Use a rendered clip as another clip's alpha or luma track matte. The matte source is hidden from the final composite; both clips need temporal overlap.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "Clip to reveal" },
        matteClipId: { type: "string", description: "Visual clip supplying the matte" },
        type: { type: "string", enum: ["alpha", "luma"], description: "Alpha uses source transparency; luma uses source brightness" },
      },
      required: ["clipId", "matteClipId", "type"],
    },
  },
  {
    name: "clear_track_matte",
    description: "Remove a clip's alpha/luma track matte.",
    parameters: { type: "object" as const, properties: { clipId: { type: "string" } }, required: ["clipId"] },
  },
  {
    name: "refine_track_matte",
    description: "Non-destructively refine an existing alpha/luma or AI subject matte with threshold, edge feather, and inversion. Use it after create_ai_subject_matte to clean a soft or noisy edge without regenerating SAM output.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "Target clip currently using the matte" },
        threshold: { type: "number", description: "0..1 cutoff; 0.5 is a typical starting point" },
        feather: { type: "number", description: "0..0.5 normalized soft edge" },
        choke: { type: "number", description: "-0.5..0.5; negative erodes/chokes the matte, positive expands a soft edge" },
        inverted: { type: "boolean", description: "Invert the matte for holdout/reveal work" },
        clear: { type: "boolean", description: "Remove refinement and use the raw matte" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "set_roto_matte_region",
    description: "Add, replace, or clear a non-destructive garbage/holdout region on an existing matte. A garbage region keeps only its area; a holdout removes an unwanted area such as a reflection, second person, or foreground overlap.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "Target clip currently using an alpha/luma/SAM matte" },
        region: { type: "string", enum: ["garbage", "holdout"], description: "garbage keeps inside; holdout removes inside" },
        shape: { type: "string", enum: ["rect", "ellipse"] },
        x: { type: "number", description: "Normalized left (0..1)" }, y: { type: "number", description: "Normalized top (0..1)" },
        width: { type: "number", description: "Normalized width (0..1)" }, height: { type: "number", description: "Normalized height (0..1)" },
        feather: { type: "number", description: "Normalized edge softness (0..0.5)" }, inverted: { type: "boolean" }, opacity: { type: "number", description: "0..1 region strength" },
        clear: { type: "boolean", description: "Remove this region" },
      },
      required: ["clipId", "region"],
    },
  },
  {
    name: "set_motion_track",
    description: "Attach editable 2D tracking samples to a null/controller or visual clip. Samples use seconds relative to that clip and normalized x/y (0..1). Parent layers to this clip to follow the track.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "Controller or visual clip to drive" },
        sourceClipId: { type: "string", description: "Source footage clip being tracked" },
        subject: { type: "string", description: "What is being tracked" },
        samples: { type: "array", description: "At least two {time,x,y,scale?,rotation?,confidence?} samples", items: { type: "object" } },
        useScale: { type: "boolean" },
        useRotation: { type: "boolean" },
      },
      required: ["clipId", "sourceClipId", "samples"],
    },
  },
  {
    name: "analyze_motion_track",
    description: "Use Gemini vision on sampled local footage frames to create an editable AI-assisted 2D track on a controller or visual clip. Requires a local video/image source and GEMINI_API_KEY; inspect samples before claiming a precise lock.",
    parameters: {
      type: "object" as const,
      properties: {
        sourceClipId: { type: "string", description: "Footage clip containing the subject" },
        targetClipId: { type: "string", description: "Null/controller or visual clip to drive" },
        subject: { type: "string", description: "Specific person or object to follow" },
        sampleCount: { type: "number", description: "2..12 sampled frames; default 6" },
        useScale: { type: "boolean" },
        useRotation: { type: "boolean" },
      },
      required: ["sourceClipId", "targetClipId", "subject"],
    },
  },
  {
    name: "analyze_optical_flow",
    description: "Analyze local footage with deterministic optical flow and put an editable global camera-motion trajectory on a controller or visual clip. Best for camera pans/tilts and stabilizing coordinated overlays; use analyze_motion_track for a particular person or object.",
    parameters: {
      type: "object" as const,
      properties: {
        sourceClipId: { type: "string", description: "Local video clip supplying the camera movement" },
        targetClipId: { type: "string", description: "Null/controller or visual clip to drive" },
        sampleFps: { type: "number", description: "2..12 analysis samples/second; default 6" },
        searchRadius: { type: "number", description: "Pixel search radius at analysis resolution; default 8" },
      },
      required: ["sourceClipId", "targetClipId"],
    },
  },
  {
    name: "clear_motion_track",
    description: "Remove motion-track data from a controller or clip without changing its normal keyframes.",
    parameters: { type: "object" as const, properties: { clipId: { type: "string" } }, required: ["clipId"] },
  },
  {
    name: "set_planar_track",
    description: "Attach editable four-corner planar/corner-pin samples to a visual layer. Corners are normalized composition points in top-left, top-right, bottom-right, bottom-left order; the layer is perspective-pinned to that moving surface.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "Visual layer to perspective-pin" },
        sourceClipId: { type: "string", description: "Footage clip containing the tracked surface" },
        surface: { type: "string", description: "Description such as phone screen, billboard, or product label" },
        samples: { type: "array", description: "At least two {time,corners:[{x,y},{x,y},{x,y},{x,y}],confidence?} samples", items: { type: "object" } },
      },
      required: ["clipId", "sourceClipId", "samples"],
    },
  },
  {
    name: "analyze_planar_track",
    description: "Analyze a local video surface from four supplied corner points and perspective-pin a temporally overlapping visual layer to it. Uses deterministic local feature tracking; review and repair low-confidence/occluded samples before relying on a screen replacement.",
    parameters: {
      type: "object" as const,
      properties: {
        sourceClipId: { type: "string", description: "Local video clip containing the planar surface" },
        targetClipId: { type: "string", description: "Text, shape, image, or footage layer to corner-pin" },
        surface: { type: "string", description: "Surface being tracked, e.g. phone screen or wall sign" },
        corners: { type: "array", minItems: 4, maxItems: 4, description: "Initial normalized [top-left, top-right, bottom-right, bottom-left] points, each {x,y}", items: { type: "object" } },
        sampleFps: { type: "number", description: "2..12 analysis samples/second; default 6" },
        searchRadius: { type: "number", description: "2..16 local feature-search pixels at analysis resolution; default 8" },
        patchRadius: { type: "number", description: "3..12 patch radius; default 7" },
      },
      required: ["sourceClipId", "targetClipId", "surface", "corners"],
    },
  },
  {
    name: "clear_planar_track",
    description: "Remove a layer's four-corner planar track while leaving ordinary transform, motion track, and keyframes intact.",
    parameters: { type: "object" as const, properties: { clipId: { type: "string" } }, required: ["clipId"] },
  },
  {
    name: "analyze_stabilization",
    description: "Analyze a local video clip with deterministic optical flow and attach editable inverse camera-motion stabilization. It corrects global pan/tilt only; inspect footage with cuts, rolling shutter, or strong foreground parallax.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "Local video clip to stabilize" },
        sampleFps: { type: "number", description: "2..12 analysis samples/second; default 6" },
        searchRadius: { type: "number", description: "Pixel search radius at analysis resolution; default 8" },
        smoothness: { type: "number", description: "0..1; default 0.65" },
        cropScale: { type: "number", description: "1..1.5 edge-hiding scale; default 1.08" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "set_stabilization",
    description: "Enable, disable, or tune existing editable stabilization samples on a clip. Use after analyze_stabilization to adjust smoothness/crop or to replace samples manually.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" }, enabled: { type: "boolean" },
        samples: { type: "array", description: "Optional replacement [{time,x,y,confidence?}] samples", items: { type: "object" } },
        smoothness: { type: "number", description: "0..1" }, cropScale: { type: "number", description: "1..1.5" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "clear_stabilization",
    description: "Remove optical-flow stabilization without changing normal transforms or motion tracking.",
    parameters: { type: "object" as const, properties: { clipId: { type: "string" } }, required: ["clipId"] },
  },
  {
    name: "set_motion_blur",
    description: "Enable or disable shutter-style directional motion blur for an animated visual clip. The renderer derives blur from transform and motion-track movement; it is strongest on fast keyframed motion.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        enabled: { type: "boolean" },
        shutterAngle: { type: "number", description: "0..360; 180 is a cinematic default" },
        samples: { type: "number", description: "2..32 quality samples; default 8" },
      },
      required: ["clipId", "enabled"],
    },
  },
  {
    name: "set_3d_transform",
    description: "Set or clear a perspective 3D layer transform. Supports X/Y card rotations, Z depth, independent 3D scale, and an anchor. The normal 2D transform still provides the layer's base placement.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        enabled: { type: "boolean", description: "False clears 3D and restores pure 2D rendering" },
        x: { type: "number" }, y: { type: "number" }, z: { type: "number" },
        rotationX: { type: "number" }, rotationY: { type: "number" }, rotationZ: { type: "number" },
        scaleX: { type: "number" }, scaleY: { type: "number" }, scaleZ: { type: "number" },
        anchorX: { type: "number" }, anchorY: { type: "number" }, anchorZ: { type: "number" },
      },
      required: ["clipId", "enabled"],
    },
  },
  {
    name: "set_motion_graph",
    description: "Attach a portable procedural motion graph to a clip. Graph nodes support time, constant, sine, add, multiply, and output; output properties are transform.x, transform.y, transform.scaleX, transform.scaleY, transform.rotation, or opacity. The graph is cycle-safe and renders in preview/export.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string" },
        graph: { type: "object", description: "{id,name,nodes:[{id,type,params}],edges:[{id,fromNodeId,fromPort,toNodeId,toPort}]}" },
        clear: { type: "boolean" },
      },
      required: ["clipId"],
    },
  },
  {
    name: "add_3d_camera",
    description: "Add a project-level perspective camera. It affects enabled 3D layers in preview and frame export; only the first enabled camera is active.",
    parameters: { type: "object" as const, properties: { name: { type: "string" }, position: { type: "array", items: { type: "number" } }, rotation: { type: "array", items: { type: "number" } }, fov: { type: "number" }, enabled: { type: "boolean" } }, required: [] },
  },
  {
    name: "set_3d_camera",
    description: "Update or enable a project 3D camera. Position/rotation are [x,y,z] in pixels/degrees; FOV is 10..160 degrees.",
    parameters: { type: "object" as const, properties: { cameraId: { type: "string" }, position: { type: "array", items: { type: "number" } }, rotation: { type: "array", items: { type: "number" } }, fov: { type: "number" }, enabled: { type: "boolean" } }, required: ["cameraId"] },
  },
  {
    name: "add_3d_light",
    description: "Add an ambient, directional, point, or spot light for enabled perspective 3D layers. Current renderer uses a physically coherent card-normal diffuse approximation.",
    parameters: { type: "object" as const, properties: { name: { type: "string" }, type: { type: "string", enum: ["ambient", "directional", "point", "spot"] }, color: { type: "string" }, intensity: { type: "number" }, position: { type: "array", items: { type: "number" } }, rotation: { type: "array", items: { type: "number" } }, enabled: { type: "boolean" } }, required: ["type"] },
  },
  { name: "create_ai_subject_matte", description: "Create a persistent Replicate SAM 2 video matte from one or more positive click points, add it as a hidden luma track matte above the target clip, and return its clip id. Requires a publicly reachable source video and REPLICATE_API_TOKEN.", parameters: { type: "object" as const, properties: { sourceClipId: { type: "string" }, targetClipId: { type: "string" }, clickFrames: { type: "string", description: "Comma-separated source frame indices, e.g. 1" }, clickObjectIds: { type: "string", description: "Comma-separated ids matching points" }, clickCoordinates: { type: "string", description: "SAM coordinate string, e.g. [391,239],[178,320]" }, videoFps: { type: "number" } }, required: ["sourceClipId", "targetClipId", "clickFrames", "clickObjectIds", "clickCoordinates"] } },
];

export const compositingToolExecutors: Record<string, (args: Record<string, any>, state: ProjectState) => { result: string; state: ProjectState } | Promise<{ result: string; state: ProjectState }>> = {
  create_multicam_clip: (args, state) => {
    const ids = Array.isArray(args.angleClipIds) ? [...new Set(args.angleClipIds.map(String))] : [];
    if (ids.length < 2) return { result: JSON.stringify({ ok: false, error: "angleClipIds must contain at least two unique video clips" }), state };
    const found = ids.map((id) => findClip(state, id));
    if (found.some((item) => !item)) return { result: JSON.stringify({ ok: false, error: "Every angleClipId must reference an existing timeline clip" }), state };
    const angles = found as Array<{ clip: Clip; track: Track }>;
    if (angles.some(({ clip, track }) => track.type !== "video" || !clip.sourceMediaId || clip.reversed || clip.speedRamp?.length || clip.speed <= 0)) {
      return { result: JSON.stringify({ ok: false, error: "Multicam creation requires forward constant-speed video clips with media sources" }), state };
    }
    const startTime = Math.max(...angles.map(({ clip }) => clip.startTime));
    const endTime = Math.min(...angles.map(({ clip }) => clip.startTime + clip.duration));
    if (endTime - startTime < 0.1) return { result: JSON.stringify({ ok: false, error: "Camera angles must overlap for at least 0.1 seconds" }), state };
    const mcAngles = angles.map(({ clip, track }, index) => ({
      id: `angle-${index + 1}`,
      name: track.name || `Angle ${index + 1}`,
      sourceClipId: clip.id,
      sourceMediaId: clip.sourceMediaId!,
      sourceOffset: clip.sourceOffset + (startTime - clip.startTime) * clip.speed,
    }));
    const audioSourceClipId = String(args.audioAngleClipId || angles[0]!.clip.id);
    const audioAngle = mcAngles.find((angle) => angle.sourceClipId === audioSourceClipId) || mcAngles[0]!;
    const multicam = normalizeMulticam({ angles: mcAngles, switches: [{ time: 0, angleId: mcAngles[0]!.id }], audioAngleId: audioAngle.id });
    if (!multicam) return { result: JSON.stringify({ ok: false, error: "Could not construct a valid multicam angle set" }), state };
    const trackId = randomUUID(); const clipId = randomUUID();
    const name = String(args.name || `Multicam ${state.tracks.filter((track) => track.type === "video").length + 1}`).slice(0, 120);
    state.tracks.push({
      id: trackId, name, type: "video", order: state.tracks.length, locked: false, visible: true, solo: false,
      clips: [{ id: clipId, trackId, sourceMediaId: audioAngle.sourceMediaId, startTime, duration: endTime - startTime, sourceOffset: audioAngle.sourceOffset, speed: 1, transform: { ...DEFAULT_TRANSFORM }, opacity: 1, blendMode: "normal", effects: [], keyframes: [], mask: null, muted: false, volume: 1, multicam }],
    });
    return { result: JSON.stringify({ ok: true, trackId, clipId, startTime, duration: endTime - startTime, angles: multicam.angles.map(({ id, name, sourceClipId }) => ({ id, name, sourceClipId })), audioAngleId: multicam.audioAngleId, note: "Source angle tracks remain unchanged; hide/mute them after review to avoid duplicate picture or audio." }), state };
  },

  cut_multicam_angle: (args, state) => {
    const clipId = String(args.clipId || ""); const found = findClip(state, clipId);
    if (!found?.clip.multicam) return { result: JSON.stringify({ ok: false, error: "clipId must reference a multicam clip" }), state };
    const multicam = setMulticamSwitch(found.clip.multicam, Number(args.time), String(args.angleId || ""));
    if (!multicam) return { result: JSON.stringify({ ok: false, error: "angleId is not part of this multicam clip" }), state };
    found.clip.multicam = multicam;
    return { result: JSON.stringify({ ok: true, clipId, switches: multicam.switches }), state };
  },

  set_multicam_audio_angle: (args, state) => {
    const clipId = String(args.clipId || ""); const found = findClip(state, clipId);
    const multicam = normalizeMulticam(found?.clip.multicam);
    const angle = multicam?.angles.find((candidate) => candidate.id === String(args.angleId || ""));
    if (!found || !multicam || !angle) return { result: JSON.stringify({ ok: false, error: "clipId must be multicam and angleId must belong to it" }), state };
    found.clip.multicam = { ...multicam, audioAngleId: angle.id };
    found.clip.sourceMediaId = angle.sourceMediaId;
    found.clip.sourceOffset = angle.sourceOffset;
    return { result: JSON.stringify({ ok: true, clipId, audioAngleId: angle.id }), state };
  },

  analyze_multicam_sync: async (args, state) => {
    const clipId = String(args.clipId || "");
    const found = findClip(state, clipId);
    const multicam = normalizeMulticam(found?.clip.multicam);
    if (!found || !multicam) return { result: JSON.stringify({ ok: false, error: "clipId must reference an existing multicam clip" }), state };
    const referenceAngleId = multicam.angles.some((angle) => angle.id === String(args.referenceAngleId || "")) ? String(args.referenceAngleId) : multicam.audioAngleId;
    const sourceClips = multicam.angles.map((angle) => ({ angle, source: findClip(state, angle.sourceClipId) }));
    if (sourceClips.some(({ source }) => !source?.clip.sourceMediaId)) return { result: JSON.stringify({ ok: false, error: "Every multicam angle must retain a source media clip" }), state };
    const inputs = sourceClips.map(({ angle, source }) => {
      const asset = state.mediaAssets?.find((candidate) => candidate.id === source!.clip.sourceMediaId);
      return { id: angle.id, assetUrl: asset?.url || "" };
    });
    if (inputs.some((input) => !input.assetUrl)) return { result: JSON.stringify({ ok: false, error: "Multicam audio sync requires local media assets in project state" }), state };
    try {
      const strategy = ["auto", "timecode", "clap", "audio"].includes(String(args.strategy)) ? String(args.strategy) as "auto" | "timecode" | "clap" | "audio" : "auto";
      const synced = await synchronizeMulticam(inputs, referenceAngleId, strategy);
      const angles = multicam.angles.map((angle) => {
        const original = sourceClips.find((entry) => entry.angle.id === angle.id)!.source!.clip;
        return { ...angle, sourceOffset: Math.max(0, original.sourceOffset + (synced.offsetsById[angle.id] || 0)) };
      });
      const audioAngle = angles.find((angle) => angle.id === multicam.audioAngleId)!;
      found.clip.multicam = normalizeMulticam({ ...multicam, angles, sync: { mode: synced.method || "audio-correlation", referenceAngleId: synced.referenceId, confidenceByAngle: synced.confidenceById, analysedAt: new Date().toISOString() } })!;
      // The normal audio pipeline consumes the container's source media/time.
      found.clip.sourceMediaId = audioAngle.sourceMediaId;
      found.clip.sourceOffset = audioAngle.sourceOffset;
      return { result: JSON.stringify({ ok: true, clipId, method: synced.method, referenceAngleId: synced.referenceId, analysedSeconds: synced.analysedSeconds, angles: angles.map((angle) => ({ angleId: angle.id, sourceOffset: angle.sourceOffset, confidence: synced.confidenceById[angle.id] ?? 0 })), warning: "Low-confidence values need manual offset review; cuts, unrelated audio, or long silence cannot be reliably synced." }), state };
    } catch (error) {
      return { result: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Multicam audio synchronization failed" }), state };
    }
  },
  add_null_controller: (args, state) => {
    const trackId = randomUUID();
    const clipId = randomUUID();
    const count = state.tracks.filter((track) => track.type === "null").length + 1;
    const startTime = Math.max(0, Number(args.startTime) || 0);
    const duration = Math.max(0.1, Number(args.duration) || 10);
    const name = String(args.name || `Null ${count}`).slice(0, 120);
    state.tracks.push({
      id: trackId,
      name,
      type: "null",
      order: state.tracks.length,
      locked: false,
      visible: true,
      solo: false,
      clips: [{
        id: clipId,
        trackId,
        sourceMediaId: null,
        startTime,
        duration,
        sourceOffset: 0,
        speed: 1,
        transform: { ...DEFAULT_TRANSFORM },
        opacity: 1,
        blendMode: "normal",
        effects: [],
        keyframes: [],
        mask: null,
        muted: true,
        volume: 0,
        nullLayer: true,
      }],
    });
    return { result: JSON.stringify({ ok: true, trackId, clipId, name, startTime, duration }), state };
  },

  set_clip_parent: (args, state) => {
    const clipId = String(args.clipId || "");
    const parentId = String(args.parentClipId || "");
    const result = setClipParent(state.tracks, clipId, parentId);
    if (!result.ok) return { result: JSON.stringify({ ok: false, error: result.message }), state };
    state.tracks = result.tracks;
    return { result: JSON.stringify({ ok: true, clipId, parentClipId: parentId }), state };
  },

  clear_clip_parent: (args, state) => {
    const clipId = String(args.clipId || "");
    const result = setClipParent(state.tracks, clipId, null);
    if (!result.ok) return { result: JSON.stringify({ ok: false, error: result.message }), state };
    state.tracks = result.tracks;
    return { result: JSON.stringify({ ok: true, clipId }), state };
  },

  set_track_matte: (args, state) => {
    const clipId = String(args.clipId || "");
    const matteClipId = String(args.matteClipId || "");
    const type = args.type === "luma" ? "luma" : args.type === "alpha" ? "alpha" : null;
    if (!type) return { result: JSON.stringify({ ok: false, error: "type must be alpha or luma" }), state };
    const result = setClipTrackMatte(state.tracks, clipId, { sourceClipId: matteClipId, type });
    if (!result.ok) return { result: JSON.stringify({ ok: false, error: result.message }), state };
    state.tracks = result.tracks;
    return { result: JSON.stringify({ ok: true, clipId, matteClipId, type }), state };
  },

  clear_track_matte: (args, state) => {
    const clipId = String(args.clipId || "");
    if (!findClip(state, clipId)) return { result: JSON.stringify({ ok: false, error: `Clip ${clipId} was not found` }), state };
    const result = setClipTrackMatte(state.tracks, clipId, null);
    if (!result.ok) return { result: JSON.stringify({ ok: false, error: result.message }), state };
    state.tracks = result.tracks;
    return { result: JSON.stringify({ ok: true, clipId }), state };
  },

  refine_track_matte: (args, state) => {
    const clipId = String(args.clipId || "");
    const found = findClip(state, clipId);
    if (!found?.clip.trackMatte) return { result: JSON.stringify({ ok: false, error: "Clip must have an existing track matte to refine" }), state };
    if (args.clear === true) {
      found.clip.trackMatte = { ...found.clip.trackMatte, refinement: undefined };
      return { result: JSON.stringify({ ok: true, clipId, refinement: null }), state };
    }
    const current = normalizeRotoMatteRefinement(found.clip.trackMatte.refinement);
    const refinement = normalizeRotoMatteRefinement({
      threshold: args.threshold === undefined ? current.threshold : args.threshold,
      feather: args.feather === undefined ? current.feather : args.feather,
      choke: args.choke === undefined ? current.choke : args.choke,
      inverted: args.inverted === undefined ? current.inverted : args.inverted === true,
    });
    found.clip.trackMatte = { ...found.clip.trackMatte, refinement };
    return { result: JSON.stringify({ ok: true, clipId, refinement }), state };
  },

  set_roto_matte_region: (args, state) => {
    const clipId = String(args.clipId || "");
    const found = findClip(state, clipId);
    if (!found?.clip.trackMatte) return { result: JSON.stringify({ ok: false, error: "Clip must have an existing track matte" }), state };
    const region = args.region === "holdout" ? "holdout" : args.region === "garbage" ? "garbage" : null;
    if (!region) return { result: JSON.stringify({ ok: false, error: "region must be garbage or holdout" }), state };
    const property = region === "garbage" ? "garbageMask" : "holdoutMask";
    if (args.clear === true) {
      found.clip.trackMatte = { ...found.clip.trackMatte, [property]: undefined };
      return { result: JSON.stringify({ ok: true, clipId, region, mask: null }), state };
    }
    const existing = found.clip.trackMatte[property];
    const mask = normalizeRotoRegion({
      shape: args.shape === undefined ? existing?.shape : args.shape,
      x: args.x === undefined ? existing?.x : args.x, y: args.y === undefined ? existing?.y : args.y,
      width: args.width === undefined ? existing?.width : args.width, height: args.height === undefined ? existing?.height : args.height,
      feather: args.feather === undefined ? existing?.feather : args.feather,
      inverted: args.inverted === undefined ? existing?.inverted : args.inverted === true,
      opacity: args.opacity === undefined ? existing?.opacity : args.opacity,
    });
    if (!mask) return { result: JSON.stringify({ ok: false, error: "Region needs a positive width and height" }), state };
    found.clip.trackMatte = { ...found.clip.trackMatte, [property]: mask };
    return { result: JSON.stringify({ ok: true, clipId, region, mask }), state };
  },

  set_motion_track: (args, state) => {
    const clipId = String(args.clipId || "");
    const found = findClip(state, clipId);
    if (!found) return { result: JSON.stringify({ ok: false, error: `Clip ${clipId} was not found` }), state };
    const motionTrack = normalizeMotionTrack({
      sourceClipId: String(args.sourceClipId || ""),
      subject: String(args.subject || "subject"),
      samples: Array.isArray(args.samples) ? args.samples : [],
      useScale: args.useScale === true,
      useRotation: args.useRotation === true,
    });
    if (!motionTrack) return { result: JSON.stringify({ ok: false, error: "At least two valid motion-track samples are required" }), state };
    found.clip.motionTrack = motionTrack;
    return { result: JSON.stringify({ ok: true, clipId, samples: motionTrack.samples.length, subject: motionTrack.subject }), state };
  },

  analyze_motion_track: async (args, state) => {
    const source = findClip(state, String(args.sourceClipId || ""));
    const target = findClip(state, String(args.targetClipId || ""));
    if (!source || !target) {
      return { result: JSON.stringify({ ok: false, error: "sourceClipId and targetClipId must reference existing clips" }), state };
    }
    if (
      source.clip.startTime + source.clip.duration <= target.clip.startTime ||
      target.clip.startTime + target.clip.duration <= source.clip.startTime
    ) {
      return { result: JSON.stringify({ ok: false, error: "Source and target clips must overlap on the timeline" }), state };
    }
    if (!source.clip.sourceMediaId) {
      return { result: JSON.stringify({ ok: false, error: "Source clip has no media asset" }), state };
    }
    const asset = state.mediaAssets?.find((item) => item.id === source.clip.sourceMediaId);
    if (!asset) return { result: JSON.stringify({ ok: false, error: "Source media asset is not available in this project state" }), state };
    try {
      const tracked = await trackSubjectInClip({
        asset,
        sourceClip: source.clip,
        subject: String(args.subject || "subject"),
        sampleCount: Number(args.sampleCount) || 6,
      });
      const samples = tracked.samples.map((sample) => ({
        ...sample,
        // AI samples are relative to the source clip; controller samples are
        // relative to the target so parented layers align on the timeline.
        time: source.clip.startTime + sample.time - target.clip.startTime,
      }));
      const motionTrack = normalizeMotionTrack({
        sourceClipId: source.clip.id,
        subject: String(args.subject || "subject"),
        samples,
        useScale: args.useScale === true,
        useRotation: args.useRotation === true,
      });
      if (!motionTrack) throw new Error("AI tracker returned no samples inside the target clip range");
      target.clip.motionTrack = motionTrack;
      return { result: JSON.stringify({ ok: true, sourceClipId: source.clip.id, targetClipId: target.clip.id, subject: motionTrack.subject, samples: motionTrack.samples.length, model: tracked.model }), state };
    } catch (error) {
      return { result: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "AI motion tracking failed" }), state };
    }
  },

  analyze_optical_flow: async (args, state) => {
    const source = findClip(state, String(args.sourceClipId || ""));
    const target = findClip(state, String(args.targetClipId || ""));
    if (!source || !target) {
      return { result: JSON.stringify({ ok: false, error: "sourceClipId and targetClipId must reference existing clips" }), state };
    }
    if (
      source.clip.startTime + source.clip.duration <= target.clip.startTime ||
      target.clip.startTime + target.clip.duration <= source.clip.startTime
    ) {
      return { result: JSON.stringify({ ok: false, error: "Source and target clips must overlap on the timeline" }), state };
    }
    if (!source.clip.sourceMediaId) return { result: JSON.stringify({ ok: false, error: "Source clip has no media asset" }), state };
    const asset = state.mediaAssets?.find((item) => item.id === source.clip.sourceMediaId);
    if (!asset?.url || asset.type !== "video") {
      return { result: JSON.stringify({ ok: false, error: "Optical-flow tracking requires a local video media asset" }), state };
    }
    try {
      const tracked = await trackGlobalMotionInClip({
        assetUrl: asset.url,
        sourceClip: source.clip,
        sampleFps: Number(args.sampleFps) || undefined,
        searchRadius: Number(args.searchRadius) || undefined,
      });
      const samples = tracked.samples.map((sample) => ({
        ...sample,
        time: source.clip.startTime + sample.time - target.clip.startTime,
      }));
      const motionTrack = normalizeMotionTrack({
        sourceClipId: source.clip.id,
        subject: "global camera motion",
        samples,
        useScale: false,
        useRotation: false,
      });
      if (!motionTrack) throw new Error("Optical-flow tracker returned no usable samples inside the target clip range");
      target.clip.motionTrack = motionTrack;
      return {
        result: JSON.stringify({
          ok: true,
          sourceClipId: source.clip.id,
          targetClipId: target.clip.id,
          samples: motionTrack.samples.length,
          analysisFps: tracked.analysisFps,
          analysedDuration: tracked.analysedDuration,
          mode: "global-camera-motion",
        }),
        state,
      };
    } catch (error) {
      return { result: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Optical-flow tracking failed" }), state };
    }
  },

  clear_motion_track: (args, state) => {
    const clipId = String(args.clipId || "");
    const found = findClip(state, clipId);
    if (!found) return { result: JSON.stringify({ ok: false, error: `Clip ${clipId} was not found` }), state };
    found.clip.motionTrack = null;
    return { result: JSON.stringify({ ok: true, clipId }), state };
  },

  set_planar_track: (args, state) => {
    const clipId = String(args.clipId || "");
    const found = findClip(state, clipId);
    if (!found) return { result: JSON.stringify({ ok: false, error: `Clip ${clipId} was not found` }), state };
    if (found.track.type === "audio" || found.track.type === "null") return { result: JSON.stringify({ ok: false, error: "Planar tracking requires a visual target layer" }), state };
    const planarTrack = normalizePlanarTrack({
      sourceClipId: String(args.sourceClipId || ""),
      surface: String(args.surface || "surface"),
      samples: Array.isArray(args.samples) ? args.samples : [],
    });
    if (!planarTrack) return { result: JSON.stringify({ ok: false, error: "At least two valid convex four-corner samples are required" }), state };
    found.clip.planarTrack = planarTrack;
    return { result: JSON.stringify({ ok: true, clipId, surface: planarTrack.surface, samples: planarTrack.samples.length }), state };
  },

  analyze_planar_track: async (args, state) => {
    const source = findClip(state, String(args.sourceClipId || ""));
    const target = findClip(state, String(args.targetClipId || ""));
    if (!source || !target) return { result: JSON.stringify({ ok: false, error: "sourceClipId and targetClipId must reference existing clips" }), state };
    if (source.track.type !== "video" || target.track.type === "audio" || target.track.type === "null") return { result: JSON.stringify({ ok: false, error: "Planar tracking needs a video source and visual target layer" }), state };
    if (source.clip.startTime + source.clip.duration <= target.clip.startTime || target.clip.startTime + target.clip.duration <= source.clip.startTime) {
      return { result: JSON.stringify({ ok: false, error: "Source and target clips must overlap on the timeline" }), state };
    }
    const rawCorners = Array.isArray(args.corners) ? args.corners : [];
    if (rawCorners.length !== 4) return { result: JSON.stringify({ ok: false, error: "corners must contain top-left, top-right, bottom-right, bottom-left points" }), state };
    const corners = rawCorners.map((corner) => ({ x: Number(corner?.x), y: Number(corner?.y) }));
    if (corners.some((corner) => !Number.isFinite(corner.x) || !Number.isFinite(corner.y))) return { result: JSON.stringify({ ok: false, error: "Every corner must have finite x/y coordinates" }), state };
    if (!source.clip.sourceMediaId) return { result: JSON.stringify({ ok: false, error: "Source clip has no media asset" }), state };
    const asset = state.mediaAssets?.find((item) => item.id === source.clip.sourceMediaId);
    if (!asset?.url || asset.type !== "video") return { result: JSON.stringify({ ok: false, error: "Planar tracking requires a local video media asset" }), state };
    try {
      const tracked = await trackPlanarSurfaceInClip({
        assetUrl: asset.url, sourceClip: source.clip,
        corners: corners as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
        sampleFps: Number(args.sampleFps) || undefined,
        searchRadius: Number(args.searchRadius) || undefined,
        patchRadius: Number(args.patchRadius) || undefined,
      });
      const samples = tracked.samples
        .map((sample) => ({ ...sample, time: source.clip.startTime + sample.time - target.clip.startTime }))
        .filter((sample) => sample.time >= 0 && sample.time <= target.clip.duration);
      const planarTrack = normalizePlanarTrack({ sourceClipId: source.clip.id, surface: String(args.surface || "surface"), samples });
      if (!planarTrack) throw new Error("Planar tracker returned too few valid samples in the target range");
      target.clip.planarTrack = planarTrack;
      return { result: JSON.stringify({ ok: true, sourceClipId: source.clip.id, targetClipId: target.clip.id, surface: planarTrack.surface, samples: planarTrack.samples.length, analysisFps: tracked.analysisFps, analysedDuration: tracked.analysedDuration, mode: "four-corner-planar-feature-track" }), state };
    } catch (error) {
      return { result: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Planar tracking failed" }), state };
    }
  },

  clear_planar_track: (args, state) => {
    const clipId = String(args.clipId || "");
    const found = findClip(state, clipId);
    if (!found) return { result: JSON.stringify({ ok: false, error: `Clip ${clipId} was not found` }), state };
    found.clip.planarTrack = null;
    return { result: JSON.stringify({ ok: true, clipId }), state };
  },

  analyze_stabilization: async (args, state) => {
    const found = findClip(state, String(args.clipId || ""));
    if (!found?.clip.sourceMediaId) return { result: JSON.stringify({ ok: false, error: "clipId must reference a video clip with local media" }), state };
    const asset = state.mediaAssets?.find((item) => item.id === found.clip.sourceMediaId);
    if (!asset?.url || asset.type !== "video") return { result: JSON.stringify({ ok: false, error: "Stabilization requires a local video media asset" }), state };
    try {
      const tracked = await trackGlobalMotionInClip({
        assetUrl: asset.url,
        sourceClip: found.clip,
        sampleFps: Number(args.sampleFps) || undefined,
        searchRadius: Number(args.searchRadius) || undefined,
      });
      const stabilization = normalizeStabilization({ enabled: true, samples: tracked.samples, smoothness: args.smoothness, cropScale: args.cropScale });
      if (!stabilization) throw new Error("Optical-flow tracker returned too few usable samples");
      found.clip.stabilization = stabilization;
      return { result: JSON.stringify({ ok: true, clipId: found.clip.id, samples: stabilization.samples.length, smoothness: stabilization.smoothness, cropScale: stabilization.cropScale, analysisFps: tracked.analysisFps, analysedDuration: tracked.analysedDuration, mode: "global-translation-stabilization" }), state };
    } catch (error) {
      return { result: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Stabilization analysis failed" }), state };
    }
  },

  set_stabilization: (args, state) => {
    const clipId = String(args.clipId || "");
    const found = findClip(state, clipId);
    if (!found) return { result: JSON.stringify({ ok: false, error: `Clip ${clipId} was not found` }), state };
    const previous = found.clip.stabilization;
    const stabilization = normalizeStabilization({
      enabled: args.enabled === undefined ? (previous?.enabled ?? true) : args.enabled === true,
      samples: Array.isArray(args.samples) ? args.samples : previous?.samples,
      smoothness: args.smoothness ?? previous?.smoothness,
      cropScale: args.cropScale ?? previous?.cropScale,
    });
    if (!stabilization) return { result: JSON.stringify({ ok: false, error: "At least two valid stabilization samples are required; run analyze_stabilization first or pass samples" }), state };
    found.clip.stabilization = stabilization;
    return { result: JSON.stringify({ ok: true, clipId, stabilization }), state };
  },

  clear_stabilization: (args, state) => {
    const clipId = String(args.clipId || "");
    const found = findClip(state, clipId);
    if (!found) return { result: JSON.stringify({ ok: false, error: `Clip ${clipId} was not found` }), state };
    found.clip.stabilization = null;
    return { result: JSON.stringify({ ok: true, clipId }), state };
  },

  set_motion_blur: (args, state) => {
    const clipId = String(args.clipId || "");
    const found = findClip(state, clipId);
    if (!found) return { result: JSON.stringify({ ok: false, error: `Clip ${clipId} was not found` }), state };
    found.clip.motionBlur = normalizeMotionBlur({
      enabled: args.enabled === true,
      shutterAngle: args.shutterAngle,
      samples: args.samples,
    });
    return { result: JSON.stringify({ ok: true, clipId, motionBlur: found.clip.motionBlur }), state };
  },

  set_3d_transform: (args, state) => {
    const clipId = String(args.clipId || "");
    const found = findClip(state, clipId);
    if (!found) return { result: JSON.stringify({ ok: false, error: `Clip ${clipId} was not found` }), state };
    if (args.enabled !== true) {
      found.clip.transform3D = null;
      return { result: JSON.stringify({ ok: true, clipId, transform3D: null }), state };
    }
    const keys = ["x", "y", "z", "rotationX", "rotationY", "rotationZ", "scaleX", "scaleY", "scaleZ", "anchorX", "anchorY", "anchorZ"] as const;
    const patch = Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, Number(args[key])])) as Partial<NonNullable<Clip["transform3D"]>>;
    found.clip.transform3D = normalizeTransform3D({ ...(found.clip.transform3D || {}), ...patch });
    return { result: JSON.stringify({ ok: true, clipId, transform3D: found.clip.transform3D }), state };
  },

  set_motion_graph: (args, state) => {
    const clipId = String(args.clipId || "");
    const found = findClip(state, clipId);
    if (!found) return { result: JSON.stringify({ ok: false, error: `Clip ${clipId} was not found` }), state };
    if (args.clear === true) {
      found.clip.motionGraph = null;
      found.clip.motionGraphId = null;
      return { result: JSON.stringify({ ok: true, clipId, motionGraph: null }), state };
    }
    const graph = args.graph as Clip["motionGraph"];
    const check = validateMotionGraph(graph);
    if (!check.ok || !graph) return { result: JSON.stringify({ ok: false, error: check.message || "Invalid motion graph" }), state };
    found.clip.motionGraph = graph;
    found.clip.motionGraphId = graph.id;
    return { result: JSON.stringify({ ok: true, clipId, graphId: graph.id, nodes: graph.nodes.length, edges: graph.edges.length }), state };
  },

  add_3d_camera: (args, state) => {
    const tuple = (value: unknown, fallback: [number, number, number]) => Array.isArray(value) && value.length === 3 && value.every((n) => Number.isFinite(Number(n))) ? [Number(value[0]), Number(value[1]), Number(value[2])] as [number, number, number] : fallback;
    const camera = { id: randomUUID(), name: String(args.name || `Camera ${(state.cameras?.length || 0) + 1}`).slice(0, 120), position: tuple(args.position, [0, 0, 0]), rotation: tuple(args.rotation, [0, 0, 0]), fov: Math.max(10, Math.min(160, Number(args.fov) || 50)), near: 1, far: 100000, enabled: args.enabled !== false };
    state.cameras = [...(state.cameras || []), camera];
    return { result: JSON.stringify({ ok: true, camera }), state };
  },

  set_3d_camera: (args, state) => {
    const cameraId = String(args.cameraId || "");
    const index = (state.cameras || []).findIndex((camera) => camera.id === cameraId);
    if (index < 0) return { result: JSON.stringify({ ok: false, error: `Camera ${cameraId} was not found` }), state };
    const current = state.cameras![index]!;
    const tuple = (value: unknown, fallback: [number, number, number]) => Array.isArray(value) && value.length === 3 && value.every((n) => Number.isFinite(Number(n))) ? [Number(value[0]), Number(value[1]), Number(value[2])] as [number, number, number] : fallback;
    const camera = { ...current, position: args.position === undefined ? current.position : tuple(args.position, current.position), rotation: args.rotation === undefined ? current.rotation : tuple(args.rotation, current.rotation), fov: args.fov === undefined ? current.fov : Math.max(10, Math.min(160, Number(args.fov))), enabled: args.enabled === undefined ? current.enabled : args.enabled === true };
    state.cameras = state.cameras!.map((item, i) => i === index ? camera : item);
    return { result: JSON.stringify({ ok: true, camera }), state };
  },

  add_3d_light: (args, state) => {
    const tuple = (value: unknown, fallback: [number, number, number]) => Array.isArray(value) && value.length === 3 && value.every((n) => Number.isFinite(Number(n))) ? [Number(value[0]), Number(value[1]), Number(value[2])] as [number, number, number] : fallback;
    const type = ["ambient", "directional", "point", "spot"].includes(String(args.type)) ? args.type : "directional";
    const light = { id: randomUUID(), name: String(args.name || `${type} light`).slice(0, 120), type, color: /^#[0-9a-f]{6}$/i.test(String(args.color || "")) ? String(args.color) : "#FFFFFF", intensity: Math.max(0, Math.min(20, Number(args.intensity) || (type === "ambient" ? 0.5 : 1))), position: tuple(args.position, [0, 0, 1000]), rotation: tuple(args.rotation, [0, 0, 0]), enabled: args.enabled !== false };
    state.lights = [...(state.lights || []), light];
    return { result: JSON.stringify({ ok: true, light }), state };
  },

  create_ai_subject_matte: async (args, state) => {
    const source = findClip(state, String(args.sourceClipId || ""));
    const target = findClip(state, String(args.targetClipId || ""));
    if (!source?.clip.sourceMediaId || !target) return { result: JSON.stringify({ ok: false, error: "sourceClipId must be media and targetClipId must exist" }), state };
    const asset = state.mediaAssets?.find((item) => item.id === source.clip.sourceMediaId);
    if (!asset?.url) return { result: JSON.stringify({ ok: false, error: "Source media asset is unavailable" }), state };
    const localPath = resolveLocalMediaPath(asset.url);
    let inputVideo: string | Buffer = "";
    if (localPath) {
      const info = await stat(localPath).catch(() => null);
      if (info && info.size <= 100 * 1024 * 1024) inputVideo = await readFile(localPath);
    }
    if (!inputVideo) {
      const origin = env.API_PUBLIC_URL || "";
      inputVideo = asset.url.startsWith("http") ? asset.url : origin ? `${origin.replace(/\/$/, "")}${asset.url}` : "";
    }
    if (!inputVideo) return { result: JSON.stringify({ ok: false, error: "Source is over 100 MB or remote-only: set API_PUBLIC_URL to a publicly reachable API origin" }), state };
    try {
      const generated = await createSamVideoMatte({ inputVideo, clickFrames: String(args.clickFrames), clickObjectIds: String(args.clickObjectIds), clickCoordinates: String(args.clickCoordinates), videoFps: Number(args.videoFps) || 25 });
      const trackId = randomUUID(); const matteClipId = randomUUID();
      const matte: Clip = { id: matteClipId, trackId, sourceMediaId: null, generatedMediaUrl: generated.url, startTime: source.clip.startTime, duration: source.clip.duration, sourceOffset: 0, speed: 1, transform: { ...DEFAULT_TRANSFORM }, opacity: 1, blendMode: "normal", effects: [], keyframes: [], mask: null, muted: true, volume: 0 };
      state.tracks.push({ id: trackId, name: "AI Subject Matte", type: "video", order: state.tracks.length, locked: false, visible: true, solo: false, clips: [matte] });
      target.clip.trackMatte = { sourceClipId: matteClipId, type: "luma" };
      return { result: JSON.stringify({ ok: true, matteClipId, trackId, targetClipId: target.clip.id }), state };
    } catch (error) { return { result: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "SAM 2 matte failed" }), state }; }
  },
};
