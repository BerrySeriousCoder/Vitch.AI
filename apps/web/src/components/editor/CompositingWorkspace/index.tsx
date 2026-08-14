"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useMediaStore } from "@/stores/media.store";
import { usePlaybackStore } from "@/stores/playback.store";
import { useSelectionStore } from "@/stores/selection.store";
import { useTimelineStore } from "@/stores/timeline.store";
import { validateCompositingHierarchy } from "@tempo/editor-core";
import type { Clip, Track } from "@tempo/types";

interface LayerEntry {
  clip: Clip;
  track: Track;
}

function visualLayers(tracks: Track[]): LayerEntry[] {
  return tracks.flatMap((track) =>
    track.type === "audio" ? [] : track.clips.map((clip) => ({ clip, track }))
  );
}

function kindLabel(entry: LayerEntry) {
  if (entry.clip.nullLayer || entry.track.type === "null") return "Null";
  if (entry.clip.lottieParams) return "Lottie";
  if (entry.track.type === "text") return "Text";
  if (entry.track.type === "shape") return "Shape";
  return entry.track.type;
}

function hasParentCycle(id: string, byId: Map<string, LayerEntry>) {
  const seen = new Set<string>();
  let cursor = byId.get(id);
  while (cursor?.clip.parentId) {
    if (seen.has(cursor.clip.id)) return true;
    seen.add(cursor.clip.id);
    cursor = byId.get(cursor.clip.parentId);
  }
  return false;
}

