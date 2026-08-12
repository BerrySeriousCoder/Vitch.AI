"use client";

import { useEffect, useState, useCallback } from "react";
import { getHistoryStore, getTimelineTemporalApi } from "@/stores/history.store";

interface HistoryEntry {
  index: number;
  label: string;
}

function deriveLabel(idx: number, totalPast: number): string {
  if (idx === 0) return "Initial State";
  return `Action ${idx}`;
}

export function HistoryPanel() {
  const [pastCount, setPastCount] = useState(0);
  const [futureCount, setFutureCount] = useState(0);

  useEffect(() => {
    const temporal = getTimelineTemporalApi();

    const update = (state: ReturnType<typeof temporal.getState>) => {
      setPastCount(state.pastStates?.length ?? 0);
      setFutureCount(state.futureStates?.length ?? 0);
    };

    update(temporal.getState());
    const unsub = temporal.subscribe(update);
    return unsub;
  }, []);

  const handleUndo = useCallback((steps: number) => {
    getHistoryStore().undo(steps);
  }, []);

  const handleRedo = useCallback((steps: number) => {
    getHistoryStore().redo(steps);
  }, []);

  const entries: HistoryEntry[] = [];
  for (let i = 0; i <= pastCount; i++) {
    entries.push({ index: i, label: deriveLabel(i, pastCount) });
  }

  const currentIndex = pastCount;

  return (
    <div className="h-full flex flex-col bg-[var(--bg-secondary)]">
      <div className="h-9 flex items-center justify-between px-3 border-b border-[var(--border-default)] flex-shrink-0">
        <span className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
          History
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleUndo(1)}
            disabled={pastCount === 0}
            className={`p-1 rounded transition-colors ${
              pastCount > 0
                ? "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                : "text-zinc-700 cursor-not-allowed"
            }`}
            title="Undo"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
            </svg>
          </button>
          <button
            onClick={() => handleRedo(1)}
            disabled={futureCount === 0}
            className={`p-1 rounded transition-colors ${
              futureCount > 0
                ? "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                : "text-zinc-700 cursor-not-allowed"
            }`}
            title="Redo"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m15 15 6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {entries.length <= 1 && futureCount === 0 ? (
          <div className="flex items-center justify-center h-20 text-[11px] text-[var(--text-muted)]">
            No history yet
          </div>
        ) : (
          <div className="py-1">
            {/* Future states (shown as grayed out) */}
            {futureCount > 0 &&
              Array.from({ length: futureCount }, (_, i) => (
                <button
                  key={`future-${i}`}
                  onClick={() => handleRedo(i + 1)}
                  className="w-full flex items-center gap-2 px-3 py-1 text-left hover:bg-[var(--bg-tertiary)] transition-colors opacity-40"
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
                  <span className="text-[11px] text-[var(--text-muted)]">
                    Action {pastCount + i + 1}
                  </span>
                </button>
              )).reverse()}

            {/* Current state */}
            <div className="w-full flex items-center gap-2 px-3 py-1 bg-blue-950/30 border-l-2 border-blue-500">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
              <span className="text-[11px] text-[var(--text-primary)] font-medium">
                {currentIndex === 0 ? "Initial State" : `Action ${currentIndex}`}
              </span>
              <span className="text-[9px] text-blue-400 ml-auto font-mono">current</span>
            </div>

            {/* Past states */}
            {entries
              .slice(0, -1)
              .reverse()
              .map((entry) => (
                <button
                  key={entry.index}
                  onClick={() => handleUndo(currentIndex - entry.index)}
                  className="w-full flex items-center gap-2 px-3 py-1 text-left hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {entry.label}
                  </span>
                </button>
              ))}
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-[var(--border-default)] text-[10px] text-[var(--text-muted)] font-mono">
        {pastCount} undo · {futureCount} redo
      </div>
    </div>
  );
}
