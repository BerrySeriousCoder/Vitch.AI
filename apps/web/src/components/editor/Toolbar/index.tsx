"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useProjectStore } from "@/stores/project.store";
import { useUIStore } from "@/stores/ui.store";
import { getHistoryStore, getTimelineTemporalApi } from "@/stores/history.store";

export function Toolbar() {
  const router = useRouter();
  const { id, name, isSaving, saveProject, lastSavedAt, hasUnsavedChanges, saveError, exportProjectJSON } = useProjectStore();
  const { panels, togglePanel } = useUIStore();

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  useEffect(() => {
    const temporal = getTimelineTemporalApi();
    const unsub = temporal.subscribe((state) => {
      setCanUndo(state.pastStates.length > 0);
      setCanRedo(state.futureStates.length > 0);
    });
    return unsub;
  }, []);

  function handleUndo() {
    getHistoryStore().undo();
  }

  function handleRedo() {
    getHistoryStore().redo();
  }

  return (
    <div className="h-11 bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between px-3 flex-shrink-0">
      {/* Left section */}
      <div className="flex items-center gap-2.5">
        <button
          onClick={() => router.push("/dashboard")}
          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          title="Back to projects"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
          </svg>
        </button>

        <div className="w-px h-4 bg-[var(--border-default)]" />

        <span className="text-xs font-semibold text-[var(--text-primary)] truncate max-w-[180px]">
          {name}
        </span>

        {saveError ? (
          <button
            onClick={saveProject}
            className="flex items-center gap-1 text-[11px] text-red-400 font-mono hover:text-red-300"
            title="Save failed — click to retry"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
            Save failed · Retry
          </button>
        ) : isSaving ? (
          <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] font-mono">
            <span className="inline-block w-2 h-2 border border-zinc-500 border-t-transparent rounded-full animate-spin" />
            Saving...
          </span>
        ) : hasUnsavedChanges ? (
          <span className="text-[11px] text-amber-400/80 font-mono">Unsaved</span>
        ) : id ? (
          <span
            className="text-[10px] text-green-400/70 font-mono cursor-default"
            title={lastSavedAt
              ? `Last saved: ${new Date(lastSavedAt).toLocaleTimeString()}`
              : "No unsaved changes"}
          >
            Saved
          </span>
        ) : null}

        <div className="w-px h-4 bg-[var(--border-default)]" />

        {/* Undo / Redo */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleUndo}
            disabled={!canUndo}
            className={`p-1 rounded transition-colors ${
              canUndo
                ? "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                : "text-zinc-700 cursor-not-allowed"
            }`}
            title="Undo (Ctrl+Z)"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
            </svg>
          </button>
          <button
            onClick={handleRedo}
            disabled={!canRedo}
            className={`p-1 rounded transition-colors ${
              canRedo
                ? "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                : "text-zinc-700 cursor-not-allowed"
            }`}
            title="Redo (Ctrl+Shift+Z)"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m15 15 6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Center section — Panel toggles */}
      <div className="flex items-center gap-1 bg-[var(--bg-tertiary)] p-0.5 rounded-[var(--radius-sm)] border border-[var(--border-default)]">
        {(["mediaBin", "layers", "history", "inspector", "effects", "graphics", "tracking", "compositing", "motionGraph", "aiChat", "audioMixer", "timeline"] as const).map((panel) => {
          const label = {
            mediaBin: "Media",
            layers: "Layers",
            history: "History",
            inspector: "Inspector",
            effects: "Effects",
            graphics: "Graphics",
            tracking: "Track",
            compositing: "Rigs",
            motionGraph: "Motion",
            aiChat: "AI",
            audioMixer: "Mixer",
            timeline: "Timeline",
          }[panel];
          return (
            <button
              key={panel}
              onClick={() => togglePanel(panel)}
              className={`px-2 py-0.5 rounded-[3px] text-[11px] font-medium transition-colors ${
                panels[panel]
                  ? "bg-zinc-800 text-zinc-100 shadow-xs"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Right section */}
      <div className="flex items-center gap-2">
        <button
          onClick={saveProject}
          className="px-2.5 py-1 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-[var(--radius-sm)] transition-colors"
        >
          Save
        </button>

        <button
          onClick={exportProjectJSON}
          className="px-2.5 py-1 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-[var(--radius-sm)] transition-colors"
          title="Export project as .tempo.json"
        >
          JSON
        </button>

        <button
          onClick={() => togglePanel("exportDialog")}
          className="px-3 py-1 bg-zinc-100 hover:bg-zinc-200 text-zinc-950 rounded-[var(--radius-sm)] text-xs font-medium transition-colors"
        >
          Export
        </button>

        <button
          onClick={() => togglePanel("shortcutReference")}
          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          title="Keyboard shortcuts (?)"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
