"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { usePlaybackStore } from "@/stores/playback.store";
import { useSelectionStore } from "@/stores/selection.store";
import { useTimelineStore } from "@/stores/timeline.store";
import { normalizeRotoMatteRefinement, normalizeStabilization } from "@tempo/editor-core";
import type { Clip } from "@tempo/types";

type TrackingKind = "motion" | "planar" | "roto" | "stabilization";

interface TrackingEntry {
  clip: Clip;
  kind: TrackingKind;
  detail: string;
}

function trackingEntries(tracks: ReturnType<typeof useTimelineStore.getState>["tracks"]): TrackingEntry[] {
  return tracks.flatMap((track) => track.clips.flatMap((clip) => {
    const entries: TrackingEntry[] = [];
    if (clip.motionTrack) entries.push({ clip, kind: "motion", detail: `${clip.motionTrack.subject} · ${clip.motionTrack.samples.length} samples` });
    if (clip.planarTrack) entries.push({ clip, kind: "planar", detail: `${clip.planarTrack.surface} · ${clip.planarTrack.samples.length} samples` });
    if (clip.trackMatte) entries.push({ clip, kind: "roto", detail: `${clip.trackMatte.type} matte` });
    if (clip.stabilization?.enabled) entries.push({ clip, kind: "stabilization", detail: `${clip.stabilization.samples.length} samples · ${Math.round(clip.stabilization.smoothness * 100)}% smooth` });
    return entries;
  }));
}

const KIND_STYLE: Record<TrackingKind, string> = {
  motion: "border-cyan-800/70 bg-cyan-950/25 text-cyan-200",
  planar: "border-amber-800/70 bg-amber-950/25 text-amber-200",
  roto: "border-rose-800/70 bg-rose-950/25 text-rose-200",
  stabilization: "border-emerald-800/70 bg-emerald-950/25 text-emerald-200",
};

