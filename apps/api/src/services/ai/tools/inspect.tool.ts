import type { ProjectState } from "./project-state.js";

function timelineEnd(state: ProjectState): number {
  let max = 0;
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      max = Math.max(max, clip.startTime + clip.duration);
    }
  }
  return max;
}

export const inspectToolDefinitions = [
  {
    name: "inspect_timeline",
    description:
      "Observe the current timeline after edits. Returns a structured summary of tracks, clips, overlaps, gaps, and audio settings. Call this after every 3–5 mutating tool calls and before claiming the edit is done.",
    parameters: {
      type: "object" as const,
      properties: {
        focusTrackId: {
          type: "string",
          description: "Optional track id to detail more deeply",
        },
      },
      required: [],
    },
  },
  {
    name: "get_project_summary",
    description:
      "High-level project summary: duration, track/clip counts, media usage, and mixer state. Use for planning or when the user asks what is on the timeline.",
    parameters: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

export const inspectToolExecutors: Record<
  string,
  (args: Record<string, any>, state: ProjectState) => { result: string; state: ProjectState }
> = {
  inspect_timeline: (args, state) => {
    const lines: string[] = [];
    const end = timelineEnd(state);
    lines.push(`Timeline end: ${end.toFixed(2)}s | tracks: ${state.tracks.length}`);
    lines.push(`3D scene: ${(state.cameras || []).filter((camera) => camera.enabled).length} active camera(s), ${(state.lights || []).filter((light) => light.enabled).length} active light(s)`);

    const sorted = [...state.tracks].sort((a, b) => a.order - b.order);
    for (const track of sorted) {
      if (args.focusTrackId && track.id !== args.focusTrackId) continue;

      lines.push(
        `Track "${track.name}" id=${track.id} type=${track.type} order=${track.order} visible=${track.visible} locked=${track.locked} solo=${track.solo} clips=${track.clips.length}`
      );

      const clips = [...track.clips].sort((a, b) => a.startTime - b.startTime);
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i]!;
        const bits = [
          `id=${c.id}`,
          `${c.startTime.toFixed(2)}→${(c.startTime + c.duration).toFixed(2)}s`,
          `dur=${c.duration.toFixed(2)}`,
          `media=${c.sourceMediaId ?? "none"}`,
          `sourceOffset=${c.sourceOffset.toFixed(3)}`,
          `sourceRange=${c.sourceOffset.toFixed(3)}→${(c.sourceOffset + c.duration * c.speed).toFixed(3)}`,
          `vol=${c.volume}`,
          `muted=${c.muted}`,
          `fadeIn=${c.fadeInSec ?? 0}`,
          `fadeOut=${c.fadeOutSec ?? 0}`,
          `speed=${c.speed}`,
          `rev=${c.reversed ? 1 : 0}`,
          `ramp=${c.speedRamp?.length ?? 0}`,
          `opacity=${c.opacity}`,
          `fx=${c.effects.length}`,
          `fxKf=${c.effects.reduce((n, e) => n + (e.keyframes?.length || 0), 0)}`,
          `kf=${c.keyframes.length}`,
          `chroma=${c.chromaKey ? 1 : 0}`,
          `parent=${c.parentId ?? "none"}`,
          `matte=${c.trackMatte ? `${c.trackMatte.type}:${c.trackMatte.sourceClipId}` : "none"}`,
          `null=${c.nullLayer ? 1 : 0}`,
          `motionTrack=${c.motionTrack ? `${c.motionTrack.subject}:${c.motionTrack.samples.length}` : "none"}`,
          `planarTrack=${c.planarTrack ? `${c.planarTrack.surface}:${c.planarTrack.samples.length}` : "none"}`,
          `motionBlur=${c.motionBlur?.enabled ? `${c.motionBlur.shutterAngle}deg/${c.motionBlur.samples}` : "off"}`,
          `3d=${c.transform3D ? `z:${c.transform3D.z},rx:${c.transform3D.rotationX},ry:${c.transform3D.rotationY}` : "off"}`,
          `motionGraph=${c.motionGraph ? `${c.motionGraph.name}:${c.motionGraph.nodes.length}` : "none"}`,
        ];
        if (c.sourceSequenceId) {
          const seqName =
            state.sequences?.find((s) => s.id === c.sourceSequenceId)?.name || "?";
          bits.push(`nest=${c.sourceSequenceId}`, `nestName="${seqName}"`);
        }
        if (c.textParams?.text) bits.push(`text="${c.textParams.text.slice(0, 40)}"`);
        if (c.captionBinding) {
          bits.push(
            `captionSource=${c.captionBinding.sourceClipId}`,
            `transcriptRevision=${c.captionBinding.transcriptRevision}`,
            `captionStale=${Boolean(c.captionBinding.stale)}`
          );
        }
        if (c.shapeParams?.shape) bits.push(`shape=${c.shapeParams.shape}`);
        lines.push(`  - ${bits.join(" | ")}`);

        const next = clips[i + 1];
        if (next) {
          const gap = next.startTime - (c.startTime + c.duration);
          if (gap < -0.001) {
            lines.push(`    ! OVERLAP with next by ${(-gap).toFixed(2)}s`);
          } else if (gap > 0.05) {
            lines.push(`    gap ${gap.toFixed(2)}s before next`);
          }
        }
      }
    }

    if (args.focusTrackId && !state.tracks.some((t) => t.id === args.focusTrackId)) {
      lines.push(`Warning: focusTrackId ${args.focusTrackId} not found`);
    }

    const mixer = state.audioMixer;
    if (mixer) {
      lines.push(
        `Mixer: master=${mixer.masterVolume} trackVolumes=${JSON.stringify(mixer.trackVolumes)} trackMutes=${JSON.stringify(mixer.trackMutes)}`
      );
    }

    return { result: lines.join("\n"), state };
  },

  get_project_summary: (_args, state) => {
    const end = timelineEnd(state);
    let clipCount = 0;
    let textCount = 0;
    let mediaClips = 0;
    let nestClips = 0;
    const types: Record<string, number> = {};

    for (const track of state.tracks) {
      types[track.type] = (types[track.type] || 0) + 1;
      for (const clip of track.clips) {
        clipCount++;
        if (clip.textParams) textCount++;
        if (clip.sourceMediaId) mediaClips++;
        if (clip.sourceSequenceId) nestClips++;
      }
    }

    const soloed = state.tracks.filter((t) => t.solo).map((t) => t.name);
    const summary = {
      durationSec: Number(end.toFixed(2)),
      trackCount: state.tracks.length,
      tracksByType: types,
      clipCount,
      mediaClips,
      textClips: textCount,
      nestClips,
      sequenceCount: state.sequences?.length ?? 0,
      soloedTracks: soloed,
      masterVolume: state.audioMixer?.masterVolume ?? 1,
      beatGridSize: state.beatTimes?.length ?? 0,
    };

    return { result: JSON.stringify(summary, null, 2), state };
  },
};
