import type { Track, AudioMixer, EditBlueprint, MediaAsset, FontAsset, Transition, StyleDNA, ProjectSettings } from "@tempo/types";
import { timelineToolDefinitions, timelineToolExecutors } from "./timeline.tool.js";
import { effectsToolDefinitions, effectsToolExecutors } from "./effects.tool.js";
import { motionGraphicsToolDefinitions, motionGraphicsToolExecutors } from "./motion-graphics.tool.js";
import { audioToolDefinitions, audioToolExecutors } from "./audio.tool.js";
import { keyframeToolDefinitions, keyframeToolExecutors } from "./keyframes.tool.js";
import { inspectToolDefinitions, inspectToolExecutors } from "./inspect.tool.js";
import { mediaToolDefinitions, mediaToolExecutors } from "./media.tool.js";
import { captionsToolDefinitions, captionsToolExecutors } from "./captions.tool.js";
import { fontsToolDefinitions, fontsToolExecutors } from "./fonts.tool.js";
import { transitionsToolDefinitions, transitionsToolExecutors } from "./transitions.tool.js";
import { masksToolDefinitions, masksToolExecutors } from "./masks.tool.js";
import { planToolDefinitions, planToolExecutors } from "./plan.tool.js";
import { critiqueToolDefinitions, critiqueToolExecutors } from "./critique.tool.js";
import {
  intelligenceToolDefinitions,
  intelligenceToolExecutors,
} from "./intelligence.tool.js";
import { packsToolDefinitions, packsToolExecutors } from "./packs.tool.js";
import { speedToolDefinitions, speedToolExecutors } from "./speed.tool.js";
import { chromaToolDefinitions, chromaToolExecutors } from "./chroma.tool.js";
import { sequencesToolDefinitions, sequencesToolExecutors } from "./sequences.tool.js";
import {
  adjustmentLayerToolDefinitions,
  adjustmentLayerToolExecutors,
} from "./adjustment-layers.tool.js";
import { cropToolDefinitions, cropToolExecutors } from "./crop.tool.js";
import { colorMatchToolDefinitions, colorMatchToolExecutors } from "./color-match.tool.js";
import { compositingToolDefinitions, compositingToolExecutors } from "./compositing.tool.js";
import { markerToolDefinitions, markerToolExecutors } from "./markers.tool.js";
import { graphicsLibraryToolDefinitions, graphicsLibraryToolExecutors } from "./graphics-library.tool.js";
import { layoutToolDefinitions, layoutToolExecutors } from "./layout.tool.js";
import { referenceToolDefinitions, referenceToolExecutors } from "./reference.tool.js";
import {
  type ProjectState,
  DEFAULT_AUDIO_MIXER,
  ensureAudioMixer,
} from "./project-state.js";

export type { ProjectState } from "./project-state.js";
export { DEFAULT_AUDIO_MIXER, ensureAudioMixer };

export type ToolExecutor = (
  args: Record<string, any>,
  state: ProjectState
) =>
  | { result: string; state: ProjectState }
  | Promise<{ result: string; state: ProjectState }>;

export interface ToolEntry {
  definition: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
  execute: ToolExecutor;
}

const allDefinitions = [
  ...timelineToolDefinitions,
  ...effectsToolDefinitions,
  ...motionGraphicsToolDefinitions,
  ...audioToolDefinitions,
  ...keyframeToolDefinitions,
  ...inspectToolDefinitions,
  ...mediaToolDefinitions,
  ...captionsToolDefinitions,
  ...fontsToolDefinitions,
  ...transitionsToolDefinitions,
  ...masksToolDefinitions,
  ...planToolDefinitions,
  ...critiqueToolDefinitions,
  ...intelligenceToolDefinitions,
  ...packsToolDefinitions,
  ...speedToolDefinitions,
  ...chromaToolDefinitions,
  ...sequencesToolDefinitions,
  ...adjustmentLayerToolDefinitions,
  ...cropToolDefinitions,
  ...colorMatchToolDefinitions,
  ...compositingToolDefinitions,
  ...markerToolDefinitions,
  ...graphicsLibraryToolDefinitions,
  ...layoutToolDefinitions,
  ...referenceToolDefinitions,
];

const allExecutors = {
  ...timelineToolExecutors,
  ...effectsToolExecutors,
  ...motionGraphicsToolExecutors,
  ...audioToolExecutors,
  ...keyframeToolExecutors,
  ...inspectToolExecutors,
  ...mediaToolExecutors,
  ...captionsToolExecutors,
  ...fontsToolExecutors,
  ...transitionsToolExecutors,
  ...masksToolExecutors,
  ...planToolExecutors,
  ...critiqueToolExecutors,
  ...intelligenceToolExecutors,
  ...packsToolExecutors,
  ...speedToolExecutors,
  ...chromaToolExecutors,
  ...sequencesToolExecutors,
  ...adjustmentLayerToolExecutors,
  ...cropToolExecutors,
  ...colorMatchToolExecutors,
  ...compositingToolExecutors,
  ...markerToolExecutors,
  ...graphicsLibraryToolExecutors,
  ...layoutToolExecutors,
  ...referenceToolExecutors,
} as Record<string, ToolExecutor>;

