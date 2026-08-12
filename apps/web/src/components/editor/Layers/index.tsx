"use client";

import { useCallback, useState } from "react";
import { useTimelineStore } from "@/stores/timeline.store";
import { useSequenceStore } from "@/stores/sequence.store";
import { usePlaybackStore } from "@/stores/playback.store";
import type { Track, TrackType } from "@tempo/types";

const TRACK_COLORS: Record<TrackType, string> = {
  video: "bg-blue-500",
  audio: "bg-green-500",
  text: "bg-purple-500",
  shape: "bg-orange-500",
  effect: "bg-pink-500",
  adjustment: "bg-fuchsia-500",
  null: "bg-slate-500",
};

const TRACK_ICONS: Record<TrackType, string> = {
  video: "🎬",
  audio: "🎵",
  text: "T",
  shape: "◆",
  effect: "✦",
  adjustment: "◒",
  null: "⊕",
};

export function Layers() {
  const tracks = useTimelineStore((s) => s.tracks);
  const addTrack = useTimelineStore((s) => s.addTrack);
  const addAdjustmentLayer = useTimelineStore((s) => s.addAdjustmentLayer);
  const addNullLayer = useTimelineStore((s) => s.addNullLayer);
  const projectDuration = usePlaybackStore((s) => s.duration);
  const removeTrack = useTimelineStore((s) => s.removeTrack);
  const reorderTrack = useTimelineStore((s) => s.reorderTrack);
  const toggleLock = useTimelineStore((s) => s.toggleLock);
  const toggleVisible = useTimelineStore((s) => s.toggleVisible);
  const toggleSolo = useTimelineStore((s) => s.toggleSolo);
  const isEditingSequence = useSequenceStore((s) => s.editStack.length > 1);
  const activeSeqName = useSequenceStore((s) => s.activeSequenceName());

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const displayTracks = [...tracks].sort((a, b) => b.order - a.order);

  const handleRename = useCallback(
    (track: Track) => {
      if (editValue.trim() && editValue.trim() !== track.name) {
        useTimelineStore.setState((state) => ({
          tracks: state.tracks.map((t) =>
            t.id === track.id ? { ...t, name: editValue.trim() } : t
          ),
        }));
      }
      setEditingId(null);
    },
    [editValue]
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent, idx: number) => {
      setDragIdx(idx);
      e.dataTransfer.effectAllowed = "move";
    },
    []
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, idx: number) => {
      e.preventDefault();
      setDropIdx(idx);
    },
    []
  );

  const handleDrop = useCallback(
    (e: React.DragEvent, toIdx: number) => {
      e.preventDefault();
      if (dragIdx === null || dragIdx === toIdx) return;
      const track = displayTracks[dragIdx];
      if (!track) return;
      const targetTrack = displayTracks[toIdx];
      if (!targetTrack) return;
      reorderTrack(track.id, targetTrack.order);
      setDragIdx(null);
      setDropIdx(null);
    },
    [dragIdx, displayTracks, reorderTrack]
  );

  const handleDelete = useCallback(
    (track: Track) => {
      if (track.clips.length > 0 && confirmDeleteId !== track.id) {
        setConfirmDeleteId(track.id);
        return;
      }
      removeTrack(track.id);
      setConfirmDeleteId(null);
    },
    [removeTrack, confirmDeleteId]
  );

  return (
    <div className="h-full flex flex-col bg-[var(--bg-secondary)]">
      {/* Header */}
      <div className="h-9 flex items-center justify-between px-3 border-b border-[var(--border-default)] flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
            Layers
          </span>
          <span className="text-[9px] text-[var(--text-muted)] truncate">
            {isEditingSequence ? `Sequence: ${activeSeqName || "…"}` : "Main"}
          </span>
        </div>
        <div className="relative">
          <button
            onClick={() => setShowAddMenu(!showAddMenu)}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Add track"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>

          {showAddMenu && (
            <div className="absolute right-0 top-full mt-1 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded shadow-lg z-50 py-1 min-w-[120px]">
              {(["video", "audio", "text", "shape"] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => {
                    addTrack(
                      `${type.charAt(0).toUpperCase() + type.slice(1)} ${tracks.filter((t) => t.type === type).length + 1}`,
                      type
                    );
                    setShowAddMenu(false);
                  }}
                  className="w-full px-3 py-1.5 text-left text-[11px] text-[var(--text-primary)] hover:bg-[var(--bg-muted)] flex items-center gap-2"
                >
                  <span className="text-xs">{TRACK_ICONS[type]}</span>
                  {type.charAt(0).toUpperCase() + type.slice(1)} Track
                </button>
              ))}
              <button
                onClick={() => {
                  addAdjustmentLayer(Math.max(1, projectDuration || 30));
                  setShowAddMenu(false);
                }}
                className="w-full px-3 py-1.5 text-left text-[11px] text-[var(--text-primary)] hover:bg-[var(--bg-muted)] flex items-center gap-2"
              >
                <span className="text-xs">{TRACK_ICONS.adjustment}</span>
                Adjustment Layer
              </button>
              <button
                onClick={() => {
                  addNullLayer(Math.max(1, projectDuration || 30));
                  setShowAddMenu(false);
                }}
                className="w-full px-3 py-1.5 text-left text-[11px] text-[var(--text-primary)] hover:bg-[var(--bg-muted)] flex items-center gap-2"
              >
                <span className="text-xs">{TRACK_ICONS.null}</span>
                Null Controller
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Layer list */}
      <div className="flex-1 overflow-y-auto">
        {displayTracks.length === 0 ? (
          <div className="flex items-center justify-center h-20 text-[11px] text-[var(--text-muted)]">
            No layers
          </div>
        ) : (
          displayTracks.map((track, idx) => (
            <div
              key={track.id}
              draggable
              onDragStart={(e) => handleDragStart(e, idx)}
              onDragOver={(e) => handleDragOver(e, idx)}
              onDrop={(e) => handleDrop(e, idx)}
              onDragEnd={() => { setDragIdx(null); setDropIdx(null); }}
              className={`border-b border-[var(--border-default)] px-2 py-1.5 cursor-grab active:cursor-grabbing transition-colors ${
                dropIdx === idx ? "bg-blue-950/30" : "hover:bg-[var(--bg-tertiary)]"
              }`}
            >
              <div className="flex items-center gap-1.5">
                {/* Type indicator */}
                <div className={`w-1.5 h-6 rounded-full ${TRACK_COLORS[track.type]}`} />

                {/* Name */}
                {editingId === track.id ? (
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => handleRename(track)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRename(track);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="flex-1 bg-[var(--bg-primary)] border border-zinc-600 rounded px-1 py-0.5 text-[11px] text-[var(--text-primary)] focus:outline-none"
                  />
                ) : (
                  <span
                    className="flex-1 text-[11px] text-[var(--text-primary)] font-medium truncate"
                    onDoubleClick={() => {
                      setEditingId(track.id);
                      setEditValue(track.name);
                    }}
                  >
                    {track.name}
                  </span>
                )}

                {/* Controls */}
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => toggleVisible(track.id)}
                    className={`p-0.5 rounded text-[10px] transition-colors ${
                      track.visible
                        ? "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                        : "text-zinc-700"
                    }`}
                    title="Visibility"
                  >
                    {track.visible ? "👁" : "👁‍🗨"}
                  </button>
                  <button
                    onClick={() => toggleLock(track.id)}
                    className={`p-0.5 rounded text-[10px] transition-colors ${
                      track.locked
                        ? "text-yellow-500"
                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    }`}
                    title="Lock"
                  >
                    {track.locked ? "🔒" : "🔓"}
                  </button>
                  <button
                    onClick={() => toggleSolo(track.id)}
                    className={`p-0.5 rounded text-[10px] font-bold transition-colors ${
                      track.solo
                        ? "text-yellow-400"
                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    }`}
                    title="Solo"
                  >
                    S
                  </button>
                  <button
                    onClick={() => handleDelete(track)}
                    className="p-0.5 rounded text-[10px] text-[var(--text-muted)] hover:text-red-400 transition-colors"
                    title="Delete track"
                  >
                    ×
                  </button>
                </div>
              </div>

              {/* Clip count badge */}
              <div className="mt-0.5 ml-3">
                <span className="text-[9px] text-[var(--text-muted)] font-mono">
                  {track.clips.length} clip{track.clips.length !== 1 ? "s" : ""}
                </span>
              </div>

              {/* Delete confirmation */}
              {confirmDeleteId === track.id && (
                <div className="mt-1 ml-3 flex items-center gap-2">
                  <span className="text-[10px] text-yellow-400">Delete with clips?</span>
                  <button
                    onClick={() => { removeTrack(track.id); setConfirmDeleteId(null); }}
                    className="text-[10px] text-red-400 hover:text-red-300"
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    className="text-[10px] text-[var(--text-muted)]"
                  >
                    No
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
