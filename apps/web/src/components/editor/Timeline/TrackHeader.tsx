"use client";

import type { Track } from "@tempo/types";
import { useTimelineStore } from "@/stores/timeline.store";

interface TrackHeaderProps {
  track: Track;
}

const TYPE_LABELS: Record<string, string> = {
  video: "V",
  audio: "A",
  text: "T",
  shape: "S",
  effect: "E",
  adjustment: "ADJ",
  null: "NULL",
};

export function TrackHeader({ track }: TrackHeaderProps) {
  const toggleVisible = useTimelineStore((s) => s.toggleVisible);
  const toggleLock = useTimelineStore((s) => s.toggleLock);
  const toggleSolo = useTimelineStore((s) => s.toggleSolo);

  return (
    <div className="h-12 flex items-center px-3 border-b border-[var(--border-default)] group hover:bg-[var(--bg-tertiary)] transition-colors">
      <span className="text-[10px] uppercase font-mono font-bold text-zinc-400 mr-2 border border-zinc-800 px-1 rounded bg-zinc-900">
        {TYPE_LABELS[track.type] || "?"}
      </span>

      <span className="text-xs font-medium text-[var(--text-secondary)] truncate flex-1">
        {track.name}
      </span>

      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={() => toggleSolo(track.id)}
          className={`w-4 h-4 rounded text-[9px] font-bold flex items-center justify-center transition-colors ${
            track.solo
              ? "text-yellow-400 bg-yellow-950/40"
              : "text-[var(--text-muted)] hover:text-zinc-200"
          }`}
          title="Solo"
        >
          S
        </button>
        <button
          onClick={() => toggleVisible(track.id)}
          className={`w-4 h-4 rounded text-[10px] flex items-center justify-center transition-colors ${
            track.visible
              ? "text-[var(--text-muted)] hover:text-zinc-200"
              : "text-red-400 bg-red-950/30"
          }`}
          title="Toggle visibility"
        >
          {track.visible ? "👁" : "🚫"}
        </button>
        <button
          onClick={() => toggleLock(track.id)}
          className={`w-4 h-4 rounded text-[10px] flex items-center justify-center transition-colors ${
            track.locked
              ? "text-amber-400 bg-amber-950/30"
              : "text-[var(--text-muted)] hover:text-zinc-200"
          }`}
          title="Toggle lock"
        >
          {track.locked ? "🔒" : "🔓"}
        </button>
      </div>
    </div>
  );
}