const registry = new Map<string, ToolEntry>();

for (const def of allDefinitions) {
  if (registry.has(def.name)) {
    throw new Error(`Duplicate AI tool definition: ${def.name}`);
  }
  const executor = allExecutors[def.name];
  if (!executor) {
    throw new Error(`AI tool definition has no executor: ${def.name}`);
  }
  registry.set(def.name, { definition: def, execute: executor });
}

const definedToolNames = new Set(allDefinitions.map((definition) => definition.name));
for (const executorName of Object.keys(allExecutors)) {
  if (!definedToolNames.has(executorName)) {
    throw new Error(`AI tool executor has no definition: ${executorName}`);
  }
}

export function getToolDefinitions() {
  return allDefinitions;
}

export function getToolExecutor(name: string): ToolExecutor | undefined {
  return registry.get(name)?.execute;
}

export function getAllTools(): ToolEntry[] {
  return Array.from(registry.values());
}

export function createProjectState(
  tracks: Track[],
  audioMixer?: AudioMixer,
  opts?: {
    beatTimes?: number[];
    editBlueprint?: EditBlueprint | null;
    styleDna?: StyleDNA | null;
    mediaAssets?: MediaAsset[];
    fontAssets?: FontAsset[];
    transitions?: Transition[];
    sequences?: import("@tempo/types").Sequence[];
    cameras?: import("@tempo/types").Camera3D[];
    lights?: import("@tempo/types").Light3D[];
    projectId?: string;
    editPlan?: import("@tempo/types").EditPlan | null;
    styleDnaLibrary?: ProjectState["styleDnaLibrary"];
    markers?: import("@tempo/types").TimelineMarker[];
    brandKit?: import("@tempo/types").BrandKit | null;
    graphicTemplates?: import("@tempo/types").GraphicTemplate[];
    settings?: ProjectSettings;
  }
): ProjectState {
  const mixer = audioMixer
    ? {
        masterVolume: audioMixer.masterVolume ?? 1,
        trackVolumes: { ...(audioMixer.trackVolumes || {}) },
        trackPans: { ...(audioMixer.trackPans || {}) },
        trackMutes: { ...(audioMixer.trackMutes || {}) },
        trackAutomation: audioMixer.trackAutomation
          ? JSON.parse(JSON.stringify(audioMixer.trackAutomation))
          : {},
        trackRoles: { ...(audioMixer.trackRoles || {}) },
        duck: audioMixer.duck ? { ...audioMixer.duck } : undefined,
        trackEq: audioMixer.trackEq
          ? Object.fromEntries(
              Object.entries(audioMixer.trackEq).map(([id, eq]) => [
                id,
                { ...eq },
              ])
            )
          : undefined,
        trackPost: audioMixer.trackPost
          ? JSON.parse(JSON.stringify(audioMixer.trackPost))
          : undefined,
        mastering: audioMixer.mastering ? { ...audioMixer.mastering } : undefined,
      }
    : {
        masterVolume: DEFAULT_AUDIO_MIXER.masterVolume,
        trackVolumes: {},
        trackPans: {},
        trackMutes: {},
        trackAutomation: {},
        trackRoles: {},
        duck: DEFAULT_AUDIO_MIXER.duck ? { ...DEFAULT_AUDIO_MIXER.duck } : undefined,
      };

  return {
    tracks: JSON.parse(JSON.stringify(tracks)),
    settings: opts?.settings
      ? JSON.parse(JSON.stringify(opts.settings))
      : {
          width: 1920,
          height: 1080,
          fps: 30,
          duration: 0,
          backgroundColor: "#000000",
          sampleRate: 44100,
        },
    audioMixer: mixer,
    projectId: opts?.projectId,
    mediaAssets: opts?.mediaAssets
      ? JSON.parse(JSON.stringify(opts.mediaAssets))
      : [],
    fontAssets: opts?.fontAssets
      ? JSON.parse(JSON.stringify(opts.fontAssets))
      : [],
    transitions: opts?.transitions
      ? JSON.parse(JSON.stringify(opts.transitions))
      : [],
    sequences: opts?.sequences
      ? JSON.parse(JSON.stringify(opts.sequences))
      : [],
    cameras: opts?.cameras ? JSON.parse(JSON.stringify(opts.cameras)) : [],
    lights: opts?.lights ? JSON.parse(JSON.stringify(opts.lights)) : [],
    markers: opts?.markers ? JSON.parse(JSON.stringify(opts.markers)) : [],
    brandKit: opts?.brandKit ? JSON.parse(JSON.stringify(opts.brandKit)) : null,
    graphicTemplates: opts?.graphicTemplates ? JSON.parse(JSON.stringify(opts.graphicTemplates)) : [],
    beatTimes: opts?.beatTimes,
    editBlueprint: opts?.editBlueprint ?? null,
    styleDna: opts?.styleDna ?? null,
    editPlan: opts?.editPlan ?? null,
    styleDnaLibrary: opts?.styleDnaLibrary
      ? JSON.parse(JSON.stringify(opts.styleDnaLibrary))
      : [],
  };
}

