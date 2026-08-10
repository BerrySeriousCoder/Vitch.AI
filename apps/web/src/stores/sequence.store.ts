import { create } from "zustand";
import {
  createEmptySequence,
  createSequenceFromClips,
  deleteSequence,
  placeSequenceClip,
  renameSequence,
  sequenceContentEnd,
  countSequenceUsage,
} from "@tempo/editor-core";
import type { Sequence, Track, Transition } from "@tempo/types";
import { useTimelineStore } from "./timeline.store";
import { usePlaybackStore } from "./playback.store";
import { useSelectionStore } from "./selection.store";
import { toast } from "sonner";

export type EditContext =
  | { kind: "main" }
  | { kind: "sequence"; sequenceId: string };

interface SequenceState {
  sequences: Sequence[];
  /** Main timeline snapshot while editing a sequence */
  mainTracks: Track[];
  mainTransitions: Transition[];
  editStack: EditContext[];
  /** Banner when agent updated project while inside a nest */
  agentUpdatedWhileEditing: boolean;
  /** One-shot sequence snapshot to restore on the next timeline undo after an agent turn */
  agentUndoBaseline: {
    sequences: Sequence[];
    mainTracks: Track[];
    mainTransitions: Transition[];
    editStack: EditContext[];
  } | null;
  /** Companion for redo after undoing an agent sequence update */
  agentRedoBaseline: {
    sequences: Sequence[];
    mainTracks: Track[];
    mainTransitions: Transition[];
    editStack: EditContext[];
  } | null;

  setSequences: (sequences: Sequence[]) => void;
  getActiveContext: () => EditContext;
  isEditingSequence: () => boolean;
  activeSequenceId: () => string | null;
  activeSequenceName: () => string | null;

  /** Flush active timeline into main snapshot or open sequence */
  flushActiveToHome: () => void;
  enterSequence: (sequenceId: string) => { ok: true } | { ok: false; message: string };
  exitSequence: () => void;
  exitToMain: () => void;

  createEmpty: (name?: string) => string;
  createFromSelection: (clipIds: string[], name?: string) => { ok: true; sequenceId: string } | { ok: false; message: string };
  placeOnTrack: (
    sequenceId: string,
    trackId: string,
    startTime: number,
    duration?: number
  ) => { ok: true; clipId: string } | { ok: false; message: string };
  rename: (sequenceId: string, name: string) => { ok: true } | { ok: false; message: string };
  remove: (sequenceId: string) => { ok: true } | { ok: false; message: string };
  duplicate: (sequenceId: string) => { ok: true; sequenceId: string } | { ok: false; message: string };
  usageCount: (sequenceId: string) => number;
  /** Persistable sequences after flushing active context */
  getSequencesForSave: () => Sequence[];
  /** Main tracks/transitions for save (flush first) */
  getMainTimelineForSave: () => { tracks: Track[]; transitions: Transition[] };

  applyAgentSequences: (sequences: Sequence[], opts?: { quiet?: boolean }) => void;
  /**
   * Apply agent Main timeline (+ optional sequences) without clobbering an open nest.
   * While editing a sequence: flush nest, update main snapshot / library, keep nest timeline.
   */
  applyAgentProjectUpdate: (payload: {
    tracks?: Track[];
    transitions?: Transition[];
    sequences?: Sequence[];
  }) => void;
  /** Snapshot for agent-turn rollback */
  snapshotForAgentBaseline: () => {
    sequences: Sequence[];
    mainTracks: Track[];
    mainTransitions: Transition[];
    editStack: EditContext[];
  };
  restoreAgentBaseline: (snap: {
    sequences: Sequence[];
    mainTracks: Track[];
    mainTransitions: Transition[];
    editStack: EditContext[];
  }) => void;
  clearAgentBanner: () => void;
  reset: () => void;
}

function clearTimelineHistory() {
  try {
    useTimelineStore.temporal.getState().clear();
  } catch {
    /* ignore */
  }
  // Enter/exit invalidates zundo past — drop one-shot agent undo companions
  useSequenceStore.setState({
    agentUndoBaseline: null,
    agentRedoBaseline: null,
  });
}

