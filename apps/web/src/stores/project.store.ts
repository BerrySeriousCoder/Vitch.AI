import { create } from "zustand";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import { useTimelineStore } from "./timeline.store";
import { usePlaybackStore } from "./playback.store";
import { useSequenceStore } from "./sequence.store";
import type {
  ProjectSettings,
  Track,
  AudioMixer,
  Transition,
  EditPlan,
  StyleDNA,
  Sequence,
  Camera3D,
  Light3D,
  TimelineMarker,
  BrandKit,
  GraphicTemplate,
} from "@tempo/types";
import { getDeliveryProfile } from "@tempo/editor-core";

interface StyleDnaLibraryEntry {
  id: string;
  name: string;
  dna: StyleDNA;
  createdAt: string;
}

interface ProjectState {
  id: string | null;
  name: string;
  settings: ProjectSettings;
  audioMixer: AudioMixer;
  editPlan: EditPlan | null;
  styleDnaLibrary: StyleDnaLibraryEntry[];
  cameras: Camera3D[];
  lights: Light3D[];
  markers: TimelineMarker[];
  brandKit: BrandKit | null;
  graphicTemplates: GraphicTemplate[];
  isLoading: boolean;
  isSaving: boolean;
  lastSavedAt: string | null;
  hasUnsavedChanges: boolean;
  saveError: string | null;

  loadProject: (id: string) => Promise<boolean>;
  saveProject: () => Promise<void>;
  setName: (name: string) => void;
  updateSettings: (settings: Partial<ProjectSettings>) => void;
  setAudioMixer: (mixer: AudioMixer) => void;
  setEditPlan: (plan: EditPlan | null) => void;
  setStyleDnaLibrary: (lib: StyleDnaLibraryEntry[]) => void;
  setCameras: (cameras: Camera3D[]) => void;
  setLights: (lights: Light3D[]) => void;
  setMarkers: (markers: TimelineMarker[]) => void;
  setBrandKit: (brandKit: BrandKit | null) => void;
  setGraphicTemplates: (templates: GraphicTemplate[]) => void;
  applyAgentSurfaces: (surfaces: {
    settings?: ProjectSettings;
    audioMixer?: AudioMixer;
    editPlan?: EditPlan | null;
    styleDnaLibrary?: StyleDnaLibraryEntry[];
    cameras?: Camera3D[];
    lights?: Light3D[];
    markers?: TimelineMarker[];
    brandKit?: BrandKit | null;
    graphicTemplates?: GraphicTemplate[];
  }) => void;
  exportProjectJSON: () => void;
  reset: () => void;
}

const defaultSettings: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 0,
  backgroundColor: "#000000",
  sampleRate: 44100,
  deliveryProfile: getDeliveryProfile("youtube-landscape"),
};

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let autosaveUnsub: (() => void) | null = null;
let sequenceAutosaveUnsub: (() => void) | null = null;
let activeSavePromise: Promise<void> | null = null;
let changeRevision = 0;

function armAutosave(get: () => ProjectState) {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    const state = get();
    if (state.id && !state.isSaving) void state.saveProject();
  }, 3000);
}

function scheduleAutosave(get: () => ProjectState, set: (partial: Partial<ProjectState>) => void) {
  changeRevision += 1;
  set({ hasUnsavedChanges: true });
  armAutosave(get);
}

const defaultMixer: AudioMixer = {
  masterVolume: 1,
  trackVolumes: {},
  trackPans: {},
  trackMutes: {},
  trackAutomation: {},
  trackRoles: {},
  duck: { enabled: false, level: 0.25, attackSec: 0.12, releaseSec: 0.25 },
};