/** Tools that mutate project state (used for observe nudges / mid-run updates). */
export const MUTATING_TOOL_NAMES = new Set([
  "add_track",
  "remove_track",
  "reorder_track",
  "set_track_flags",
  "add_clip",
  "move_clip",
  "trim_clip",
  "split_clip",
  "delete_clip",
  "ripple_delete_clip",
  "close_gap",
  "ripple_trim_clip",
  "replace_clip_media",
  "roll_edit",
  "slide_edit",
  "slip_edit",
  "link_clips",
  "unlink_clips",
  "ripple_delete_linked_group",
  "duplicate_clip",
  "add_effect",
  "set_effect_params",
  "set_clip_input_color_space",
  "remove_effect",
  "set_effect_enabled",
  "reorder_effects",
  "copy_clip_attributes",
  "apply_effect_preset",
  "set_clip_property",
  "source_edit",
  "add_text_clip",
  "add_shape_clip",
  "add_lottie_clip",
  "update_text_clip",
  "update_shape_clip",
  "apply_text_animator_preset",
  "set_text_animators",
  "clear_text_animators",
  "apply_title_template",
  "set_volume",
  "mute_clip",
  "fade_audio",
  "crossfade_audio",
  "set_master_volume",
  "set_track_volume",
  "set_track_pan",
  "set_clip_audio_automation",
  "set_track_audio_automation",
  "mute_track",
  "sync_clips_to_beats",
  "add_music_track",
  "add_keyframe",
  "set_keyframe_curve",
  "remove_keyframe",
  "update_keyframe",
  "clear_keyframes",
  "apply_animation_preset",
  "apply_effect_animation_preset",
  "create_captions_from_transcript",
  "create_captions_for_clip",
  "regenerate_captions_for_clip",
  "apply_caption_preset",
  "snap_captions_to_beats",
  "set_text_font",
  "add_transition",
  "apply_transition_to_cuts",
  "set_clip_hold",
  "set_clip_speed",
  "set_speed_ramp",
  "set_retime_quality",
  "clear_speed_ramp",
  "apply_speed_preset",
  "update_transition",
  "remove_transition",
  "set_clip_mask",
  "clear_clip_mask",
  "set_clip_crop",
  "set_media_fit",
  "set_media_viewport",
  "clear_media_viewport",
  "clear_clip_crop",
  "apply_ken_burns",
  "create_sequence",
  "place_sequence_clip",
  "rename_sequence",
  "delete_sequence",
  "set_clip_chroma_key",
  "clear_clip_chroma_key",
  "set_track_audio_role",
  "set_audio_duck",
  "set_track_eq",
  "set_track_audio_post",
  "apply_voice_post_preset",
  "set_mastering",
  "create_edit_plan",
  "execute_next_plan_step",
  "update_plan_step",
  "reopen_failed_plan_steps",
  "save_style_dna",
  "apply_style_dna",
  "match_clip_color",
  "apply_reference_color_match",
  "apply_preset",
  "add_adjustment_layer",
  "add_null_controller",
  "create_multicam_clip",
  "cut_multicam_angle",
  "set_multicam_audio_angle",
  "analyze_multicam_sync",
  "set_clip_parent",
  "clear_clip_parent",
  "set_track_matte",
  "clear_track_matte",
  "refine_track_matte",
  "set_roto_matte_region",
  "set_motion_track",
  "clear_motion_track",
  "set_planar_track",
  "clear_planar_track",
  "set_motion_blur",
  "set_3d_transform",
  "set_motion_graph",
  "add_3d_camera",
  "set_3d_camera",
  "add_3d_light",
  "analyze_motion_track",
  "analyze_optical_flow",
  "analyze_planar_track",
  "analyze_stabilization",
  "set_stabilization",
  "clear_stabilization",
  "create_ai_subject_matte",
  "add_marker",
  "set_brand_kit",
  "save_graphic_template",
  "apply_graphic_template",
  "set_graphic_layout",
  "update_marker",
  "remove_marker",
]);