export const useSequenceStore = create<SequenceState>((set, get) => ({
  sequences: [],
  mainTracks: [],
  mainTransitions: [],
  editStack: [{ kind: "main" }],
  agentUpdatedWhileEditing: false,
  agentUndoBaseline: null,
  agentRedoBaseline: null,

  setSequences: (sequences) => set({ sequences }),

  getActiveContext: () => {
    const stack = get().editStack;
    return stack[stack.length - 1] || { kind: "main" };
  },

  isEditingSequence: () => get().getActiveContext().kind === "sequence",

  activeSequenceId: () => {
    const ctx = get().getActiveContext();
    return ctx.kind === "sequence" ? ctx.sequenceId : null;
  },

  activeSequenceName: () => {
    const id = get().activeSequenceId();
    if (!id) return null;
    return get().sequences.find((s) => s.id === id)?.name || null;
  },

  flushActiveToHome: () => {
    const { tracks, transitions } = useTimelineStore.getState();
    const ctx = get().getActiveContext();
    if (ctx.kind === "main") {
      set({ mainTracks: tracks, mainTransitions: transitions });
      return;
    }
    set((state) => ({
      sequences: state.sequences.map((s) =>
        s.id === ctx.sequenceId
          ? {
              ...s,
              tracks,
              transitions,
              durationHint: sequenceContentEnd({ ...s, tracks, transitions }),
            }
          : s
      ),
    }));
  },

  enterSequence: (sequenceId) => {
    const seq = get().sequences.find((s) => s.id === sequenceId);
    if (!seq) return { ok: false, message: `Sequence ${sequenceId} not found` };

    get().flushActiveToHome();

    // If currently on main, snapshot is already in mainTracks from flush
    const ctx = get().getActiveContext();
    if (ctx.kind === "main") {
      const { tracks, transitions } = useTimelineStore.getState();
      set({ mainTracks: tracks, mainTransitions: transitions });
    }

    set((state) => ({
      editStack: [...state.editStack, { kind: "sequence", sequenceId }],
    }));

    // Re-read sequence after flush (may have been updated if re-entering)
    const fresh = get().sequences.find((s) => s.id === sequenceId)!;
    useTimelineStore.getState().setTimeline(
      structuredClone(fresh.tracks),
      structuredClone(fresh.transitions || [])
    );
    clearTimelineHistory();
    usePlaybackStore.getState().seek(0);
    useSelectionStore.getState().deselectAll();
    return { ok: true };
  },

  exitSequence: () => {
    const stack = get().editStack;
    if (stack.length <= 1) return;
    get().flushActiveToHome();
    const nextStack = stack.slice(0, -1);
    set({ editStack: nextStack });
    const parent = nextStack[nextStack.length - 1]!;
    if (parent.kind === "main") {
      useTimelineStore
        .getState()
        .setTimeline(
          structuredClone(get().mainTracks),
          structuredClone(get().mainTransitions)
        );
    } else {
      const seq = get().sequences.find((s) => s.id === parent.sequenceId);
      if (seq) {
        useTimelineStore
          .getState()
          .setTimeline(
            structuredClone(seq.tracks),
            structuredClone(seq.transitions || [])
          );
      }
    }
    clearTimelineHistory();
    usePlaybackStore.getState().seek(0);
    useSelectionStore.getState().deselectAll();
  },

  exitToMain: () => {
    while (get().editStack.length > 1) {
      get().exitSequence();
    }
  },

  createEmpty: (name) => {
    if (get().isEditingSequence()) {
      toast.error("Exit the sequence before creating a new one on Main");
      return "";
    }
    get().flushActiveToHome();
    const seq = createEmptySequence(name || "Sequence");
    set((s) => ({ sequences: [...s.sequences, seq] }));
    return seq.id;
  },

  createFromSelection: (clipIds, name) => {
    if (get().isEditingSequence()) {
      return {
        ok: false,
        message: "Create sequence from selection only on the Main timeline",
      };
    }
    get().flushActiveToHome();
    const { tracks, transitions } = useTimelineStore.getState();
    const r = createSequenceFromClips(
      tracks,
      transitions,
      get().sequences,
      clipIds,
      name || "Sequence"
    );
    if (!r.ok) return { ok: false, message: r.message };
    set({
      sequences: r.sequences,
      mainTracks: r.tracks,
      mainTransitions: r.transitions,
    });
    useTimelineStore.getState().setTimeline(r.tracks, r.transitions);
    useSelectionStore.getState().deselectAll();
    return { ok: true, sequenceId: r.sequenceId };
  },

  placeOnTrack: (sequenceId, trackId, startTime, duration) => {
    if (get().isEditingSequence()) {
      return {
        ok: false,
        message: "Place sequence clips only on the Main timeline",
      };
    }
    get().flushActiveToHome();
    const { tracks } = useTimelineStore.getState();
    const r = placeSequenceClip(
      tracks,
      sequenceId,
      trackId,
      startTime,
      duration ?? 0,
      get().sequences
    );
    if (!r.ok) return { ok: false, message: r.message };
    useTimelineStore.getState().setTracks(r.tracks);
    set({ mainTracks: r.tracks });
    return { ok: true, clipId: r.clipId };
  },

  rename: (sequenceId, name) => {
    const r = renameSequence(get().sequences, sequenceId, name);
    if (!r.ok) return { ok: false, message: r.message };
    set({ sequences: r.sequences });
    return { ok: true };
  },

  remove: (sequenceId) => {
    if (
      get().editStack.some(
        (c) => c.kind === "sequence" && c.sequenceId === sequenceId
      )
    ) {
      return {
        ok: false,
        message: "Exit this sequence before deleting it",
      };
    }
    get().flushActiveToHome();
    const tracks = get().isEditingSequence()
      ? get().mainTracks
      : useTimelineStore.getState().tracks;
    const r = deleteSequence(get().sequences, tracks, sequenceId);
    if (!r.ok) return { ok: false, message: r.message };
    set({ sequences: r.sequences });
    return { ok: true };
  },

  duplicate: (sequenceId) => {
    const src = get().sequences.find((s) => s.id === sequenceId);
    if (!src) return { ok: false, message: "Sequence not found" };

    const trackMap = new Map<string, string>();
    const clipMap = new Map<string, string>();
    const tracks = (src.tracks || []).map((t) => {
      const nid = crypto.randomUUID();
      trackMap.set(t.id, nid);
      return {
        ...structuredClone(t),
        id: nid,
        clips: t.clips.map((c) => {
          const cid = crypto.randomUUID();
          clipMap.set(c.id, cid);
          return {
            ...structuredClone(c),
            id: cid,
            trackId: nid,
          };
        }),
      };
    });
    const transitions = (src.transitions || [])
      .map((tr) => {
        const clipAId = clipMap.get(tr.clipAId);
        const clipBId = clipMap.get(tr.clipBId);
        const trackId = trackMap.get(tr.trackId);
        if (!clipAId || !clipBId || !trackId) return null;
        return {
          ...structuredClone(tr),
          id: crypto.randomUUID(),
          trackId,
          clipAId,
          clipBId,
        };
      })
      .filter((tr): tr is NonNullable<typeof tr> => tr != null);

    const copy: Sequence = {
      id: crypto.randomUUID(),
      name: `${src.name} copy`,
      tracks,
      transitions,
      durationHint: src.durationHint,
    };
    set((s) => ({ sequences: [...s.sequences, copy] }));
    return { ok: true, sequenceId: copy.id };
  },

  usageCount: (sequenceId) => {
    const tracks = get().isEditingSequence()
      ? get().mainTracks
      : useTimelineStore.getState().tracks;
    return countSequenceUsage(tracks, sequenceId);
  },

  getSequencesForSave: () => {
    const activeId = get().activeSequenceId();
    if (!activeId) return get().sequences;
    const { tracks, transitions } = useTimelineStore.getState();
    return get().sequences.map((sequence) =>
      sequence.id === activeId
        ? {
            ...sequence,
            tracks,
            transitions,
            durationHint: sequenceContentEnd({
              ...sequence,
              tracks,
              transitions,
            }),
          }
        : sequence
    );
  },

  getMainTimelineForSave: () => {
    if (get().isEditingSequence()) {
      return {
        tracks: get().mainTracks,
        transitions: get().mainTransitions,
      };
    }
    const { tracks, transitions } = useTimelineStore.getState();
    return { tracks, transitions };
  },

  applyAgentSequences: (sequences, opts) => {
    if (get().isEditingSequence()) {
      get().flushActiveToHome();
      const activeId = get().activeSequenceId();
      const localOpen = activeId
        ? get().sequences.find((s) => s.id === activeId)
        : undefined;
      const merged = sequences.map((s) =>
        localOpen && s.id === localOpen.id ? localOpen : s
      );
      if (localOpen && !merged.some((s) => s.id === localOpen.id)) {
        merged.push(localOpen);
      }
      set({ sequences: merged, agentUpdatedWhileEditing: true });
      if (!opts?.quiet) {
        toast.message("Agent updated project — Exit sequence to see Main");
      }
      return;
    }
    set({ sequences });
  },

  applyAgentProjectUpdate: (payload) => {
    const editingSequence = get().isEditingSequence();
    if (!editingSequence) {
      if (payload.tracks && payload.transitions) {
        useTimelineStore.getState().setTimeline(payload.tracks, payload.transitions);
      } else if (payload.tracks) {
        useTimelineStore.getState().setTracks(payload.tracks);
      } else if (payload.transitions) {
        useTimelineStore.getState().setTransitions(payload.transitions);
      }
      const sequencePatch: Partial<SequenceState> = {};
      if (Array.isArray(payload.sequences)) sequencePatch.sequences = payload.sequences;
      if (payload.tracks) sequencePatch.mainTracks = payload.tracks;
      if (payload.transitions) sequencePatch.mainTransitions = payload.transitions;
      if (Object.keys(sequencePatch).length > 0) set(sequencePatch);
      return;
    }

    if (editingSequence) {
      get().flushActiveToHome();
    }

    const alreadyNotifiedWhileEditing = get().agentUpdatedWhileEditing;
    let touchedWhileEditing = false;
    if (Array.isArray(payload.sequences)) {
      get().applyAgentSequences(payload.sequences, { quiet: true });
      if (get().isEditingSequence()) touchedWhileEditing = true;
    }

    if (payload.tracks) {
      if (get().isEditingSequence()) {
        set({
          mainTracks: payload.tracks,
          mainTransitions:
            payload.transitions ?? get().mainTransitions,
          agentUpdatedWhileEditing: true,
        });
        touchedWhileEditing = true;
      } else if (payload.transitions) {
        useTimelineStore
          .getState()
          .setTimeline(payload.tracks, payload.transitions);
        set({
          mainTracks: payload.tracks,
          mainTransitions: payload.transitions,
        });
      } else {
        useTimelineStore.getState().setTracks(payload.tracks);
        set({ mainTracks: payload.tracks });
      }
    } else if (payload.transitions && !get().isEditingSequence()) {
      useTimelineStore.getState().setTransitions(payload.transitions);
      set({ mainTransitions: payload.transitions });
    }

    if (touchedWhileEditing && !alreadyNotifiedWhileEditing) {
      toast.message("Agent updated project — Exit sequence to see Main");
    }
  },

  snapshotForAgentBaseline: () => ({
    sequences: structuredClone(get().sequences),
    mainTracks: structuredClone(get().mainTracks),
    mainTransitions: structuredClone(get().mainTransitions),
    editStack: structuredClone(get().editStack),
  }),

  restoreAgentBaseline: (snap) => {
    set({
      sequences: snap.sequences,
      mainTracks: snap.mainTracks,
      mainTransitions: snap.mainTransitions,
      editStack: snap.editStack,
      agentUpdatedWhileEditing: false,
    });
  },

  clearAgentBanner: () => set({ agentUpdatedWhileEditing: false }),

  reset: () =>
    set({
      sequences: [],
      mainTracks: [],
      mainTransitions: [],
      editStack: [{ kind: "main" }],
      agentUpdatedWhileEditing: false,
      agentUndoBaseline: null,
      agentRedoBaseline: null,
    }),
}));
