import { create } from "zustand";

interface SelectionState {
  /** Currently selected clip IDs */
  selectedClipIds: Set<string>;
  /** Currently selected track ID */
  selectedTrackId: string | null;

  /** Select a single clip (clears previous selection) */
  selectClip: (clipId: string) => void;

  /** Toggle a clip in the selection (for multi-select) */
  toggleClip: (clipId: string) => void;

  /** Select multiple clips */
  selectClips: (clipIds: string[]) => void;

  /** Select a track */
  selectTrack: (trackId: string) => void;

  /** Clear all selection */
  deselectAll: () => void;

  /** Check if a clip is selected */
  isClipSelected: (clipId: string) => boolean;
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  selectedClipIds: new Set(),
  selectedTrackId: null,

  selectClip: (clipId) =>
    set({ selectedClipIds: new Set([clipId]) }),

  toggleClip: (clipId) =>
    set((state) => {
      const next = new Set(state.selectedClipIds);
      if (next.has(clipId)) {
        next.delete(clipId);
      } else {
        next.add(clipId);
      }
      return { selectedClipIds: next };
    }),

  selectClips: (clipIds) =>
    set({ selectedClipIds: new Set(clipIds) }),

  selectTrack: (trackId) =>
    set({ selectedTrackId: trackId }),

  deselectAll: () =>
    set({ selectedClipIds: new Set(), selectedTrackId: null }),

  isClipSelected: (clipId) => get().selectedClipIds.has(clipId),
}));
