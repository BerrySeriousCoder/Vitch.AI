import { create } from "zustand";

interface PanelSizes {
  mediaBin: number;
  inspector: number;
  timeline: number;
}

interface UIState {
  panels: {
    mediaBin: boolean;
    inspector: boolean;
    timeline: boolean;
    aiChat: boolean;
    layers: boolean;
    effects: boolean;
    graphics: boolean;
    tracking: boolean;
    compositing: boolean;
    motionGraph: boolean;
    history: boolean;
    audioMixer: boolean;
    exportDialog: boolean;
    shortcutReference: boolean;
  };

  panelSizes: PanelSizes;

  timelineZoom: number;
  previewQuality: "auto" | "proxy" | "original";
  snapEnabled: boolean;
  snapSources: {
    clipEdges: boolean;
    playhead: boolean;
    markers: boolean;
  };

  togglePanel: (panel: keyof UIState["panels"]) => void;
  setPanelSize: (panel: keyof PanelSizes, size: number) => void;
  setTimelineZoom: (zoom: number) => void;
  setPreviewQuality: (quality: UIState["previewQuality"]) => void;
  toggleSnap: () => void;
  toggleSnapSource: (source: keyof UIState["snapSources"]) => void;
}

export const useUIStore = create<UIState>((set) => ({
  panels: {
    mediaBin: true,
    inspector: true,
    timeline: true,
    aiChat: false,
    layers: false,
    effects: false,
    graphics: false,
    tracking: false,
    compositing: false,
    motionGraph: false,
    history: false,
    audioMixer: false,
    exportDialog: false,
    shortcutReference: false,
  },

  panelSizes: {
    mediaBin: 256,
    inspector: 288,
    timeline: 256,
  },

  timelineZoom: 50,
  previewQuality: "auto",
  snapEnabled: true,
  snapSources: { clipEdges: true, playhead: true, markers: true },

  togglePanel: (panel) =>
    set((state) => ({
      panels: { ...state.panels, [panel]: !state.panels[panel] },
    })),

  setPanelSize: (panel, size) =>
    set((state) => ({
      panelSizes: { ...state.panelSizes, [panel]: size },
    })),

  setTimelineZoom: (zoom) =>
    set({ timelineZoom: Math.max(10, Math.min(200, zoom)) }),

  setPreviewQuality: (previewQuality) => set({ previewQuality }),

  toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),
  toggleSnapSource: (source) =>
    set((state) => ({
      snapSources: { ...state.snapSources, [source]: !state.snapSources[source] },
    })),
}));
