"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useMediaStore } from "@/stores/media.store";
import { usePlaybackStore } from "@/stores/playback.store";
import { useProjectStore } from "@/stores/project.store";
import { useSelectionStore } from "@/stores/selection.store";
import { useTimelineStore } from "@/stores/timeline.store";
import type { BrandKit, GraphicTemplate, MediaAsset, ShapeParams, TextParams, TrackType } from "@tempo/types";

const DEFAULT_TRANSFORM = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  anchorX: 0,
  anchorY: 0,
};

const DEFAULT_COLORS = ["#FFFFFF", "#111827", "#3B82F6"];

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function graphicAssetType(asset: Pick<MediaAsset, "name" | "metadata">) {
  if (asset.metadata?.graphicFormat === "lottie" || /\.(json|lottie)$/i.test(asset.name)) return "Lottie";
  return "SVG";
}

function templateSlots(template: GraphicTemplate) {
  const value = template.kind === "text" ? template.textParams?.text : undefined;
  return [...new Set([...String(value ?? "").matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1]!.trim()))];
}

function fillTemplateSlots(value: string, values: Record<string, string>) {
  return value.replace(/{{\s*([^{}]+?)\s*}}/g, (token, slot: string) => values[slot.trim()]?.trim() || token);
}

function findClip(tracks: ReturnType<typeof useTimelineStore.getState>["tracks"], clipId: string) {
  for (const track of tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return clip;
  }
  return null;
}