export function TrackingWorkspace() {
  const tracks = useTimelineStore((state) => state.tracks);
  const setClipParent = useTimelineStore((state) => state.setClipParent);
  const updateClipProperty = useTimelineStore((state) => state.updateClipProperty);
  const selectedClipIds = useSelectionStore((state) => state.selectedClipIds);
  const selectClip = useSelectionStore((state) => state.selectClip);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const [activeEntry, setActiveEntry] = useState<{ clipId: string; kind: TrackingKind } | null>(null);

  const entries = useMemo(() => trackingEntries(tracks), [tracks]);
  const selectedId = selectedClipIds.values().next().value as string | undefined;
  const selectedEntry = (activeEntry && selectedId === activeEntry.clipId
    ? entries.find((entry) => entry.clip.id === activeEntry.clipId && entry.kind === activeEntry.kind)
    : undefined) ?? entries.find((entry) => entry.clip.id === selectedId) ?? null;
  const selectedAttachmentTargets = [...selectedClipIds]
    .filter((clipId) => clipId !== selectedId)
    .map((clipId) => tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId))
    .filter((clip): clip is Clip => Boolean(clip));

  const attachSelection = () => {
    if (!selectedEntry || selectedEntry.kind !== "motion") {
      toast.error("Select a motion-track controller, then Shift-select layers to attach");
      return;
    }
    if (!selectedAttachmentTargets.length) {
      toast.error("Shift-select one or more text, logo, or graphic layers to attach");
      return;
    }
    const failures = selectedAttachmentTargets
      .map((target) => setClipParent(target.id, selectedEntry.clip.id))
      .filter((result): result is { ok: false; message: string } => !result.ok);
    if (failures.length) toast.error(failures[0]?.message || "Could not attach every selected layer");
    else toast.success(`Attached ${selectedAttachmentTargets.length} layer${selectedAttachmentTargets.length === 1 ? "" : "s"} to ${selectedEntry.clip.motionTrack?.subject || "tracker"}`);
  };

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg-secondary)] text-[var(--text-primary)]">
      <div className="border-b border-[var(--border-default)] px-3 py-3">
        <h2 className="text-xs font-semibold">Tracking & Roto</h2>
        <p className="mt-0.5 text-[10px] leading-relaxed text-[var(--text-muted)]">Select a tracked layer to reveal its handles on Preview. Drag handles to add a precise correction at the current frame.</p>
      </div>

      {selectedEntry && (
        <section className="border-b border-[var(--border-default)] p-3 space-y-2">
          <div className="flex items-center justify-between gap-2"><div><p className="text-[11px] font-medium">Active correction</p><p className="text-[10px] text-[var(--text-muted)]">Playhead {currentTime.toFixed(2)}s</p></div><span className={`rounded border px-1.5 py-0.5 text-[9px] font-mono uppercase ${KIND_STYLE[selectedEntry.kind]}`}>{selectedEntry.kind}</span></div>
          <p className="rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1.5 text-[10px] text-[var(--text-secondary)]">{selectedEntry.detail}</p>
          {selectedEntry.kind === "motion" && selectedEntry.clip.motionTrack && <>
            <div className="grid grid-cols-2 gap-1.5 text-[10px]"><label className="flex items-center justify-between gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1.5 py-1">Scale<input type="checkbox" checked={selectedEntry.clip.motionTrack.useScale === true} onChange={(event) => updateClipProperty(selectedEntry.clip.id, "motionTrack", { ...selectedEntry.clip.motionTrack!, useScale: event.target.checked })} /></label><label className="flex items-center justify-between gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1.5 py-1">Rotation<input type="checkbox" checked={selectedEntry.clip.motionTrack.useRotation === true} onChange={(event) => updateClipProperty(selectedEntry.clip.id, "motionTrack", { ...selectedEntry.clip.motionTrack!, useRotation: event.target.checked })} /></label></div>
            <button type="button" onClick={attachSelection} className="w-full rounded bg-cyan-200 px-2 py-1.5 text-[10px] font-semibold text-cyan-950 hover:bg-cyan-100">Attach selected layers</button>
          </>}
          {selectedEntry.kind === "planar" && <p className="text-[10px] leading-relaxed text-amber-200/80">Drag the four Preview corners after an occlusion or cut. The editor validates the quad before saving it.</p>}
          {selectedEntry.kind === "roto" && selectedEntry.clip.trackMatte && (() => {
            const refinement = normalizeRotoMatteRefinement(selectedEntry.clip.trackMatte.refinement);
            const patch = (next: Partial<typeof refinement>) => updateClipProperty(selectedEntry.clip.id, "trackMatte", { ...selectedEntry.clip.trackMatte, refinement: normalizeRotoMatteRefinement({ ...refinement, ...next }) });
            return <div className="space-y-1.5"><p className="text-[10px] leading-relaxed text-rose-200/80">Drag garbage and holdout regions in Preview, then refine the matte without baking pixels.</p><label className="block text-[10px] text-rose-100">Threshold <input type="range" min={0} max={1} step={0.01} value={refinement.threshold} onChange={(event) => patch({ threshold: Number(event.target.value) })} className="mt-0.5 w-full accent-rose-400" /></label><div className="grid grid-cols-2 gap-1.5"><label className="text-[10px] text-rose-100">Feather<input type="number" min={0} max={0.5} step={0.01} value={refinement.feather} onChange={(event) => patch({ feather: Number(event.target.value) })} className="mt-0.5 w-full rounded border border-rose-900/70 bg-[var(--bg-primary)] px-1 py-0.5 text-[10px]" /></label><label className="text-[10px] text-rose-100">Choke<input type="number" min={-0.5} max={0.5} step={0.01} value={refinement.choke} onChange={(event) => patch({ choke: Number(event.target.value) })} className="mt-0.5 w-full rounded border border-rose-900/70 bg-[var(--bg-primary)] px-1 py-0.5 text-[10px]" /></label></div></div>;
          })()}
          {selectedEntry.kind === "stabilization" && selectedEntry.clip.stabilization && <div className="space-y-1.5"><p className="text-[10px] leading-relaxed text-emerald-200/80">Preview shows the stabilized result; export uses the same frame path.</p><label className="block text-[10px] text-emerald-100">Smoothness <input type="range" min={0} max={1} step={0.05} value={selectedEntry.clip.stabilization.smoothness} onChange={(event) => updateClipProperty(selectedEntry.clip.id, "stabilization", normalizeStabilization({ ...selectedEntry.clip.stabilization!, smoothness: Number(event.target.value) }))} className="mt-0.5 w-full accent-emerald-400" /></label><label className="block text-[10px] text-emerald-100">Crop scale<input type="number" min={1} max={1.5} step={0.01} value={selectedEntry.clip.stabilization.cropScale} onChange={(event) => updateClipProperty(selectedEntry.clip.id, "stabilization", normalizeStabilization({ ...selectedEntry.clip.stabilization!, cropScale: Number(event.target.value) }))} className="mt-0.5 w-full rounded border border-emerald-900/70 bg-[var(--bg-primary)] px-1 py-0.5 text-[10px]" /></label></div>}
        </section>
      )}

      <section className="p-3 space-y-2">
        <div className="flex items-center justify-between"><h3 className="text-[11px] font-semibold">Active analyses</h3><span className="text-[10px] text-[var(--text-muted)]">{entries.length}</span></div>
        {entries.length === 0 ? <p className="rounded border border-dashed border-[var(--border-default)] px-2 py-3 text-center text-[10px] leading-relaxed text-[var(--text-muted)]">Ask the AI to track a subject or surface, create a roto matte, or stabilize a clip. Its result will become editable here.</p> : entries.map((entry) => <button key={`${entry.clip.id}-${entry.kind}`} type="button" onClick={() => { selectClip(entry.clip.id); setActiveEntry({ clipId: entry.clip.id, kind: entry.kind }); }} className={`w-full rounded border p-2 text-left transition-colors ${selectedEntry?.clip.id === entry.clip.id && selectedEntry.kind === entry.kind ? "border-zinc-400 bg-zinc-800/80" : "border-[var(--border-default)] bg-[var(--bg-primary)] hover:bg-zinc-800/50"}`}><div className="flex items-center justify-between gap-2"><p className="min-w-0 truncate text-[10px] font-medium">{entry.clip.motionTrack?.subject || entry.clip.planarTrack?.surface || "Tracked layer"}</p><span className={`rounded border px-1 py-0.5 text-[8px] font-mono uppercase ${KIND_STYLE[entry.kind]}`}>{entry.kind}</span></div><p className="mt-1 truncate text-[9px] text-[var(--text-muted)]">{entry.detail}</p></button>)}
      </section>
    </div>
  );
}