export function CompositingWorkspace() {
  const tracks = useTimelineStore((state) => state.tracks);
  const addNullLayer = useTimelineStore((state) => state.addNullLayer);
  const setClipParent = useTimelineStore((state) => state.setClipParent);
  const setClipTrackMatte = useTimelineStore((state) => state.setClipTrackMatte);
  const selectedClipIds = useSelectionStore((state) => state.selectedClipIds);
  const selectClip = useSelectionStore((state) => state.selectClip);
  const duration = usePlaybackStore((state) => state.duration);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const assets = useMediaStore((state) => state.assets);
  const [draggedClipId, setDraggedClipId] = useState<string | null>(null);

  const layers = useMemo(() => visualLayers(tracks), [tracks]);
  const byId = useMemo(() => new Map(layers.map((entry) => [entry.clip.id, entry])), [layers]);
  const children = useMemo(() => {
    const map = new Map<string, LayerEntry[]>();
    layers.forEach((entry) => {
      if (!entry.clip.parentId || !byId.has(entry.clip.parentId)) return;
      const siblings = map.get(entry.clip.parentId) ?? [];
      siblings.push(entry);
      map.set(entry.clip.parentId, siblings);
    });
    map.forEach((entries) => entries.sort((a, b) => b.track.order - a.track.order));
    return map;
  }, [layers, byId]);
  const roots = useMemo(() => layers
    .filter((entry) => !entry.clip.parentId || !byId.has(entry.clip.parentId) || hasParentCycle(entry.clip.id, byId))
    .sort((a, b) => b.track.order - a.track.order), [layers, byId]);
  const selectedId = selectedClipIds.values().next().value as string | undefined;
  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const diagnostics = useMemo(() => validateCompositingHierarchy(tracks), [tracks]);
  const matteSources = layers.filter((entry) => entry.clip.id !== selected?.clip.id && !entry.clip.nullLayer && entry.track.type !== "null" && !entry.clip.trackMatte);

  const layerName = (entry: LayerEntry) => {
    const asset = entry.clip.sourceMediaId ? assets.find((candidate) => candidate.id === entry.clip.sourceMediaId) : null;
    return asset?.name || entry.clip.motionTrack?.subject || entry.clip.planarTrack?.surface || entry.track.name;
  };

  const assignParent = (childId: string, parentId: string | null) => {
    const result = setClipParent(childId, parentId);
    if (!result.ok) toast.error(result.message);
    else if (parentId) toast.success("Layer parent updated");
  };

  const createNull = () => {
    const clipId = addNullLayer(Math.max(1, duration || 30), Math.max(0, currentTime), "Rig controller");
    if (clipId) {
      selectClip(clipId);
      toast.success("Created null controller at the playhead");
    }
  };

  const renderNode = (entry: LayerEntry, depth: number, ancestry: Set<string>): React.ReactNode => {
    if (ancestry.has(entry.clip.id)) return null;
    const isSelected = entry.clip.id === selectedId;
    const descendants = children.get(entry.clip.id) ?? [];
    return (
      <div key={entry.clip.id}>
        <div
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-tempo-rig-layer", entry.clip.id);
            setDraggedClipId(entry.clip.id);
          }}
          onDragEnd={() => setDraggedClipId(null)}
          onDragOver={(event) => {
            if (draggedClipId && draggedClipId !== entry.clip.id) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const childId = event.dataTransfer.getData("application/x-tempo-rig-layer") || draggedClipId;
            if (childId && childId !== entry.clip.id) assignParent(childId, entry.clip.id);
            setDraggedClipId(null);
          }}
          onClick={() => selectClip(entry.clip.id)}
          className={`group flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors ${isSelected ? "bg-cyan-900/45 ring-1 ring-cyan-700" : "hover:bg-[var(--bg-tertiary)]"} ${draggedClipId === entry.clip.id ? "opacity-40" : ""}`}
          style={{ marginLeft: `${depth * 12}px` }}
          title="Drag this layer onto another layer to parent it"
        >
          <span className={`w-1.5 h-4 rounded-full ${entry.clip.nullLayer ? "bg-slate-400" : entry.clip.trackMatte ? "bg-amber-400" : "bg-cyan-400"}`} />
          <span className="min-w-0 flex-1 truncate text-[10px] font-medium">{layerName(entry)}</span>
          <span className="rounded border border-zinc-700 px-1 py-px text-[8px] font-mono uppercase text-[var(--text-muted)]">{kindLabel(entry)}</span>
          {entry.clip.trackMatte && <span className="text-[10px] text-amber-300" title={`${entry.clip.trackMatte.type} matte`}>{entry.clip.trackMatte.type === "alpha" ? "α" : "Y"}</span>}
          {descendants.length > 0 && <span className="text-[9px] text-cyan-300">{descendants.length}</span>}
        </div>
        {descendants.map((child) => renderNode(child, depth + 1, new Set([...ancestry, entry.clip.id])))}
      </div>
    );
  };

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg-secondary)] text-[var(--text-primary)]">
      <div className="border-b border-[var(--border-default)] px-3 py-3">
        <div className="flex items-center justify-between gap-2"><div><h2 className="text-xs font-semibold">Compositing & Rigs</h2><p className="mt-0.5 text-[10px] leading-relaxed text-[var(--text-muted)]">Drag a layer onto another to parent it. This hierarchy is used by Preview and frame export.</p></div><button type="button" onClick={createNull} className="rounded bg-cyan-200 px-2 py-1 text-[10px] font-semibold text-cyan-950 hover:bg-cyan-100">+ Null</button></div>
      </div>

      <section className="border-b border-[var(--border-default)] p-3 space-y-1.5">
        <div className="flex items-center justify-between"><h3 className="text-[11px] font-semibold">Layer hierarchy</h3><span className="text-[10px] text-[var(--text-muted)]">{layers.length}</span></div>
        <div className="rounded border border-[var(--border-default)] bg-[var(--bg-primary)] p-1">
          {roots.length ? roots.map((entry) => renderNode(entry, 0, new Set())) : <p className="px-2 py-3 text-center text-[10px] text-[var(--text-muted)]">No visual layers to rig.</p>}
        </div>
        {draggedClipId && <button type="button" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); assignParent(draggedClipId, null); setDraggedClipId(null); }} onClick={() => assignParent(draggedClipId, null)} className="w-full rounded border border-dashed border-zinc-600 px-2 py-1.5 text-[10px] text-[var(--text-muted)] hover:border-zinc-400 hover:text-zinc-200">Drop here to unparent</button>}
      </section>

      <section className="border-b border-[var(--border-default)] p-3 space-y-2">
        <div className="flex items-center justify-between"><h3 className="text-[11px] font-semibold">Selected layer</h3>{selected && <span className="text-[9px] font-mono text-[var(--text-muted)]">{kindLabel(selected)}</span>}</div>
        {!selected ? <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">Select a layer above to manage its parent and matte relationship.</p> : <>
          <p className="truncate rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1.5 text-[10px]">{layerName(selected)}</p>
          <label className="block text-[10px] text-[var(--text-muted)]">Parent<select value={selected.clip.parentId ?? ""} onChange={(event) => assignParent(selected.clip.id, event.target.value || null)} className="mt-1 w-full rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1.5 py-1 text-[10px] text-[var(--text-primary)]"><option value="">Independent layer</option>{layers.filter((entry) => entry.clip.id !== selected.clip.id).map((entry) => <option key={entry.clip.id} value={entry.clip.id}>{entry.clip.nullLayer ? "⊕ " : ""}{layerName(entry)} · {kindLabel(entry)}</option>)}</select></label>
          <div className="rounded border border-amber-900/60 bg-amber-950/15 p-2 space-y-1.5"><div className="flex items-center justify-between"><span className="text-[10px] font-medium text-amber-100">Track matte</span>{selected.clip.trackMatte && <button type="button" onClick={() => setClipTrackMatte(selected.clip.id, null)} className="text-[10px] text-amber-300 hover:text-amber-100">Clear</button>}</div><select value={selected.clip.trackMatte?.sourceClipId ?? ""} onChange={(event) => { const sourceClipId = event.target.value; const result = setClipTrackMatte(selected.clip.id, sourceClipId ? { sourceClipId, type: selected.clip.trackMatte?.type ?? "alpha" } : null); if (!result.ok) toast.error(result.message); }} className="w-full rounded border border-amber-900/60 bg-[var(--bg-primary)] px-1.5 py-1 text-[10px] text-[var(--text-primary)]"><option value="">No matte</option>{matteSources.map((entry) => <option key={entry.clip.id} value={entry.clip.id}>{layerName(entry)} · {kindLabel(entry)}</option>)}</select>{selected.clip.trackMatte && <><div className="grid grid-cols-2 gap-1"><button type="button" onClick={() => setClipTrackMatte(selected.clip.id, { ...selected.clip.trackMatte!, type: "alpha" })} className={`rounded px-1.5 py-1 text-[10px] ${selected.clip.trackMatte.type === "alpha" ? "bg-amber-300 text-amber-950" : "bg-zinc-800 text-zinc-300"}`}>Alpha</button><button type="button" onClick={() => setClipTrackMatte(selected.clip.id, { ...selected.clip.trackMatte!, type: "luma" })} className={`rounded px-1.5 py-1 text-[10px] ${selected.clip.trackMatte.type === "luma" ? "bg-amber-300 text-amber-950" : "bg-zinc-800 text-zinc-300"}`}>Luma</button></div><button type="button" onClick={() => selectClip(selected.clip.trackMatte!.sourceClipId)} className="w-full rounded border border-amber-900/60 px-1.5 py-1 text-left text-[10px] text-amber-100 hover:bg-amber-900/25">View matte source →</button></>}<p className="text-[9px] leading-relaxed text-amber-200/70">Matte sources are hidden in the final composite and must overlap this layer.</p></div>
        </>}
      </section>

      <section className="p-3 space-y-2">
        <div className="flex items-center justify-between"><h3 className="text-[11px] font-semibold">Rig validation</h3><span className={`text-[10px] ${diagnostics.length ? "text-rose-300" : "text-emerald-300"}`}>{diagnostics.length ? `${diagnostics.length} issue${diagnostics.length === 1 ? "" : "s"}` : "Healthy"}</span></div>
        {diagnostics.length === 0 ? <p className="rounded border border-emerald-900/50 bg-emerald-950/15 px-2 py-2 text-[10px] leading-relaxed text-emerald-100">No parent cycles, missing layers, or invalid matte relationships.</p> : diagnostics.map((issue) => <button key={`${issue.clipId}-${issue.code}`} type="button" onClick={() => selectClip(issue.clipId)} className="w-full rounded border border-rose-900/60 bg-rose-950/15 px-2 py-1.5 text-left text-[10px] leading-relaxed text-rose-100 hover:bg-rose-950/30">{issue.message}</button>)}
      </section>
    </div>
  );
}