function normalizeAudioMixer(mixer?: AudioMixer): AudioMixer {
  return {
    ...defaultMixer,
    ...(mixer || {}),
    trackVolumes: { ...(mixer?.trackVolumes || {}) },
    trackPans: { ...(mixer?.trackPans || {}) },
    trackMutes: { ...(mixer?.trackMutes || {}) },
    trackAutomation: structuredClone(mixer?.trackAutomation || {}),
    trackRoles: { ...(mixer?.trackRoles || {}) },
    duck: mixer?.duck ? { ...mixer.duck } : { ...defaultMixer.duck! },
    trackEq: mixer?.trackEq ? structuredClone(mixer.trackEq) : undefined,
    trackPost: mixer?.trackPost ? structuredClone(mixer.trackPost) : undefined,
    mastering: mixer?.mastering ? { ...mixer.mastering } : undefined,
  };
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  id: null,
  name: "Untitled Project",
  settings: { ...defaultSettings },
  audioMixer: normalizeAudioMixer(),
  editPlan: null,
  styleDnaLibrary: [],
  cameras: [],
  lights: [],
  markers: [],
  brandKit: null,
  graphicTemplates: [],
  isLoading: false,
  isSaving: false,
  lastSavedAt: null,
  hasUnsavedChanges: false,
  saveError: null,

  loadProject: async (id) => {
    set({ isLoading: true });

    const res = await apiFetch<{
      id: string;
      name: string;
      settings: ProjectSettings;
      updatedAt?: string;
      data: {
        tracks?: Track[];
        audioMixer?: AudioMixer;
        transitions?: Transition[];
        editPlan?: EditPlan | null;
        styleDnaLibrary?: StyleDnaLibraryEntry[];
        sequences?: Sequence[];
        cameras?: Camera3D[];
        lights?: Light3D[];
        markers?: TimelineMarker[];
        brandKit?: BrandKit | null;
        graphicTemplates?: GraphicTemplate[];
      };
    }>(`/api/projects/${id}`);

    if (res.success && res.data) {
      changeRevision = 0;
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
      }
      const settings = { ...defaultSettings, ...(res.data.settings as ProjectSettings) };
      const data = res.data.data || {};
      set({
        id: res.data.id,
        name: res.data.name,
        settings,
        audioMixer: normalizeAudioMixer(data.audioMixer),
        editPlan: data.editPlan ?? null,
        styleDnaLibrary: Array.isArray(data.styleDnaLibrary) ? data.styleDnaLibrary : [],
        cameras: Array.isArray(data.cameras) ? data.cameras : [],
        lights: Array.isArray(data.lights) ? data.lights : [],
        markers: Array.isArray(data.markers) ? data.markers : [],
        brandKit: data.brandKit ?? null,
        graphicTemplates: Array.isArray(data.graphicTemplates) ? data.graphicTemplates : [],
        isLoading: false,
        lastSavedAt: res.data.updatedAt || null,
        hasUnsavedChanges: false,
        saveError: null,
      });

      const sequences = Array.isArray(data.sequences) ? data.sequences : [];
      useSequenceStore.getState().reset();
      useSequenceStore.getState().setSequences(sequences);
      useTimelineStore.getState().setTimeline(data.tracks || [], data.transitions || []);
      useSequenceStore.setState({
        mainTracks: data.tracks || [],
        mainTransitions: data.transitions || [],
      });
      usePlaybackStore.getState().setDuration(settings.duration || 0);

      // Setup autosave: debounce 3s after timeline changes
      if (autosaveUnsub) autosaveUnsub();
      autosaveUnsub = useTimelineStore.subscribe(() => {
        scheduleAutosave(get, set);
      });
      // Also autosave when sequence library changes
      if (sequenceAutosaveUnsub) sequenceAutosaveUnsub();
      sequenceAutosaveUnsub = useSequenceStore.subscribe((state, previous) => {
        if (
          state.sequences !== previous.sequences ||
          state.mainTracks !== previous.mainTracks ||
          state.mainTransitions !== previous.mainTransitions
        ) {
          scheduleAutosave(get, set);
        }
      });

      return true;
    }

    set({ isLoading: false });
    return false;
  },

  saveProject: async () => {
    // Agent runs use this as a durability barrier. If autosave is already in
    // flight, wait for it and then save the newest revision rather than
    // allowing the agent to read stale dimensions/timeline state.
    while (activeSavePromise) await activeSavePromise;
    const { id, name, settings, audioMixer, editPlan, styleDnaLibrary, cameras, lights, markers, brandKit, graphicTemplates } = get();
    if (!id) return;

    const revisionBeingSaved = changeRevision;
    const operation = (async () => {
      set({ isSaving: true, saveError: null });

      const seqStore = useSequenceStore.getState();
      const { tracks, transitions } = seqStore.getMainTimelineForSave();
      const sequences = seqStore.getSequencesForSave();
      const data = { tracks, audioMixer, transitions, editPlan, styleDnaLibrary, sequences, cameras, lights, markers, brandKit, graphicTemplates };

      const res = await apiFetch(`/api/projects/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, settings, data }),
      });

      if (res.success) {
        const changedWhileSaving = changeRevision !== revisionBeingSaved;
        set({
          isSaving: false,
          lastSavedAt: new Date().toISOString(),
          hasUnsavedChanges: changedWhileSaving,
          saveError: null,
        });
        if (changedWhileSaving) armAutosave(get);
      } else {
        const errMsg = "Failed to save project";
        set({ isSaving: false, saveError: errMsg });
        toast.error(errMsg);
      }
    })();
    activeSavePromise = operation;
    try {
      await operation;
    } finally {
      if (activeSavePromise === operation) activeSavePromise = null;
    }
  },

  setName: (name) => {
    set({ name });
    scheduleAutosave(get, set);
  },

  updateSettings: (partial) => {
    set((state) => ({
      settings: { ...state.settings, ...partial },
    }));
    scheduleAutosave(get, set);
  },

  setAudioMixer: (mixer) => {
    set({ audioMixer: normalizeAudioMixer(mixer) });
    scheduleAutosave(get, set);
  },

  setEditPlan: (plan) => {
    set({ editPlan: plan });
    scheduleAutosave(get, set);
  },

  setStyleDnaLibrary: (lib) => {
    set({ styleDnaLibrary: lib });
    scheduleAutosave(get, set);
  },

  setCameras: (cameras) => { set({ cameras }); scheduleAutosave(get, set); },
  setLights: (lights) => { set({ lights }); scheduleAutosave(get, set); },
  setMarkers: (markers) => { set({ markers }); scheduleAutosave(get, set); },
  setBrandKit: (brandKit) => { set({ brandKit }); scheduleAutosave(get, set); },
  setGraphicTemplates: (graphicTemplates) => { set({ graphicTemplates }); scheduleAutosave(get, set); },

  applyAgentSurfaces: (surfaces) => {
    const patch: Partial<ProjectState> = {};
    if (surfaces.settings) patch.settings = surfaces.settings;
    if (surfaces.audioMixer) patch.audioMixer = normalizeAudioMixer(surfaces.audioMixer);
    if (surfaces.editPlan !== undefined) patch.editPlan = surfaces.editPlan;
    if (surfaces.styleDnaLibrary) patch.styleDnaLibrary = surfaces.styleDnaLibrary;
    if (surfaces.cameras) patch.cameras = surfaces.cameras;
    if (surfaces.lights) patch.lights = surfaces.lights;
    if (surfaces.markers) patch.markers = surfaces.markers;
    if (surfaces.brandKit !== undefined) patch.brandKit = surfaces.brandKit;
    if (surfaces.graphicTemplates) patch.graphicTemplates = surfaces.graphicTemplates;
    if (Object.keys(patch).length === 0) return;
    set(patch);
    scheduleAutosave(get, set);
  },

  exportProjectJSON: () => {
    const { name, settings, audioMixer, editPlan, styleDnaLibrary, cameras, lights, markers, brandKit, graphicTemplates } = get();
    const seqStore = useSequenceStore.getState();
    const { tracks, transitions } = seqStore.getMainTimelineForSave();
    const sequences = seqStore.getSequencesForSave();
    const data = {
      name,
      settings,
      audioMixer,
      editPlan,
      styleDnaLibrary,
      cameras,
      lights,
      markers,
      brandKit,
      graphicTemplates,
      tracks,
      transitions,
      sequences,
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.tempo.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Project exported");
  },

  reset: () => {
    changeRevision = 0;
    if (autosaveUnsub) {
      autosaveUnsub();
      autosaveUnsub = null;
    }
    if (sequenceAutosaveUnsub) {
      sequenceAutosaveUnsub();
      sequenceAutosaveUnsub = null;
    }
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
    set({
      id: null,
      name: "Untitled Project",
      settings: { ...defaultSettings },
      audioMixer: normalizeAudioMixer(),
      editPlan: null,
      styleDnaLibrary: [],
      cameras: [],
      lights: [],
      markers: [],
      brandKit: null,
      graphicTemplates: [],
      isLoading: false,
      isSaving: false,
      lastSavedAt: null,
      hasUnsavedChanges: false,
      saveError: null,
    });
    useSequenceStore.getState().reset();
  },
}));
