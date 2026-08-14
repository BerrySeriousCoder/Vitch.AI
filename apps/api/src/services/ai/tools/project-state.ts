import type {
  Track,
  AudioMixer,
  EditBlueprint,
  MediaAsset,
  FontAsset,
  LutAsset,
  Transition,
  StyleDNA,
  EditPlan,
  Sequence,
  Camera3D,
  Light3D,
  TimelineMarker,
  BrandKit,
  GraphicTemplate,
  ProjectSettings,
} from "@tempo/types";

export interface ProjectState {
  tracks: Track[];
  /** Composition and frozen platform-delivery contract used by geometry tools. */
  settings?: ProjectSettings;
  audioMixer: AudioMixer;
  /** Project id (for refreshing media analysis mid-run) */
  projectId?: string;
  /** Project media library (with analysis when ready) */
  mediaAssets?: MediaAsset[];
  /** Project uploaded fonts */
  fontAssets?: FontAsset[];
  /** Project uploaded LUTs */
  lutAssets?: LutAsset[];
  /** Edit-point transitions */
  transitions?: Transition[];
  /** Nested sequence library */
  sequences?: Sequence[];
  cameras?: Camera3D[];
  lights?: Light3D[];
  markers?: TimelineMarker[];
  brandKit?: BrandKit | null;
  graphicTemplates?: GraphicTemplate[];
  /** Optional beat grid from Edit Like This blueprint */
  beatTimes?: number[];
  editBlueprint?: EditBlueprint | null;
  /** Successful reference reads performed during the current agent run. */
  referenceEvidence?: Array<{
    kind: "blueprint" | "transcript" | "video" | "comparison";
    at: string;
    startTime?: number;
    endTime?: number;
  }>;
  /** Abstract Style DNA from Edit Like This */
  styleDna?: StyleDNA | null;
  /** Structured edit plan for the current request */
  editPlan?: EditPlan | null;
  /** Saved Style DNA library entries (project-scoped) */
  styleDnaLibrary?: Array<{
    id: string;
    name: string;
    dna: StyleDNA;
    createdAt: string;
  }>;
}

export const DEFAULT_AUDIO_MIXER: AudioMixer = {
  masterVolume: 1,
  trackVolumes: {},
  trackPans: {},
  trackMutes: {},
  trackAutomation: {},
  trackRoles: {},
  duck: { enabled: false, level: 0.25, attackSec: 0.12, releaseSec: 0.25 },
};

export function ensureAudioMixer(state: ProjectState): AudioMixer {
  if (!state.audioMixer) {
    state.audioMixer = {
      ...DEFAULT_AUDIO_MIXER,
      trackVolumes: {},
      trackPans: {},
      trackMutes: {},
      trackAutomation: {},
      trackRoles: {},
    };
  }
  if (!state.audioMixer.trackRoles) state.audioMixer.trackRoles = {};
  if (!state.audioMixer.trackPans) state.audioMixer.trackPans = {};
  if (!state.audioMixer.trackAutomation) state.audioMixer.trackAutomation = {};
  if (!state.audioMixer.duck) {
    state.audioMixer.duck = { ...DEFAULT_AUDIO_MIXER.duck! };
  }
  return state.audioMixer;
}
