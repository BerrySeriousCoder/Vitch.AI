"use client";

import { useEffect } from "react";
import { usePlaybackStore } from "@/stores/playback.store";
import { useSelectionStore } from "@/stores/selection.store";
import { useTimelineStore } from "@/stores/timeline.store";
import { useProjectStore } from "@/stores/project.store";
import { useUIStore } from "@/stores/ui.store";
import { useSequenceStore } from "@/stores/sequence.store";
import { getHistoryStore } from "@/stores/history.store";
import { isNestClip } from "@tempo/editor-core";

export function useKeyboardShortcuts() {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      ) {
        return;
      }

      const ctrl = e.ctrlKey || e.metaKey;

      switch (e.key) {
        case " ": {
          e.preventDefault();
          usePlaybackStore.getState().togglePlay();
          break;
        }

        case "Enter": {
          if (ctrl) break;
          const { selectedClipIds } = useSelectionStore.getState();
          if (selectedClipIds.size !== 1) break;
          const clipId = selectedClipIds.values().next().value as string;
          const tracks = useTimelineStore.getState().tracks;
          for (const track of tracks) {
            const clip = track.clips.find((c) => c.id === clipId);
            if (clip && isNestClip(clip) && clip.sourceSequenceId) {
              e.preventDefault();
              useSequenceStore.getState().enterSequence(clip.sourceSequenceId);
              return;
            }
          }
          break;
        }

        case "Escape": {
          const seq = useSequenceStore.getState();
          if (seq.isEditingSequence()) {
            e.preventDefault();
            seq.exitSequence();
            seq.clearAgentBanner();
          }
          break;
        }

        case "Delete":
        case "Backspace": {
          e.preventDefault();
          const { selectedClipIds, deselectAll } = useSelectionStore.getState();
          const { removeClip } = useTimelineStore.getState();
          selectedClipIds.forEach((id) => removeClip(id));
          deselectAll();
          break;
        }

        case "s": {
          if (ctrl) {
            e.preventDefault();
            useProjectStore.getState().saveProject();
          }
          break;
        }

        case "z": {
          if (ctrl && e.shiftKey) {
            e.preventDefault();
            getHistoryStore().redo();
          } else if (ctrl) {
            e.preventDefault();
            getHistoryStore().undo();
          }
          break;
        }

        case "y": {
          if (ctrl) {
            e.preventDefault();
            getHistoryStore().redo();
          }
          break;
        }

        case "a": {
          if (ctrl) {
            e.preventDefault();
            const allClipIds = useTimelineStore
              .getState()
              .tracks.flatMap((t) => t.clips.map((c) => c.id));
            useSelectionStore.getState().selectClips(allClipIds);
          }
          break;
        }

        case "ArrowLeft": {
          e.preventDefault();
          const { currentTime, seek } = usePlaybackStore.getState();
          const fps = useProjectStore.getState().settings.fps || 30;
          seek(currentTime - 1 / fps);
          break;
        }

        case "ArrowRight": {
          e.preventDefault();
          const { currentTime, seek } = usePlaybackStore.getState();
          const fps = useProjectStore.getState().settings.fps || 30;
          seek(currentTime + 1 / fps);
          break;
        }

        case "Home": {
          e.preventDefault();
          usePlaybackStore.getState().seek(0);
          break;
        }

        case "End": {
          e.preventDefault();
          const dur = usePlaybackStore.getState().duration;
          usePlaybackStore.getState().seek(dur);
          break;
        }

        case "?": {
          e.preventDefault();
          useUIStore.getState().togglePanel("shortcutReference");
          break;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