export function GraphicsLibrary() {
  const assets = useMediaStore((state) => state.assets);
  const brandKit = useProjectStore((state) => state.brandKit);
  const templates = useProjectStore((state) => state.graphicTemplates);
  const setBrandKit = useProjectStore((state) => state.setBrandKit);
  const setGraphicTemplates = useProjectStore((state) => state.setGraphicTemplates);
  const tracks = useTimelineStore((state) => state.tracks);
  const selectedClipIds = useSelectionStore((state) => state.selectedClipIds);
  const [draft, setDraft] = useState<BrandKit>({ colors: DEFAULT_COLORS });
  const [slotValues, setSlotValues] = useState<Record<string, Record<string, string>>>({});

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setDraft({
        name: brandKit?.name ?? "",
        colors: brandKit?.colors?.length ? brandKit.colors.slice(0, 3) : DEFAULT_COLORS,
        fontFamily: brandKit?.fontFamily ?? "",
        fontId: brandKit?.fontId,
        logoAssetId: brandKit?.logoAssetId,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [brandKit]);

  const graphicAssets = useMemo(
    () => assets.filter((asset) => asset.metadata?.graphicFormat === "lottie" || asset.metadata?.mimeType === "image/svg+xml" || /\.(svg|json|lottie)$/i.test(asset.name)),
    [assets]
  );
  const logoAssets = useMemo(
    () => graphicAssets.filter((asset) => graphicAssetType(asset) === "SVG" || asset.type === "image"),
    [graphicAssets]
  );
  const selectedClip = useMemo(() => {
    const clipId = selectedClipIds.values().next().value as string | undefined;
    return clipId ? findClip(tracks, clipId) : null;
  }, [selectedClipIds, tracks]);

  const updateColor = (index: number, color: string) => {
    setDraft((current) => ({
      ...current,
      colors: current.colors.map((value, colorIndex) => colorIndex === index ? color : value),
    }));
  };

  const saveBrandKit = () => {
    const colors = draft.colors.filter(Boolean);
    if (!colors.length) return toast.error("Add at least one brand color");
    setBrandKit({ ...draft, name: draft.name?.trim() || undefined, fontFamily: draft.fontFamily?.trim() || undefined, colors });
    toast.success("Brand kit saved");
  };

  const saveSelectedAsTemplate = () => {
    if (!selectedClip || (!selectedClip.textParams && !selectedClip.shapeParams)) {
      toast.error("Select a text or shape layer to save it as a template");
      return;
    }
    const kind = selectedClip.textParams ? "text" : "shape";
    const name = window.prompt("Template name", selectedClip.textParams?.text?.slice(0, 40) || "Graphic template");
    if (!name?.trim()) return;
    const template: GraphicTemplate = {
      id: createId("graphic-template"),
      name: name.trim(),
      kind,
      textParams: selectedClip.textParams ? { ...selectedClip.textParams } : undefined,
      shapeParams: selectedClip.shapeParams ? { ...selectedClip.shapeParams } : undefined,
      layout: selectedClip.layout ? structuredClone(selectedClip.layout) : undefined,
      suggestedDuration: selectedClip.duration,
      createdAt: new Date().toISOString(),
    };
    setGraphicTemplates([...templates, template]);
    toast.success(`Saved “${template.name}” to Graphics`);
  };

  const applyTemplate = (template: GraphicTemplate) => {
    const type: TrackType = template.kind === "text" ? "text" : "shape";
    let track = useTimelineStore.getState().tracks.find((candidate) => candidate.type === type && !candidate.locked);
    if (!track) {
      const trackId = useTimelineStore.getState().addTrack(type === "text" ? "Graphics · Text" : "Graphics · Shapes", type);
      track = useTimelineStore.getState().tracks.find((candidate) => candidate.id === trackId);
    }
    if (!track) return toast.error("No unlocked graphic track is available");
    const textParams: TextParams | undefined = template.kind === "text"
      ? {
          fontFamily: "Arial",
          fontSize: 72,
          fontWeight: "700",
          color: "#FFFFFF",
          textAlign: "center",
          lineHeight: 1.1,
          ...(template.textParams ?? {}),
          text: fillTemplateSlots(template.textParams?.text ?? "Text", slotValues[template.id] ?? {}),
          richTextRuns: template.textParams?.richTextRuns?.map((run) => ({
            ...run,
            text: fillTemplateSlots(run.text, slotValues[template.id] ?? {}),
          })),
        }
      : undefined;
    const shapeParams: ShapeParams | undefined = template.kind === "shape"
      ? {
          shape: "rect",
          fill: "#FFFFFF",
          stroke: "transparent",
          strokeWidth: 0,
          width: 640,
          height: 240,
          ...(template.shapeParams ?? {}),
        }
      : undefined;
    const clipId = useTimelineStore.getState().addClip(track.id, {
      sourceMediaId: null,
      startTime: usePlaybackStore.getState().currentTime,
      duration: Math.max(0.1, template.suggestedDuration || 5),
      sourceOffset: 0,
      speed: 1,
      transform: { ...DEFAULT_TRANSFORM },
      layout: template.layout ? structuredClone(template.layout) : undefined,
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: true,
      volume: 1,
      textParams,
      shapeParams,
    });
    if (!clipId) return;
    useSelectionStore.getState().selectClip(clipId);
    toast.success(`Added “${template.name}” at the playhead`);
  };

  const addGraphicAsset = (asset: (typeof graphicAssets)[number]) => {
    const isLottie = graphicAssetType(asset) === "Lottie";
    const type: TrackType = isLottie ? "shape" : "video";
    let track = useTimelineStore.getState().tracks.find((candidate) => candidate.type === type && !candidate.locked);
    if (!track) {
      const trackId = useTimelineStore.getState().addTrack(isLottie ? "Graphics · Lottie" : "Graphics · SVG", type);
      track = useTimelineStore.getState().tracks.find((candidate) => candidate.id === trackId);
    }
    if (!track) return toast.error("No unlocked graphic track is available");
    const clipId = useTimelineStore.getState().addClip(track.id, {
      sourceMediaId: isLottie ? null : asset.id,
      lottieParams: isLottie ? { assetId: asset.id, loop: true, speed: 1 } : undefined,
      startTime: usePlaybackStore.getState().currentTime,
      duration: Math.max(0.1, asset.duration || 5),
      sourceOffset: 0,
      speed: 1,
      transform: { ...DEFAULT_TRANSFORM },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: true,
      volume: 1,
    });
    if (!clipId) return;
    useSelectionStore.getState().selectClip(clipId);
    toast.success(`Added ${asset.name} at the playhead`);
  };

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg-secondary)] text-[var(--text-primary)]">
      <div className="px-3 py-3 border-b border-[var(--border-default)]">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-xs font-semibold">Graphics</h2>
            <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">Reusable brand, motion, and vector layers.</p>
          </div>
          <button onClick={saveSelectedAsTemplate} className="rounded px-2 py-1 text-[10px] font-medium text-zinc-100 bg-zinc-800 hover:bg-zinc-700 transition-colors">
            Save selection
          </button>
        </div>
      </div>

      <section className="p-3 border-b border-[var(--border-default)] space-y-2.5">
        <div className="flex items-center justify-between"><h3 className="text-[11px] font-semibold">Brand kit</h3><span className="text-[10px] text-[var(--text-muted)]">Project scoped</span></div>
        <input value={draft.name ?? ""} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Brand name" className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1.5 text-[11px] outline-none focus:border-zinc-500" />
        <div className="grid grid-cols-3 gap-1.5">
          {draft.colors.map((color, index) => <label key={index} className="flex items-center gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1.5 py-1"><input type="color" value={color} onChange={(event) => updateColor(index, event.target.value)} className="h-4 w-4 cursor-pointer border-0 bg-transparent p-0" /><span className="min-w-0 truncate text-[9px] font-mono text-[var(--text-muted)]">{color}</span></label>)}
        </div>
        <input value={draft.fontFamily ?? ""} onChange={(event) => setDraft((current) => ({ ...current, fontFamily: event.target.value }))} placeholder="Brand font family" className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1.5 text-[11px] outline-none focus:border-zinc-500" />
        <select value={draft.logoAssetId ?? ""} onChange={(event) => setDraft((current) => ({ ...current, logoAssetId: event.target.value || undefined }))} className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1.5 text-[11px] outline-none focus:border-zinc-500"><option value="">No logo asset</option>{logoAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select>
        <button onClick={saveBrandKit} className="w-full rounded bg-zinc-100 px-2 py-1.5 text-[11px] font-medium text-zinc-950 hover:bg-white transition-colors">Save brand kit</button>
      </section>

      <section className="p-3 border-b border-[var(--border-default)] space-y-2">
        <div className="flex items-center justify-between"><h3 className="text-[11px] font-semibold">Templates</h3><span className="text-[10px] text-[var(--text-muted)]">{templates.length}</span></div>
        {templates.length === 0 ? <p className="rounded border border-dashed border-[var(--border-default)] px-2 py-3 text-center text-[10px] leading-relaxed text-[var(--text-muted)]">Select a text or shape layer, then save it here for reuse.</p> : templates.map((template) => {
          const slots = templateSlots(template);
          return <div key={template.id} className="rounded border border-[var(--border-default)] bg-[var(--bg-primary)] p-2 space-y-1.5"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-[11px] font-medium">{template.name}</p><p className="text-[9px] uppercase tracking-wide text-[var(--text-muted)]">{template.kind} · {template.suggestedDuration.toFixed(1)}s</p></div><button onClick={() => setGraphicTemplates(templates.filter((candidate) => candidate.id !== template.id))} title="Delete template" className="px-1 text-[13px] leading-none text-[var(--text-muted)] hover:text-red-400">×</button></div>{slots.length > 0 && <div className="space-y-1"><p className="text-[9px] text-amber-300/90">Template fields</p>{slots.map((slot) => <input key={slot} value={slotValues[template.id]?.[slot] ?? ""} onChange={(event) => setSlotValues((current) => ({ ...current, [template.id]: { ...current[template.id], [slot]: event.target.value } }))} placeholder={slot} aria-label={`${slot} value for ${template.name}`} className="w-full rounded border border-amber-900/60 bg-[var(--bg-secondary)] px-1.5 py-1 text-[10px] outline-none focus:border-amber-600" />)}</div>}<button onClick={() => applyTemplate(template)} className="w-full rounded border border-zinc-700 px-2 py-1 text-[10px] font-medium text-zinc-200 hover:bg-zinc-800 transition-colors">Add at playhead</button></div>;
        })}
      </section>

      <section className="p-3 space-y-2">
        <div className="flex items-center justify-between"><h3 className="text-[11px] font-semibold">Vector & motion assets</h3><span className="text-[10px] text-[var(--text-muted)]">{graphicAssets.length}</span></div>
        {graphicAssets.length === 0 ? <p className="rounded border border-dashed border-[var(--border-default)] px-2 py-3 text-center text-[10px] leading-relaxed text-[var(--text-muted)]">Upload SVG artwork or Lottie JSON in Media to add it as a graphic layer.</p> : graphicAssets.map((asset) => <div key={asset.id} className="flex items-center gap-2 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] p-2"><span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${graphicAssetType(asset) === "Lottie" ? "bg-violet-500/20 text-violet-200" : "bg-cyan-500/15 text-cyan-200"}`}>{graphicAssetType(asset) === "Lottie" ? "LOT" : "SVG"}</span><p className="min-w-0 flex-1 truncate text-[10px]" title={asset.name}>{asset.name}</p><button onClick={() => addGraphicAsset(asset)} className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-800">Add</button></div>)}
      </section>
    </div>
  );
}
