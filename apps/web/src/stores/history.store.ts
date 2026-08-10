/**
 * The timeline store uses zundo's `temporal` middleware.
 * Undo/redo also restore one-shot sequence-store baselines after agent turns
 * that mutated Main/library while a nest was open.
 */

import { useTimelineStore } from "./timeline.store";
import { useSequenceStore } from "./sequence.store";
import type { TemporalState } from "zundo";

type TimelineTemporalState = TemporalState<
  ReturnType<typeof useTimelineStore.getState>
>;

type TimelineTemporalApi = {
  getState: () => TimelineTemporalState;
  subscribe: (listener: (state: TimelineTemporalState) => void) => () => void;
};

export function getTimelineTemporalApi(): TimelineTemporalApi {
  return (useTimelineStore as unknown as { temporal: TimelineTemporalApi }).temporal;
}

function wrapHistory(temporal: TimelineTemporalState): TimelineTemporalState {
  return {
    ...temporal,
    undo: (...args: unknown[]) => {
      const snap = useSequenceStore.getState().agentUndoBaseline;
      const beforeUndo = snap
        ? useSequenceStore.getState().snapshotForAgentBaseline()
        : null;
      (temporal.undo as (...a: unknown[]) => void)(...args);
      if (snap) {
        useSequenceStore.getState().restoreAgentBaseline(snap);
        useSequenceStore.setState({
          agentUndoBaseline: null,
          agentRedoBaseline: beforeUndo,
        });
      } else {
        // Further undos past the agent checkpoint invalidate redo companion
        useSequenceStore.setState({ agentRedoBaseline: null });
      }
    },
    redo: (...args: unknown[]) => {
      const snap = useSequenceStore.getState().agentRedoBaseline;
      const beforeRedo = snap
        ? useSequenceStore.getState().snapshotForAgentBaseline()
        : null;
      (temporal.redo as (...a: unknown[]) => void)(...args);
      if (snap) {
        useSequenceStore.getState().restoreAgentBaseline(snap);
        // Re-arm undo companion so undo → redo → undo keeps sequences in sync
        useSequenceStore.setState({
          agentRedoBaseline: null,
          agentUndoBaseline: beforeRedo,
        });
      }
    },
  };
}

export function useHistoryStore(): TimelineTemporalState {
  return wrapHistory(getTimelineTemporalApi().getState());
}

export function getHistoryStore(): TimelineTemporalState {
  return wrapHistory(getTimelineTemporalApi().getState());
}
