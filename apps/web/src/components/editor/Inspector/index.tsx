"use client";

import { useMemo, useCallback, useEffect, useRef } from "react";
import { useSelectionStore } from "@/stores/selection.store";
import { useTimelineStore } from "@/stores/timeline.store";
import { useUIStore } from "@/stores/ui.store";
import { KeyframeControls } from "./KeyframeControls";
import { KineticAnimatorEditor } from "./KineticAnimatorEditor";
import { EffectParams } from "@/components/editor/Effects/EffectParams";
import type { Clip, BlendMode, ShapeType, ChromaKey, Crop, LayerGlow, LayerShadow, Mask, MotionGraph, RichTextRun, ShapeParams, SpeedRampPoint, TextParams, Track } from "@tempo/types";
import { loadFont, getFontCSS, listAvailableFonts, loadFontById } from "@/lib/fonts";
import { useFontsStore } from "@/stores/fonts.store";
import { useMediaStore } from "@/stores/media.store";
import { resolveMediaUrl } from "@/lib/media-url";
import {
  listTransitionTypes,
  getTransitionType,
  defaultTransitionParams,
  clipEnd,
  DEFAULT_MASK,
  normalizeMask,
  applySpeedPreset,
  DEFAULT_CHROMA_KEY,
  normalizeChromaKey,
  applyChromaPreset,
  applyKenBurns,
  isNestClip,
  normalizeCrop,
  normalizeMotionBlur,
  normalizeTransform3D,
  normalizeStabilization,
  normalizePlanarTrack,
  normalizeRotoMatteRefinement,
  normalizeRetimeSettings,
  normalizeSpeedRamp,
  CAPTION_PRESETS,
  applyCaptionPreset,
  resolveMulticamAngleAtTime,
  setMulticamSwitch,
  sequenceContentEnd,
} from "@tempo/editor-core";
import { TEXT_ANIMATION_PRESETS } from "@/lib/animations/text-presets";
import { TEXT_ANIMATOR_PRESETS, applyTextAnimatorPreset } from "@tempo/editor-core";
import { SHAPE_ANIMATION_PRESETS } from "@/lib/animations/shape-presets";
import { toast } from "sonner";
import { useSequenceStore } from "@/stores/sequence.store";
import { useProjectStore } from "@/stores/project.store";
import { usePlaybackStore } from "@/stores/playback.store";

function RichTextRunsEditor({
  params,
  onChange,
}: {
  params: TextParams;
  onChange: (params: Partial<TextParams>) => void;
}) {
  const runs = params.richTextRuns;

  const setRuns = (next: RichTextRun[]) => {
    onChange({
      richTextRuns: next,
      text: next.map((run) => run.text).join(""),
    });
  };

  if (!runs) {
    return (
      <div className="rounded border border-violet-900/60 bg-violet-950/15 p-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wider text-violet-200">Rich text</p>
            <p className="mt-0.5 text-[9px] leading-3 text-[var(--text-muted)]">Style individual words without separating layers.</p>
          </div>
          <button type="button" onClick={() => setRuns([{ text: params.text }])} className="rounded border border-violet-700/70 px-1.5 py-1 text-[10px] text-violet-100 hover:bg-violet-900/40">Convert</button>
        </div>
      </div>
    );
  }

  const patchRun = (index: number, patch: Partial<RichTextRun>) => {
    setRuns(runs.map((run, runIndex) => runIndex === index ? { ...run, ...patch } : run));
  };

  return (
    <div className="rounded border border-violet-900/60 bg-violet-950/15 p-2 space-y-1.5">
      <div className="flex items-center justify-between"><p className="text-[10px] font-mono uppercase tracking-wider text-violet-200">Rich text spans</p><button type="button" onClick={() => setRuns([...runs, { text: "Text", color: params.color, fontWeight: params.fontWeight }])} className="text-[10px] text-violet-200 hover:text-white">+ Span</button></div>
      {runs.map((run, index) => (
        <div key={`${index}-${run.text}`} className="grid grid-cols-[1fr_28px_42px_16px] items-center gap-1">
          <input value={run.text} onChange={(event) => patchRun(index, { text: event.target.value })} aria-label={`Text span ${index + 1}`} className="min-w-0 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1.5 py-1 text-[10px] outline-none focus:border-zinc-500" />
          <input type="color" value={run.color ?? params.color} onChange={(event) => patchRun(index, { color: event.target.value })} aria-label={`Color for text span ${index + 1}`} className="h-6 w-7 cursor-pointer rounded border border-[var(--border-default)] bg-transparent p-0" />
          <select value={run.fontWeight ?? params.fontWeight} onChange={(event) => patchRun(index, { fontWeight: event.target.value })} aria-label={`Weight for text span ${index + 1}`} className="rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1 py-1 text-[10px] outline-none"><option value="400">Regular</option><option value="500">Medium</option><option value="600">Semi</option><option value="700">Bold</option><option value="800">Extra</option><option value="900">Black</option></select>
          <button type="button" disabled={runs.length === 1} onClick={() => setRuns(runs.filter((_, runIndex) => runIndex !== index))} title="Remove span" className="text-[13px] leading-none text-[var(--text-muted)] hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-30">×</button>
        </div>
      ))}
      <div className="flex items-center justify-between pt-0.5"><span className="text-[9px] text-[var(--text-muted)]">Preview and frame export use these spans.</span><button type="button" onClick={() => onChange({ richTextRuns: undefined })} className="text-[9px] text-[var(--text-muted)] hover:text-zinc-100">Flatten</button></div>
    </div>
  );
}

function LayerDepthEditor({
  shadow,
  glow,
  onChange,
}: {
  shadow?: LayerShadow;
  glow?: LayerGlow;
  onChange: (next: { shadow?: LayerShadow; glow?: LayerGlow }) => void;
}) {
  const patchShadow = (patch: Partial<LayerShadow>) => onChange({ shadow: { color: "#000000", offsetX: 0, offsetY: 8, blur: 16, opacity: 0.45, ...shadow, ...patch }, glow });
  const patchGlow = (patch: Partial<LayerGlow>) => onChange({ shadow, glow: { color: "#8B5CF6", blur: 18, opacity: 0.55, ...glow, ...patch } });

  return (
    <div className="rounded border border-sky-900/60 bg-sky-950/15 p-2 space-y-2">
      <div className="flex items-center justify-between"><p className="text-[10px] font-mono uppercase tracking-wider text-sky-200">Layer depth</p><p className="text-[9px] text-[var(--text-muted)]">Export-safe</p></div>
      <div className="space-y-1">
        <div className="flex items-center justify-between"><label className="text-[10px] text-[var(--text-muted)]">Drop shadow</label><button type="button" onClick={() => onChange({ shadow: shadow ? undefined : { color: "#000000", offsetX: 0, offsetY: 8, blur: 16, opacity: 0.45 }, glow })} className="text-[10px] text-sky-200 hover:text-white">{shadow ? "Disable" : "Enable"}</button></div>
        {shadow && <div className="grid grid-cols-[28px_1fr_1fr_1fr] gap-1"><input type="color" value={shadow.color} onChange={(event) => patchShadow({ color: event.target.value })} className="h-6 w-7 rounded bg-transparent p-0" title="Shadow color" /><input type="number" value={shadow.offsetX} onChange={(event) => patchShadow({ offsetX: Number(event.target.value) || 0 })} className="min-w-0 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1 py-1 text-[10px]" title="Horizontal offset" /><input type="number" value={shadow.offsetY} onChange={(event) => patchShadow({ offsetY: Number(event.target.value) || 0 })} className="min-w-0 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1 py-1 text-[10px]" title="Vertical offset" /><input type="number" value={shadow.blur} min={0} onChange={(event) => patchShadow({ blur: Math.max(0, Number(event.target.value) || 0) })} className="min-w-0 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1 py-1 text-[10px]" title="Blur" /></div>}
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between"><label className="text-[10px] text-[var(--text-muted)]">Outer glow</label><button type="button" onClick={() => onChange({ shadow, glow: glow ? undefined : { color: "#8B5CF6", blur: 18, opacity: 0.55 } })} className="text-[10px] text-sky-200 hover:text-white">{glow ? "Disable" : "Enable"}</button></div>
        {glow && <div className="grid grid-cols-[28px_1fr_1fr] gap-1"><input type="color" value={glow.color} onChange={(event) => patchGlow({ color: event.target.value })} className="h-6 w-7 rounded bg-transparent p-0" title="Glow color" /><input type="number" value={glow.blur} min={0} onChange={(event) => patchGlow({ blur: Math.max(0, Number(event.target.value) || 0) })} className="min-w-0 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1 py-1 text-[10px]" title="Glow blur" /><input type="number" value={Math.round((glow.opacity ?? 1) * 100)} min={0} max={100} onChange={(event) => patchGlow({ opacity: Math.max(0, Math.min(1, Number(event.target.value) / 100 || 0)) })} className="min-w-0 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1 py-1 text-[10px]" title="Glow opacity percent" /></div>}
      </div>
    </div>
  );
}

function MaskInspector({ clip }: { clip: Clip }) {
  const updateClipProperty = useTimelineStore((s) => s.updateClipProperty);
  const mask = clip.mask;

  const setMask = (next: Mask | null) => {
    updateClipProperty(clip.id, "mask", next);
  };

  const patch = (partial: Partial<Mask>) => {
    setMask(normalizeMask({ ...(mask || DEFAULT_MASK), ...partial }));
  };

  return (
    <div>
      <h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
        Mask
      </h3>
      {!mask ? (
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setMask(normalizeMask({ ...DEFAULT_MASK, shape: "ellipse" }))}
            className="px-2 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
          >
            Add ellipse
          </button>
          <button
            type="button"
            onClick={() => setMask(normalizeMask({ ...DEFAULT_MASK, shape: "rect" }))}
            className="px-2 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
          >
            Add rect
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label className="text-[11px] text-[var(--text-muted)]">Shape</label>
            <select
              value={mask.shape}
              onChange={(e) =>
                patch({ shape: e.target.value as "rect" | "ellipse" })
              }
              className="w-24 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-xs text-[var(--text-primary)]"
            >
              <option value="ellipse">ellipse</option>
              <option value="rect">rect</option>
            </select>
          </div>
          {(
            [
              ["x", mask.x],
              ["y", mask.y],
              ["width", mask.width],
              ["height", mask.height],
              ["feather", mask.feather],
              ["opacity", mask.opacity],
            ] as const
          ).map(([key, value]) => (
            <div key={key} className="flex items-center justify-between gap-2">
              <label className="text-[11px] text-[var(--text-muted)]">{key}</label>
              <input
                type="number"
                min={0}
                max={key === "feather" ? 0.5 : 1}
                step={0.01}
                value={value}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  if (!Number.isFinite(n)) return;
                  patch({ [key]: n });
                }}
                className="w-20 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-xs text-[var(--text-primary)]"
              />
            </div>
          ))}
          <label className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={mask.inverted}
              onChange={(e) => patch({ inverted: e.target.checked })}
            />
            Inverted
          </label>
          <button
            type="button"
            onClick={() => setMask(null)}
            className="text-[10px] text-red-400 hover:underline"
          >
            Clear mask
          </button>
        </div>
      )}
    </div>
  );
}

function CropInspector({ clip }: { clip: Clip }) {
  const updateClipProperty = useTimelineStore((s) => s.updateClipProperty);
  const crop = normalizeCrop(clip.crop);
  const mediaLayout = clip.mediaLayout ?? {
    schemaVersion: 1 as const,
    fit: "contain" as const,
    focalPoint: { x: 0.5, y: 0.5 },
  };

  const updateCrop = (partial: Partial<Crop>) => {
    updateClipProperty(clip.id, "crop", normalizeCrop({ ...crop, ...partial }));
  };

  const applyPreset = (presetId: "zoom-in" | "zoom-out" | "pan-left" | "pan-right") => {
    const result = applyKenBurns({
      presetId,
      duration: clip.duration,
      keyframes: clip.keyframes,
      createKeyframeId: () => crypto.randomUUID(),
    });
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    updateClipProperty(clip.id, "crop", result.crop);
    updateClipProperty(clip.id, "keyframes", result.keyframes);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider">
          Crop & Reframe
        </h3>
        <button
          type="button"
          onClick={() => {
            updateClipProperty(clip.id, "crop", null);
            updateClipProperty(
              clip.id,
              "keyframes",
              clip.keyframes.filter((keyframe) => !keyframe.property.startsWith("crop."))
            );
          }}
          className="text-[10px] text-zinc-400 hover:text-zinc-100"
        >
          Reset
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {clip.sourceMediaId ? (
          <label className="col-span-2 flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
            Fit
            <select
              value={mediaLayout.fit}
              onChange={(event) => updateClipProperty(clip.id, "mediaLayout", {
                ...mediaLayout,
                fit: event.target.value as "cover" | "contain" | "fill" | "none",
              })}
              className="w-28 px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]"
            >
              <option value="cover">Cover</option>
              <option value="contain">Contain</option>
              <option value="none">Actual size</option>
              <option value="fill">Stretch (distort)</option>
            </select>
          </label>
        ) : null}
        {clip.sourceMediaId && mediaLayout.fit === "cover" ? (["x", "y"] as const).map((axis) => (
          <label key={`focal-${axis}`} className="flex items-center justify-between gap-1 text-[10px] text-[var(--text-muted)]">
            Focal {axis.toUpperCase()}
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={mediaLayout.focalPoint?.[axis] ?? 0.5}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (!Number.isFinite(value)) return;
                updateClipProperty(clip.id, "mediaLayout", {
                  ...mediaLayout,
                  focalPoint: { ...mediaLayout.focalPoint, x: mediaLayout.focalPoint?.x ?? 0.5, y: mediaLayout.focalPoint?.y ?? 0.5, [axis]: Math.max(0, Math.min(1, value)) },
                });
              }}
              className="w-14 px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]"
            />
          </label>
        )) : null}
        {(["x", "y", "width", "height"] as const).map((key) => (
          <label key={key} className="flex items-center justify-between gap-1 text-[10px] text-[var(--text-muted)]">
            {key}
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={crop[key]}
              onChange={(event) => {
                const value = parseFloat(event.target.value);
                if (Number.isFinite(value)) updateCrop({ [key]: value });
              }}
              className="w-14 px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]"
            />
          </label>
        ))}
      </div>
      <select
        defaultValue=""
        onChange={(event) => {
          const presetId = event.target.value as "zoom-in" | "zoom-out" | "pan-left" | "pan-right";
          if (presetId) applyPreset(presetId);
          event.target.value = "";
        }}
        className="w-full mt-2 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]"
      >
        <option value="" disabled>Ken Burns preset…</option>
        <option value="zoom-in">Zoom in</option>
        <option value="zoom-out">Zoom out</option>
        <option value="pan-left">Pan left</option>
        <option value="pan-right">Pan right</option>
      </select>
      <p className="mt-1 text-[9px] leading-relaxed text-[var(--text-muted)]">
        Cover and contain preserve aspect ratio. Stretch is the only mode that distorts. Crop values are normalized to the source.
      </p>
    </div>
  );
}

function CompositingInspector({ clip, tracks }: { clip: Clip; tracks: Track[] }) {
  const setClipParent = useTimelineStore((s) => s.setClipParent);
  const setClipTrackMatte = useTimelineStore((s) => s.setClipTrackMatte);
  const updateClipProperty = useTimelineStore((s) => s.updateClipProperty);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const allClips = tracks.flatMap((track) => track.clips.map((candidate) => ({ candidate, track })));
  const parentOptions = allClips.filter(({ candidate }) => candidate.id !== clip.id);
  const matteOptions = allClips.filter(({ candidate, track }) =>
    candidate.id !== clip.id && track.type !== "audio" && track.type !== "null" && !candidate.nullLayer
  );
  const updateParent = (parentId: string) => {
    const result = setClipParent(clip.id, parentId || null);
    if (!result.ok) toast.error(result.message);
  };
  const updateMatte = (sourceClipId: string) => {
    const result = setClipTrackMatte(
      clip.id,
      sourceClipId ? { sourceClipId, type: clip.trackMatte?.type || "alpha" } : null
    );
    if (!result.ok) toast.error(result.message);
  };
  const setRotoRegion = (property: "garbageMask" | "holdoutMask", next: Mask | undefined) => {
    if (!clip.trackMatte) return;
    const result = setClipTrackMatte(clip.id, { ...clip.trackMatte, [property]: next });
    if (!result.ok) toast.error(result.message);
  };

  return (
    <div>
      <h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
        Compositing
      </h3>
      <div className="space-y-2">
        <label className="block text-[10px] text-[var(--text-muted)]">
          Parent
          <select
            value={clip.parentId || ""}
            onChange={(event) => updateParent(event.target.value)}
            className="w-full mt-1 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]"
          >
            <option value="">None (independent)</option>
            {parentOptions.map(({ candidate, track }) => (
              <option key={candidate.id} value={candidate.id}>
                {track.type === "null" ? "⊕ " : ""}{track.name}: {candidate.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[10px] text-[var(--text-muted)]">
          Track matte
          <select
            value={clip.trackMatte?.sourceClipId || ""}
            onChange={(event) => updateMatte(event.target.value)}
            className="w-full mt-1 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]"
          >
            <option value="">None</option>
            {matteOptions.map(({ candidate, track }) => (
              <option key={candidate.id} value={candidate.id}>
                {track.name}: {candidate.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {clip.trackMatte && (
          <div className="rounded border border-[var(--border-default)] p-1.5 space-y-1.5">
            <label className="block text-[10px] text-[var(--text-muted)]">
              Matte channel
              <select
                value={clip.trackMatte.type}
                onChange={(event) => {
                  const result = setClipTrackMatte(clip.id, {
                    ...clip.trackMatte!,
                    type: event.target.value as "alpha" | "luma",
                  });
                  if (!result.ok) toast.error(result.message);
                }}
                className="w-full mt-1 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]"
              >
                <option value="alpha">Alpha</option>
                <option value="luma">Luma</option>
              </select>
            </label>
            <div className="grid grid-cols-3 gap-1.5 text-[10px] text-[var(--text-muted)]">
              {(["threshold", "feather", "choke"] as const).map((key) => (
                <label key={key}>{key}
                  <input type="number" min={key === "choke" ? -0.5 : 0} max={key === "threshold" ? 1 : 0.5} step={0.01}
                    value={normalizeRotoMatteRefinement(clip.trackMatte?.refinement)[key]}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      const result = setClipTrackMatte(clip.id, { ...clip.trackMatte!, refinement: normalizeRotoMatteRefinement({ ...clip.trackMatte?.refinement, [key]: value }) });
                      if (!result.ok) toast.error(result.message);
                    }}
                    className="mt-0.5 w-full px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]" />
                </label>
              ))}
            </div>
            <label className="flex items-center justify-between text-[10px] text-[var(--text-muted)]">
              Invert matte
              <input type="checkbox" checked={clip.trackMatte.refinement?.inverted ?? false}
                onChange={(event) => {
                  const result = setClipTrackMatte(clip.id, { ...clip.trackMatte!, refinement: normalizeRotoMatteRefinement({ ...clip.trackMatte?.refinement, inverted: event.target.checked }) });
                  if (!result.ok) toast.error(result.message);
                }} />
            </label>
            <div className="space-y-1 border-t border-[var(--border-default)] pt-1.5">
              {([ ["garbageMask", "Garbage (keep)"], ["holdoutMask", "Holdout (remove)"] ] as const).map(([property, label]) => {
                const region = clip.trackMatte?.[property];
                return <div key={property} className="rounded bg-black/10 p-1 text-[9px] text-[var(--text-muted)]">
                  <div className="flex items-center justify-between"><span>{label}</span>
                    <button type="button" onClick={() => setRotoRegion(property, region ? undefined : { ...DEFAULT_MASK, shape: "rect", x: 0.2, y: 0.2, width: 0.6, height: 0.6, feather: 0.02 })} className="text-cyan-300 hover:text-white">{region ? "Clear" : "Add"}</button>
                  </div>
                  {region && <div className="mt-1 grid grid-cols-3 gap-1">
                    {(["x", "y", "width", "height", "feather", "opacity"] as const).map((key) => <label key={key}>{key}
                      <input type="number" min={0} max={key === "feather" ? 0.5 : 1} step={0.01} value={region[key]}
                        onChange={(event) => setRotoRegion(property, { ...region, [key]: Number(event.target.value) })}
                        className="mt-0.5 w-full px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[9px] text-[var(--text-primary)]" />
                    </label>)}
                    <label>shape<select value={region.shape} onChange={(event) => setRotoRegion(property, { ...region, shape: event.target.value as Mask["shape"] })} className="mt-0.5 w-full px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[9px] text-[var(--text-primary)]"><option value="rect">rect</option><option value="ellipse">ellipse</option></select></label>
                  </div>}
                </div>;
              })}
            </div>
          </div>
        )}
        {clip.motionTrack && (
          <div className="rounded border border-cyan-900/70 bg-cyan-950/20 p-1.5 text-[10px] text-cyan-100">
            <div className="flex items-center justify-between gap-2">
              <span>Tracked: {clip.motionTrack.subject} · {clip.motionTrack.samples.length} samples</span>
              <button
                type="button"
                onClick={() => updateClipProperty(clip.id, "motionTrack", null)}
                className="text-cyan-300 hover:text-white"
              >
                Clear
              </button>
            </div>
            <p className="mt-1 text-[9px] text-cyan-300/70">
              This drives transform. Parent other layers here to attach them to the tracked subject.
            </p>
          </div>
        )}
        {clip.planarTrack && (() => {
          const localTime = Math.max(0, Math.min(clip.duration, currentTime - clip.startTime));
          const samples = clip.planarTrack.samples;
          const sampleIndex = samples.reduce((best, sample, index) =>
            Math.abs(sample.time - localTime) < Math.abs(samples[best]!.time - localTime) ? index : best, 0);
          const sample = samples[sampleIndex]!;
          const patchCorner = (cornerIndex: number, axis: "x" | "y", value: number) => {
            const nextSamples = samples.map((item, index) => index === sampleIndex
              ? { ...item, corners: item.corners.map((corner, pointIndex) => pointIndex === cornerIndex ? { ...corner, [axis]: value } : corner) as typeof item.corners }
              : item);
            const planarTrack = normalizePlanarTrack({ ...clip.planarTrack!, samples: nextSamples });
            if (planarTrack) updateClipProperty(clip.id, "planarTrack", planarTrack);
            else toast.error("Corners must remain a valid convex quad");
          };
          return (
            <div className="rounded border border-amber-900/70 bg-amber-950/20 p-1.5 text-[10px] text-amber-100">
              <div className="flex items-center justify-between gap-2">
                <span>Planar pin: {clip.planarTrack.surface} · {samples.length} samples</span>
                <button type="button" onClick={() => updateClipProperty(clip.id, "planarTrack", null)} className="text-amber-300 hover:text-white">Clear</button>
              </div>
              <p className="mt-1 text-[9px] text-amber-200/70">Nearest key at {sample.time.toFixed(2)}s. Edit corners after an occlusion or cut; the pin owns layer positioning.</p>
              <div className="mt-1.5 grid grid-cols-2 gap-1">
                {(["TL", "TR", "BR", "BL"] as const).map((name, cornerIndex) => (
                  <label key={name} className="text-[9px] text-amber-200">{name}
                    <span className="mt-0.5 flex gap-1">
                      {(["x", "y"] as const).map((axis) => <input key={axis} aria-label={`${name} ${axis}`} type="number" min={0} max={1} step={0.001} value={sample.corners[cornerIndex]![axis]}
                        onChange={(event) => patchCorner(cornerIndex, axis, Number(event.target.value))}
                        className="w-full px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-amber-900/60 rounded text-[9px] text-[var(--text-primary)]" />)}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          );
        })()}
        {clip.stabilization && (
          <div className="rounded border border-emerald-900/70 bg-emerald-950/20 p-1.5 text-[10px] text-emerald-100">
            <div className="flex items-center justify-between gap-2">
              <span>Stabilization · {clip.stabilization.samples.length} samples</span>
              <button type="button" onClick={() => updateClipProperty(clip.id, "stabilization", null)} className="text-emerald-300 hover:text-white">Clear</button>
            </div>
            <label className="mt-1.5 block text-[10px] text-emerald-200">Smoothness
              <input type="range" min={0} max={1} step={0.05} value={clip.stabilization.smoothness}
                onChange={(event) => updateClipProperty(clip.id, "stabilization", normalizeStabilization({ ...clip.stabilization, smoothness: Number(event.target.value) }))}
                className="mt-0.5 w-full accent-emerald-400" />
            </label>
            <label className="mt-1 block text-[10px] text-emerald-200">Crop scale
              <input type="number" min={1} max={1.5} step={0.01} value={clip.stabilization.cropScale}
                onChange={(event) => updateClipProperty(clip.id, "stabilization", normalizeStabilization({ ...clip.stabilization, cropScale: Number(event.target.value) }))}
                className="mt-0.5 w-full px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]" />
            </label>
          </div>
        )}
        <div className="rounded border border-[var(--border-default)] p-1.5">
          <label className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
            <span>Motion blur</span>
            <input
              type="checkbox"
              checked={Boolean(clip.motionBlur?.enabled)}
              onChange={(event) => updateClipProperty(clip.id, "motionBlur", normalizeMotionBlur({ ...clip.motionBlur, enabled: event.target.checked }))}
            />
          </label>
          {clip.motionBlur?.enabled && (
            <div className="mt-1.5 grid grid-cols-2 gap-1.5 text-[10px] text-[var(--text-muted)]">
              <label>Shutter
                <input type="number" min={0} max={360} step={1} value={normalizeMotionBlur(clip.motionBlur).shutterAngle}
                  onChange={(event) => updateClipProperty(clip.id, "motionBlur", normalizeMotionBlur({ ...clip.motionBlur, shutterAngle: Number(event.target.value) }))}
                  className="mt-0.5 w-full px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]" />
              </label>
              <label>Samples
                <input type="number" min={2} max={32} step={1} value={normalizeMotionBlur(clip.motionBlur).samples}
                  onChange={(event) => updateClipProperty(clip.id, "motionBlur", normalizeMotionBlur({ ...clip.motionBlur, samples: Number(event.target.value) }))}
                  className="mt-0.5 w-full px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]" />
              </label>
            </div>
          )}
        </div>
        <div className="rounded border border-[var(--border-default)] p-1.5">
          <label className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
            <span>Perspective 3D</span>
            <input
              type="checkbox"
              checked={Boolean(clip.transform3D)}
              onChange={(event) => updateClipProperty(clip.id, "transform3D", event.target.checked ? normalizeTransform3D(clip.transform3D) : null)}
            />
          </label>
          {clip.transform3D && (
            <div className="mt-1.5 grid grid-cols-2 gap-1.5 text-[10px] text-[var(--text-muted)]">
              {(["z", "rotationX", "rotationY", "rotationZ"] as const).map((key) => (
                <label key={key}>{key}
                  <input type="number" step={key === "z" ? 1 : 0.5} value={normalizeTransform3D(clip.transform3D)[key]}
                    onChange={(event) => updateClipProperty(clip.id, "transform3D", normalizeTransform3D({ ...clip.transform3D, [key]: Number(event.target.value) }))}
                    className="mt-0.5 w-full px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]" />
                </label>
              ))}
            </div>
          )}
        </div>
        <p className="text-[9px] leading-relaxed text-[var(--text-muted)]">
          Parent inherits motion and opacity. Matte source is hidden from the final composite and must overlap this clip.
        </p>
      </div>
    </div>
  );
}

function MulticamInspector({ clip }: { clip: Clip }) {
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const updateClipProperty = useTimelineStore((state) => state.updateClipProperty);
  const assets = useMediaStore((state) => state.assets);
  if (!clip.multicam) return null;
  const localTime = Math.max(0, Math.min(clip.duration, currentTime - clip.startTime));
  const active = resolveMulticamAngleAtTime(clip.multicam, localTime);
  const cut = (angleId: string) => {
    const multicam = setMulticamSwitch(clip.multicam, localTime, angleId);
    if (multicam) updateClipProperty(clip.id, "multicam", multicam);
  };
  return (
    <div className="rounded border border-violet-900/70 bg-violet-950/20 p-2 space-y-2">
      <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-violet-200">
        <span>Multicam · {clip.multicam.angles.length} angles</span><span>{localTime.toFixed(2)}s</span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {clip.multicam.angles.map((angle) => (
          <button key={angle.id} type="button" onClick={() => cut(angle.id)} className={`rounded px-1.5 py-1 text-left text-[10px] ${active?.id === angle.id ? "bg-violet-600 text-white" : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"}`}>
            {active?.id === angle.id ? "● " : "○ "}{angle.name}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1 rounded bg-black/20 p-1">
        {clip.multicam.angles.map((angle) => {
          const asset = assets.find((candidate) => candidate.id === angle.sourceMediaId);
          const url = asset?.url ? resolveMediaUrl(asset.url) : null;
          const sourceTime = Math.max(0, angle.sourceOffset + localTime);
          return <button key={`${angle.id}-preview`} type="button" onClick={() => cut(angle.id)} className={`overflow-hidden rounded border text-left ${active?.id === angle.id ? "border-violet-400" : "border-zinc-800"}`}>
            {url ? <video muted playsInline preload="metadata" ref={(element) => { if (element && Math.abs(element.currentTime - sourceTime) > 0.1) { try { element.currentTime = sourceTime; } catch { /* metadata pending */ } } }} src={url} className="aspect-video w-full bg-black object-cover" /> : <div className="aspect-video bg-zinc-900" />}
            <span className="block truncate px-1 py-0.5 text-[8px] text-zinc-300">{angle.name}</span>
          </button>;
        })}
      </div>
      <label className="flex items-center justify-between gap-2 text-[10px] text-violet-200">Export audio
        <select value={clip.multicam.audioAngleId} onChange={(event) => {
          const angle = clip.multicam!.angles.find((candidate) => candidate.id === event.target.value);
          if (!angle) return;
          updateClipProperty(clip.id, "multicam", { ...clip.multicam!, audioAngleId: angle.id });
          updateClipProperty(clip.id, "sourceMediaId", angle.sourceMediaId);
          updateClipProperty(clip.id, "sourceOffset", angle.sourceOffset);
        }} className="max-w-[130px] bg-zinc-900 px-1 py-0.5 text-[10px] text-zinc-200 border border-zinc-700 rounded">
          {clip.multicam.angles.map((angle) => <option key={angle.id} value={angle.id}>{angle.name}</option>)}
        </select>
      </label>
      {clip.multicam.sync && <p className="text-[9px] text-violet-200/70">Audio sync · reference {clip.multicam.sync.referenceAngleId} · review confidence below.</p>}
      <div className="grid grid-cols-2 gap-1 text-[9px] text-violet-100/80">
        {clip.multicam.angles.map((angle) => <label key={`${angle.id}-offset`} className="rounded bg-black/20 p-1">{angle.name} offset
          <span className="mt-0.5 flex items-center gap-1"><input type="number" step={0.01} min={0} value={angle.sourceOffset} onChange={(event) => {
            const sourceOffset = Math.max(0, Number(event.target.value) || 0);
            const angles = clip.multicam!.angles.map((candidate) => candidate.id === angle.id ? { ...candidate, sourceOffset } : candidate);
            updateClipProperty(clip.id, "multicam", { ...clip.multicam!, angles, sync: { ...clip.multicam?.sync, mode: "manual", referenceAngleId: clip.multicam?.sync?.referenceAngleId || angle.id, confidenceByAngle: clip.multicam?.sync?.confidenceByAngle || {} } });
            if (clip.multicam!.audioAngleId === angle.id) updateClipProperty(clip.id, "sourceOffset", sourceOffset);
          }} className="w-full bg-zinc-900 px-1 py-0.5 font-mono text-[9px] text-white border border-zinc-700 rounded" />
          {clip.multicam?.sync && <span className="font-mono text-[8px] text-emerald-300">{Math.round((clip.multicam.sync.confidenceByAngle[angle.id] ?? 0) * 100)}%</span>}</span>
        </label>)}
      </div>
      <p className="text-[9px] leading-relaxed text-violet-200/70">Click an angle at the playhead to write a non-destructive switch. Offset edits are safe corrections after audio sync.</p>
    </div>
  );
}

function Scene3DInspector() {
  const cameras = useProjectStore((s) => s.cameras);
  const lights = useProjectStore((s) => s.lights);
  const setCameras = useProjectStore((s) => s.setCameras);
  const setLights = useProjectStore((s) => s.setLights);
  const camera = cameras.find((item) => item.enabled) || cameras[0];
  const patchCamera = (partial: Record<string, unknown>) => {
    if (!camera) return;
    setCameras(cameras.map((item) => item.id === camera.id ? { ...item, ...partial } : item));
  };
  return (
    <div>
      <h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">3D Scene</h3>
      {!camera ? (
        <button type="button" onClick={() => setCameras([{ id: crypto.randomUUID(), name: "Camera 1", position: [0, 0, 0], rotation: [0, 0, 0], fov: 50, near: 1, far: 100000, enabled: true }])} className="px-2 py-1 rounded text-[10px] bg-zinc-800 text-zinc-200 hover:bg-zinc-700">Add camera</button>
      ) : (
        <div className="space-y-1.5">
          <label className="flex items-center justify-between text-[10px] text-[var(--text-muted)]">Active camera <input type="checkbox" checked={camera.enabled} onChange={(e) => patchCamera({ enabled: e.target.checked })} /></label>
          <div className="grid grid-cols-2 gap-1.5">
            {(["x", "y", "z"] as const).map((axis, index) => <label key={axis} className="text-[10px] text-[var(--text-muted)]">Cam {axis}<input type="number" value={camera.position[index]} onChange={(e) => { const position = [...camera.position] as [number, number, number]; position[index] = Number(e.target.value); patchCamera({ position }); }} className="mt-0.5 w-full px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]" /></label>)}
            {(["X", "Y", "Z"] as const).map((axis, index) => <label key={axis} className="text-[10px] text-[var(--text-muted)]">Rot {axis}<input type="number" value={camera.rotation[index]} onChange={(e) => { const rotation = [...camera.rotation] as [number, number, number]; rotation[index] = Number(e.target.value); patchCamera({ rotation }); }} className="mt-0.5 w-full px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]" /></label>)}
            <label className="text-[10px] text-[var(--text-muted)]">FOV<input type="number" min={10} max={160} value={camera.fov} onChange={(e) => patchCamera({ fov: Math.max(10, Math.min(160, Number(e.target.value))) })} className="mt-0.5 w-full px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]" /></label>
          </div>
        </div>
      )}
      <div className="mt-2 flex gap-1">
        <button type="button" onClick={() => setLights([...lights, { id: crypto.randomUUID(), name: "Ambient", type: "ambient", color: "#FFFFFF", intensity: 0.5, position: [0, 0, 0], rotation: [0, 0, 0], enabled: true }])} className="px-2 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-200 hover:bg-zinc-700">+ Ambient</button>
        <button type="button" onClick={() => setLights([...lights, { id: crypto.randomUUID(), name: "Key", type: "directional", color: "#FFFFFF", intensity: 1, position: [0, 0, 1000], rotation: [25, -35, 0], enabled: true }])} className="px-2 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-200 hover:bg-zinc-700">+ Key light</button>
      </div>
      {lights.length > 0 && <div className="mt-1.5 space-y-1">{lights.map((light) => <div key={light.id} className="grid grid-cols-[1fr_48px_24px] gap-1 items-center text-[9px] text-[var(--text-muted)]"><span className="truncate">{light.type}: {light.name}</span><input type="number" min={0} max={20} step={0.1} value={light.intensity} onChange={(e) => setLights(lights.map((item) => item.id === light.id ? { ...item, intensity: Math.max(0, Number(e.target.value)) } : item))} className="w-full px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]" /><input type="checkbox" checked={light.enabled} onChange={(e) => setLights(lights.map((item) => item.id === light.id ? { ...item, enabled: e.target.checked } : item))} /></div>)}</div>}
    </div>
  );
}

function MotionGraphEditor({ clip }: { clip: Clip }) {
  const updateClipProperty = useTimelineStore((s) => s.updateClipProperty);
  const graph = clip.motionGraph;
  const createFloatRig = () => {
    const sineId = crypto.randomUUID(); const outputId = crypto.randomUUID();
    const next: MotionGraph = {
      id: crypto.randomUUID(), name: "Float rig",
      nodes: [
        { id: sineId, type: "sine", params: { amplitude: 18, frequency: 0.7, offset: 0 } },
        { id: outputId, type: "output", params: { property: "transform.y" } },
      ],
      edges: [{ id: crypto.randomUUID(), fromNodeId: sineId, fromPort: "value", toNodeId: outputId, toPort: "value" }],
    };
    updateClipProperty(clip.id, "motionGraph", next);
    updateClipProperty(clip.id, "motionGraphId", next.id);
  };
  const patchNode = (nodeId: string, params: Record<string, string | number | boolean>) => {
    if (!graph) return;
    updateClipProperty(clip.id, "motionGraph", { ...graph, nodes: graph.nodes.map((node) => node.id === nodeId ? { ...node, params: { ...node.params, ...params } } : node) });
  };
  const addSineOutput = () => {
    if (!graph) return;
    const sineId = crypto.randomUUID(); const outputId = crypto.randomUUID();
    updateClipProperty(clip.id, "motionGraph", {
      ...graph,
      nodes: [...graph.nodes, { id: sineId, type: "sine", params: { amplitude: 12, frequency: 1, offset: 0 } }, { id: outputId, type: "output", params: { property: "transform.rotation" } }],
      edges: [...graph.edges, { id: crypto.randomUUID(), fromNodeId: sineId, fromPort: "value", toNodeId: outputId, toPort: "value" }],
    });
  };
  return (
    <div>
      <div className="flex items-center justify-between mb-2"><h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider">Motion Graph</h3>{graph && <button type="button" onClick={() => { updateClipProperty(clip.id, "motionGraph", null); updateClipProperty(clip.id, "motionGraphId", null); }} className="text-[10px] text-red-400 hover:underline">Clear</button>}</div>
      {!graph ? <button type="button" onClick={createFloatRig} className="px-2 py-1 rounded text-[10px] bg-violet-950/70 text-violet-100 border border-violet-800 hover:bg-violet-900">Create float graph</button> : (
        <div className="space-y-1.5">
          <input value={graph.name} onChange={(e) => updateClipProperty(clip.id, "motionGraph", { ...graph, name: e.target.value.slice(0, 120) })} className="w-full px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]" />
          <button type="button" onClick={addSineOutput} className="px-2 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-200 hover:bg-zinc-700">+ Sine → output</button>
          <div className="rounded border border-violet-900/70 bg-violet-950/20 p-1.5 space-y-1">
            {graph.nodes.map((node) => <div key={node.id} className="rounded bg-[var(--bg-primary)] border border-[var(--border-default)] p-1.5 text-[10px]">
              <div className="font-mono text-violet-200">{node.type} <span className="text-[var(--text-muted)]">{node.id.slice(0, 6)}</span></div>
              {node.type === "sine" && <div className="grid grid-cols-3 gap-1 mt-1">{(["amplitude", "frequency", "offset"] as const).map((key) => <label key={key} className="text-[9px] text-[var(--text-muted)]">{key}<input type="number" step={0.1} value={Number(node.params[key] ?? 0)} onChange={(e) => patchNode(node.id, { [key]: Number(e.target.value) })} className="mt-0.5 w-full px-1 py-0.5 font-mono bg-zinc-900 border border-zinc-700 rounded text-[10px] text-zinc-100" /></label>)}</div>}
              {node.type === "output" && <><select value={String(node.params.property || "transform.y")} onChange={(e) => patchNode(node.id, { property: e.target.value })} className="mt-1 w-full px-1 py-0.5 bg-zinc-900 border border-zinc-700 rounded text-[10px] text-zinc-100"><option value="transform.x">Position X</option><option value="transform.y">Position Y</option><option value="transform.scaleX">Scale X</option><option value="transform.scaleY">Scale Y</option><option value="transform.rotation">Rotation</option><option value="opacity">Opacity</option></select><select value={graph.edges.find((edge) => edge.toNodeId === node.id)?.fromNodeId || ""} onChange={(e) => updateClipProperty(clip.id, "motionGraph", { ...graph, edges: [...graph.edges.filter((edge) => edge.toNodeId !== node.id), ...(e.target.value ? [{ id: crypto.randomUUID(), fromNodeId: e.target.value, fromPort: "value", toNodeId: node.id, toPort: "value" }] : [])] })} className="mt-1 w-full px-1 py-0.5 bg-zinc-900 border border-zinc-700 rounded text-[10px] text-zinc-100"><option value="">No input</option>{graph.nodes.filter((candidate) => candidate.id !== node.id && candidate.type !== "output").map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.type} · {candidate.id.slice(0, 6)}</option>)}</select></>}
            </div>)}
            {graph.edges.map((edge) => <div key={edge.id} className="font-mono text-[9px] text-violet-300/70">{edge.fromNodeId.slice(0, 6)} ──▶ {edge.toNodeId.slice(0, 6)}</div>)}
          </div>
          <p className="text-[9px] leading-relaxed text-[var(--text-muted)]">Nodes are evaluated every frame and exported through the same WebGPU path. Use agent tools to build larger sine/add/multiply graphs.</p>
        </div>
      )}
    </div>
  );
}

function ChromaKeyInspector({ clip }: { clip: Clip }) {
  const setClipChromaKey = useTimelineStore((s) => s.setClipChromaKey);
  const ck = clip.chromaKey ? normalizeChromaKey(clip.chromaKey) : null;

  const set = (next: ChromaKey | null) => {
    setClipChromaKey(clip.id, next ? normalizeChromaKey(next) : null);
  };

  const patch = (partial: Partial<ChromaKey>) => {
    set(normalizeChromaKey({ ...(ck || DEFAULT_CHROMA_KEY), ...partial }));
  };

  return (
    <div>
      <h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
        Keying
      </h3>
      <p className="text-[9px] text-[var(--text-muted)] mb-2 leading-snug">
        Place over a background track. Key runs before effects.
      </p>
      {!ck ? (
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => set(applyChromaPreset("green-screen"))}
            className="px-2 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
          >
            Green screen
          </button>
          <button
            type="button"
            onClick={() => set(applyChromaPreset("blue-screen"))}
            className="px-2 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
          >
            Blue screen
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label className="text-[11px] text-[var(--text-muted)]">Preset</label>
            <select
              value={ck.screen === "blue" ? "blue-screen" : "green-screen"}
              onChange={(e) => {
                const p = applyChromaPreset(e.target.value);
                if (p) set(p);
              }}
              className="w-28 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-xs text-[var(--text-primary)]"
            >
              <option value="green-screen">Green</option>
              <option value="blue-screen">Blue</option>
            </select>
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="text-[11px] text-[var(--text-muted)]">Key color</label>
            <input
              type="color"
              value={ck.keyColor.length === 7 ? ck.keyColor : "#00FF00"}
              onChange={(e) => patch({ keyColor: e.target.value, screen: "custom" })}
              className="w-10 h-6 bg-transparent border-0 cursor-pointer"
            />
          </div>
          {(
            [
              ["similarity", ck.similarity],
              ["smoothness", ck.smoothness],
              ["spill", ck.spill],
            ] as const
          ).map(([key, value]) => (
            <div key={key} className="flex items-center justify-between gap-2">
              <label className="text-[11px] text-[var(--text-muted)]">{key}</label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={value}
                onChange={(e) => patch({ [key]: parseFloat(e.target.value) })}
                className="w-20 accent-zinc-100"
              />
              <span className="text-[9px] font-mono text-[var(--text-muted)] w-8 text-right">
                {value.toFixed(2)}
              </span>
            </div>
          ))}
          <button
            type="button"
            onClick={() => set(null)}
            className="text-[10px] text-red-400 hover:underline"
          >
            Clear chroma key
          </button>
        </div>
      )}
    </div>
  );
}

function TransitionInspector({ clipId }: { clipId: string }) {
  const tracks = useTimelineStore((s) => s.tracks);
  const transitions = useTimelineStore((s) => s.transitions);
  const addTransition = useTimelineStore((s) => s.addTransition);
  const updateTransition = useTimelineStore((s) => s.updateTransition);
  const setTransitionParams = useTimelineStore((s) => s.setTransitionParams);
  const removeTransitionById = useTimelineStore((s) => s.removeTransitionById);
  const assets = useMediaStore((s) => s.assets);

  const mediaDurations = useMemo(() => {
    const map: Record<string, number> = {};
    for (const a of assets) {
      const d = a.duration ?? a.metadata?.duration;
      if (typeof d === "number" && d > 0) map[a.id] = d;
    }
    return map;
  }, [assets]);

  const { existing, neighbor } = useMemo(() => {
    let track = null as (typeof tracks)[0] | null;
    let clip = null as Clip | null;
    for (const t of tracks) {
      const c = t.clips.find((x) => x.id === clipId);
      if (c) {
        track = t;
        clip = c;
        break;
      }
    }
    if (!track || !clip) return { existing: null, neighbor: null as Clip | null };

    const existing =
      transitions.find(
        (tr) => tr.clipAId === clipId || tr.clipBId === clipId
      ) || null;

    const sorted = [...track.clips].sort((a, b) => a.startTime - b.startTime);
    const idx = sorted.findIndex((c) => c.id === clipId);
    const next = idx >= 0 ? sorted[idx + 1] || null : null;
    const prev = idx > 0 ? sorted[idx - 1] || null : null;
    // Prefer outgoing→incoming: if this is A, neighbor is next; if B, neighbor is prev
    let neighbor: Clip | null = null;
    if (existing) {
      neighbor =
        existing.clipAId === clipId
          ? sorted.find((c) => c.id === existing.clipBId) || null
          : sorted.find((c) => c.id === existing.clipAId) || null;
    } else if (next && Math.abs(next.startTime - clipEnd(clip)) < 0.06) {
      neighbor = next;
    } else if (prev && Math.abs(clip.startTime - clipEnd(prev)) < 0.06) {
      neighbor = prev;
    }
    return { existing, neighbor };
  }, [tracks, transitions, clipId]);

  if (!neighbor && !existing) {
    return (
      <div>
        <h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
          Transition
        </h3>
        <p className="text-[11px] text-[var(--text-muted)]">
          Select a clip at a cut to add a crossfade.
        </p>
      </div>
    );
  }

  const types = listTransitionTypes();

  return (
    <div>
      <h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
        Transition
      </h3>
      {existing ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label className="text-[11px] text-[var(--text-muted)]">Type</label>
            <span className="text-xs text-[var(--text-primary)]">{existing.type}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="text-[11px] text-[var(--text-muted)]">Duration</label>
            <input
              type="number"
              min={0.05}
              max={5}
              step={0.05}
              value={existing.duration}
              onChange={(e) => {
                const d = parseFloat(e.target.value);
                if (!Number.isFinite(d)) return;
                const res = updateTransition(existing.id, d, mediaDurations);
                if (!res.ok) toast.error(res.message);
              }}
              className="w-20 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-xs text-[var(--text-primary)]"
            />
          </div>
          {(() => {
            const def = getTransitionType(existing.type);
            if (!def) return null;
            return Object.entries(def.params)
              .filter(([key]) => key !== "duration")
              .map(([key, param]) => {
                const value = existing.params?.[key] ?? param.defaultValue;
                if (param.type === "string" && param.enum?.length) {
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-2"
                    >
                      <label className="text-[11px] text-[var(--text-muted)]">
                        {param.label}
                      </label>
                      <select
                        value={String(value)}
                        onChange={(e) =>
                          setTransitionParams(existing.id, {
                            [key]: e.target.value,
                          })
                        }
                        className="w-24 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-xs text-[var(--text-primary)]"
                      >
                        {param.enum.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                }
                if (param.type === "number") {
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-2"
                    >
                      <label className="text-[11px] text-[var(--text-muted)]">
                        {param.label}
                      </label>
                      <input
                        type="number"
                        min={param.min}
                        max={param.max}
                        step={param.step ?? 0.01}
                        value={Number(value)}
                        onChange={(e) => {
                          const n = parseFloat(e.target.value);
                          if (!Number.isFinite(n)) return;
                          setTransitionParams(existing.id, { [key]: n });
                        }}
                        className="w-20 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-xs text-[var(--text-primary)]"
                      />
                    </div>
                  );
                }
                return null;
              });
          })()}
          <button
            type="button"
            onClick={() => removeTransitionById(existing.id)}
            className="text-[10px] text-red-400 hover:underline"
          >
            Remove transition
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[10px] text-[var(--text-muted)]">
            Cut with neighbor — add:
          </p>
          <div className="flex flex-wrap gap-1">
            {types.map((t) => (
              <button
                key={t.type}
                type="button"
                onClick={() => {
                  const track = tracks.find((tr) =>
                    tr.clips.some((c) => c.id === clipId)
                  );
                  if (!track || !neighbor) return;
                  const clip = track.clips.find((c) => c.id === clipId)!;
                  const aIsOutgoing = clipEnd(clip) <= neighbor.startTime + 0.06;
                  const clipAId = aIsOutgoing ? clipId : neighbor.id;
                  const clipBId = aIsOutgoing ? neighbor.id : clipId;
                  const res = addTransition(
                    {
                      trackId: track.id,
                      clipAId,
                      clipBId,
                      type: t.type,
                      duration: Number(t.params.duration?.defaultValue ?? 0.5),
                      params: defaultTransitionParams(t.type),
                    },
                    mediaDurations
                  );
                  if (!res.ok) toast.error(res.message);
                  else toast.success(`Added ${t.name}`);
                }}
                className="px-2 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function useDebouncedCallback<TArgs extends unknown[]>(fn: (...args: TArgs) => void, delay = 60): (...args: TArgs) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  }, [fn]);

  return useCallback((...args: TArgs) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(...args), delay);
  }, [delay]);
}

function PropertyInput({
  label,
  value,
  onChange,
  type = "number",
  step,
  min,
  max,
  suffix,
  clip,
  property,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  type?: "number" | "text";
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  clip?: Clip;
  property?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-1">
        {clip && property && (
          <KeyframeControls
            clip={clip}
            property={property}
            label={label}
            value={typeof value === "string" ? parseFloat(value) || 0 : value}
          />
        )}
        <label className="text-[11px] text-[var(--text-muted)]">{label}</label>
      </div>
      <div className="flex items-center gap-1">
        <input
          type={type}
          value={value}
          step={step}
          min={min}
          max={max}
          onChange={(e) => onChange(e.target.value)}
          className="w-20 px-2 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-xs font-mono text-[var(--text-primary)] focus:border-zinc-500 focus:outline-none"
        />
        {suffix && (
          <span className="text-[10px] text-[var(--text-muted)]">{suffix}</span>
        )}
      </div>
    </div>
  );
}

export function Inspector() {
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds);
  const tracks = useTimelineStore((s) => s.tracks);
  const updateClipProperty = useTimelineStore((s) => s.updateClipProperty);
  const updateClipTextParams = useTimelineStore((s) => s.updateClipTextParams);
  const updateClipShapeParams = useTimelineStore((s) => s.updateClipShapeParams);
  const addKeyframe = useTimelineStore((s) => s.addKeyframe);
  const hasSelection = selectedClipIds.size > 0;
  // Subscribe so uploaded fonts appear in the picker after load/upload
  const projectFonts = useFontsStore((s) => s.fonts);
  const fontOptions = useMemo(() => listAvailableFonts(), [projectFonts]);
  const mediaAssets = useMediaStore((s) => s.assets);
  const sequences = useSequenceStore((s) => s.sequences);
  const isEditingSequence = useSequenceStore((s) => s.editStack.length > 1);
  const activeSeqName = useSequenceStore((s) => s.activeSequenceName());
  const enterSequence = useSequenceStore((s) => s.enterSequence);

  const firstId = hasSelection ? selectedClipIds.values().next().value : undefined;
  const selectedTrack = firstId ? tracks.find((track) => track.clips.some((candidate) => candidate.id === firstId)) : undefined;
  const clip = selectedTrack?.clips.find((candidate) => candidate.id === firstId) ?? null;
  const trackType = selectedTrack?.type ?? null;

  const debouncedUpdateClipProperty = useDebouncedCallback(updateClipProperty);

  function updateProp(property: string, rawValue: string) {
    if (!clip) return;
    const value = parseFloat(rawValue);
    if (isNaN(value)) return;
    debouncedUpdateClipProperty(clip.id, property, value);
  }

  const nestSeq =
    clip && isNestClip(clip) && clip.sourceSequenceId
      ? sequences.find((s) => s.id === clip.sourceSequenceId)
      : null;

  return (
    <div className="h-full flex flex-col bg-[var(--bg-secondary)]">
      <div className="h-9 flex items-center px-3 border-b border-[var(--border-default)] flex-shrink-0">
        <span className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
          Inspector
        </span>
        {isEditingSequence && (
          <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] bg-teal-950/60 text-teal-200 truncate max-w-[140px]">
            Seq: {activeSeqName || "…"}
          </span>
        )}
        {clip && (
          <span className="text-[10px] text-[var(--text-muted)] ml-2 font-mono truncate">
            {clip.id.slice(0, 8)}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {!clip ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-10">
            <div className="w-8 h-8 rounded-[var(--radius-sm)] border border-zinc-800 bg-zinc-900 flex items-center justify-center mb-2.5">
              <svg
                className="w-4 h-4 text-zinc-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75"
                />
              </svg>
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              Select a timeline clip to inspect properties
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <CompositingInspector clip={clip} tracks={tracks} />
            <MulticamInspector clip={clip} />
            <Scene3DInspector />
            <MotionGraphEditor clip={clip} />
            {isNestClip(clip) && (
              <div>
                <h3 className="text-[10px] font-mono font-semibold text-teal-400/80 uppercase tracking-wider mb-2">
                  Sequence
                </h3>
                <div className="space-y-2 text-[11px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[var(--text-muted)]">Name</span>
                    <button
                      type="button"
                      className="text-teal-300 hover:underline truncate max-w-[160px]"
                      onClick={() => {
                        if (!clip.sourceSequenceId) return;
                        const r = enterSequence(clip.sourceSequenceId);
                        if (!r.ok) toast.error(r.message);
                      }}
                    >
                      {nestSeq?.name || "Missing sequence"}
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[var(--text-muted)]">Id</span>
                    <span className="font-mono text-[var(--text-secondary)] truncate max-w-[140px]">
                      {clip.sourceSequenceId}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[var(--text-muted)]">Content end</span>
                    <span className="font-mono text-[var(--text-secondary)]">
                      {nestSeq ? `${sequenceContentEnd(nestSeq).toFixed(2)}s` : "—"}
                    </span>
                  </div>
                  <PropertyInput
                    label="Source offset"
                    value={clip.sourceOffset.toFixed(2)}
                    onChange={(v) => updateProp("sourceOffset", v)}
                    step={0.01}
                    min={0}
                    suffix="s"
                  />
                  <p className="text-[10px] text-amber-400/90 leading-relaxed">
                    Nested audio is muted in v1 when this sequence is used on the main
                    timeline (video-only compose).
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      if (!clip.sourceSequenceId) return;
                      const r = enterSequence(clip.sourceSequenceId);
                      if (!r.ok) toast.error(r.message);
                    }}
                    className="w-full px-2 py-1 rounded text-[10px] bg-teal-900/40 text-teal-200 hover:bg-teal-800/50"
                  >
                    Open in timeline
                  </button>
                </div>
              </div>
            )}
            {/* Timing section */}
            <div>
              <h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Timing
              </h3>
              <div className="space-y-2">
                <PropertyInput
                  label="Start"
                  value={clip.startTime.toFixed(2)}
                  onChange={(v) => updateProp("startTime", v)}
                  step={0.01}
                  min={0}
                  suffix="s"
                />
                <PropertyInput
                  label="Duration"
                  value={clip.duration.toFixed(2)}
                  onChange={(v) => updateProp("duration", v)}
                  step={0.01}
                  min={0.1}
                  suffix="s"
                />
                <PropertyInput
                  label="Speed"
                  value={clip.speed.toFixed(2)}
                  onChange={(v) => updateProp("speed", v)}
                  step={0.1}
                  min={0.1}
                  max={10}
                  suffix="x"
                />
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[11px] text-[var(--text-muted)]">Reverse</label>
                  <button
                    type="button"
                    onClick={() =>
                      updateClipProperty(clip.id, "reversed", !clip.reversed)
                    }
                    className={`px-2 py-0.5 rounded text-[10px] ${
                      clip.reversed
                        ? "bg-amber-600 text-white"
                        : "bg-zinc-800 text-zinc-400"
                    }`}
                  >
                    {clip.reversed ? "ON" : "OFF"}
                  </button>
                </div>
                {clip.speedRamp && clip.speedRamp.length >= 2 && (
                  <div className="rounded border border-[var(--border-default)] p-1.5 space-y-1">
                    <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)]"><span>Velocity curve</span><span>{clip.speedRamp.length} points</span></div>
                    {clip.speedRamp.map((point, index) => (
                      <div key={`${point.time}-${index}`} className="grid grid-cols-[1fr_1fr_1.25fr_auto] gap-1 items-end text-[9px] text-[var(--text-muted)]">
                        <label>time<input type="number" min={0} max={clip.duration} step={0.01} value={point.time} onChange={(event) => {
                          const points = clip.speedRamp!.map((candidate, itemIndex) => itemIndex === index ? { ...candidate, time: Number(event.target.value) } : candidate);
                          useTimelineStore.getState().setSpeedRamp(clip.id, normalizeSpeedRamp(points, clip.duration), clip.reversed === true);
                        }} className="mt-0.5 w-full px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[9px] text-[var(--text-primary)]" /></label>
                        <label>rate<input type="number" min={0} max={16} step={0.05} value={point.rate} onChange={(event) => {
                          const points = clip.speedRamp!.map((candidate, itemIndex) => itemIndex === index ? { ...candidate, rate: Number(event.target.value) } : candidate);
                          useTimelineStore.getState().setSpeedRamp(clip.id, normalizeSpeedRamp(points, clip.duration), clip.reversed === true);
                        }} className="mt-0.5 w-full px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[9px] text-[var(--text-primary)]" /></label>
                        <label>to next<select value={point.interpolation || "linear"} disabled={index === clip.speedRamp!.length - 1} onChange={(event) => {
                          const points = clip.speedRamp!.map((candidate, itemIndex) => itemIndex === index ? { ...candidate, interpolation: event.target.value as SpeedRampPoint["interpolation"] } : candidate);
                          useTimelineStore.getState().setSpeedRamp(clip.id, normalizeSpeedRamp(points, clip.duration), clip.reversed === true);
                        }} className="mt-0.5 w-full px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[9px] text-[var(--text-primary)]"><option value="linear">linear</option><option value="smooth">smooth</option><option value="hold">hold</option></select></label>
                        <button type="button" disabled={clip.speedRamp!.length <= 2} onClick={() => useTimelineStore.getState().setSpeedRamp(clip.id, clip.speedRamp!.filter((_, itemIndex) => itemIndex !== index), clip.reversed === true)} className="pb-0.5 text-rose-300 disabled:opacity-30">×</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => {
                      const last = clip.speedRamp![clip.speedRamp!.length - 1]!;
                      const time = Math.max(0, Math.min(clip.duration - 0.01, last.time - Math.max(0.01, clip.duration / 8)));
                      const points = normalizeSpeedRamp([...clip.speedRamp!, { time, rate: last.rate, interpolation: "smooth" }], clip.duration);
                      useTimelineStore.getState().setSpeedRamp(clip.id, points, clip.reversed === true);
                    }} className="text-[9px] text-cyan-300 hover:text-white">+ Add velocity point</button>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[11px] text-[var(--text-muted)]">Retime quality</label>
                  <select value={normalizeRetimeSettings(clip.retime).interpolation} onChange={(event) => updateClipProperty(clip.id, "retime", normalizeRetimeSettings({ ...clip.retime, interpolation: event.target.value as "nearest" | "frame-blend" }))} className="max-w-[140px] px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]"><option value="nearest">Nearest (crisp)</option><option value="frame-blend">Frame blend</option></select>
                </div>
                {normalizeRetimeSettings(clip.retime).interpolation === "frame-blend" && <p className="text-[9px] leading-relaxed text-amber-300/80">Blends adjacent source frames for smoother ramps/slow motion; fast movement can ghost. Uses frame export.</p>}
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[11px] text-[var(--text-muted)]">Speed ramp</label>
                  <select
                    value=""
                    onChange={(e) => {
                      const id = e.target.value;
                      if (!id) return;
                      if (id === "clear") {
                        useTimelineStore
                          .getState()
                          .setSpeedRamp(clip.id, null, clip.reversed === true);
                        return;
                      }
                      const applied = applySpeedPreset(id, clip.duration);
                      if (!applied) return;
                      useTimelineStore.getState().setSpeedRamp(
                        clip.id,
                        applied.speedRamp,
                        applied.reversed
                      );
                      if (applied.speed !== clip.speed) {
                        useTimelineStore
                          .getState()
                          .updateClipProperty(clip.id, "speed", applied.speed);
                      }
                    }}
                    className="max-w-[140px] px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]"
                  >
                    <option value="">
                      {clip.speedRamp && clip.speedRamp.length >= 2
                        ? `${clip.speedRamp.length} pts`
                        : "Presets…"}
                    </option>
                    <option value="slow-mo-middle">Slow-mo middle</option>
                    <option value="ramp-in">Ramp in</option>
                    <option value="ramp-out">Ramp out</option>
                    <option value="speed-up-middle">Speed-up middle</option>
                    <option value="reverse">Reverse</option>
                    <option value="clear">Clear ramp</option>
                  </select>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[11px] text-[var(--text-muted)]">Hold</label>
                  <div className="flex items-center gap-1">
                    <select
                      value={clip.hold?.at || ""}
                      onChange={(e) => {
                        const at = e.target.value as "in" | "out" | "";
                        if (!at) {
                          updateClipProperty(clip.id, "hold", null);
                          return;
                        }
                        updateClipProperty(clip.id, "hold", {
                          at,
                          durationSec: clip.hold?.durationSec || 0.5,
                        });
                      }}
                      className="w-14 px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]"
                    >
                      <option value="">Off</option>
                      <option value="in">In</option>
                      <option value="out">Out</option>
                    </select>
                    <input
                      type="number"
                      value={clip.hold?.durationSec ?? 0}
                      disabled={!clip.hold}
                      onChange={(e) => {
                        const durationSec = parseFloat(e.target.value) || 0;
                        if (durationSec <= 0 || !clip.hold) {
                          updateClipProperty(clip.id, "hold", null);
                          return;
                        }
                        updateClipProperty(clip.id, "hold", {
                          at: clip.hold.at,
                          durationSec,
                        });
                      }}
                      min={0}
                      step={0.1}
                      className="w-12 px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] font-mono text-[var(--text-primary)] disabled:opacity-40"
                    />
                    <span className="text-[10px] text-[var(--text-muted)]">s</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="h-px bg-[var(--border-default)]" />

            <div>
              <h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Edit
              </h3>
              <div className="flex flex-wrap gap-1 mb-2">
                <button
                  type="button"
                  onClick={() => {
                    const res = useTimelineStore.getState().closeGap(clip.trackId);
                    if (!res.ok) toast.error(res.message);
                  }}
                  className="px-2 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                >
                  Close gap
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const res = useTimelineStore.getState().rippleRemoveClip(clip.id);
                    if (!res.ok) {
                      toast.error(res.message);
                      return;
                    }
                    useSelectionStore.getState().deselectAll();
                  }}
                  className="px-2 py-0.5 rounded text-[10px] bg-zinc-800 text-red-300 hover:bg-zinc-700"
                >
                  Ripple delete
                </button>
              </div>
              {clip.sourceMediaId ? (
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[11px] text-[var(--text-muted)]">Replace media</label>
                  <select
                    value=""
                    onChange={(e) => {
                      const mediaId = e.target.value;
                      if (!mediaId) return;
                      const asset = useMediaStore
                        .getState()
                        .assets.find((a) => a.id === mediaId);
                      const mediaDurationSec =
                        asset?.duration ?? asset?.metadata?.duration ?? undefined;
                      const res = useTimelineStore.getState().replaceClipMedia(
                        clip.id,
                        mediaId,
                        {
                          fit: "keep-duration",
                          mediaDurationSec:
                            typeof mediaDurationSec === "number"
                              ? mediaDurationSec
                              : undefined,
                        }
                      );
                      if (!res.ok) toast.error(res.message);
                      else toast.success("Media replaced");
                    }}
                    className="max-w-[140px] px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]"
                  >
                    <option value="">Pick asset…</option>
                    {mediaAssets
                      .filter(
                        (a) =>
                          a.id !== clip.sourceMediaId &&
                          (a.type === "video" || a.type === "image" || a.type === "audio")
                      )
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name || a.id.slice(0, 8)}
                        </option>
                      ))}
                  </select>
                </div>
              ) : null}
            </div>

            {trackType !== "adjustment" && (
              <>
                <div className="h-px bg-[var(--border-default)]" />

            {/* Transform section */}
            <div>
              <h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Transform
              </h3>
              <div className="space-y-2">
                <PropertyInput
                  label="Position X"
                  value={clip.transform.x}
                  onChange={(v) => updateProp("transform.x", v)}
                  step={1}
                  clip={clip}
                  property="transform.x"
                />
                <PropertyInput
                  label="Position Y"
                  value={clip.transform.y}
                  onChange={(v) => updateProp("transform.y", v)}
                  step={1}
                  clip={clip}
                  property="transform.y"
                />
                <PropertyInput
                  label="Scale X"
                  value={clip.transform.scaleX.toFixed(2)}
                  onChange={(v) => updateProp("transform.scaleX", v)}
                  step={0.01}
                  min={0}
                  clip={clip}
                  property="transform.scaleX"
                />
                <PropertyInput
                  label="Scale Y"
                  value={clip.transform.scaleY.toFixed(2)}
                  onChange={(v) => updateProp("transform.scaleY", v)}
                  step={0.01}
                  min={0}
                  clip={clip}
                  property="transform.scaleY"
                />
                <PropertyInput
                  label="Rotation"
                  value={clip.transform.rotation}
                  onChange={(v) => updateProp("transform.rotation", v)}
                  step={1}
                  suffix="deg"
                  clip={clip}
                  property="transform.rotation"
                />
                <PropertyInput
                  label="Anchor X"
                  value={clip.transform.anchorX}
                  onChange={(v) => updateProp("transform.anchorX", v)}
                  step={1}
                />
                <PropertyInput
                  label="Anchor Y"
                  value={clip.transform.anchorY}
                  onChange={(v) => updateProp("transform.anchorY", v)}
                  step={1}
                />
              </div>
            </div>

                <div className="h-px bg-[var(--border-default)]" />
              </>
            )}

            {trackType !== "audio" && trackType !== "adjustment" && (
              <>
                <div className="h-px bg-[var(--border-default)]" />
                <CropInspector clip={clip} />
              </>
            )}

            {/* Appearance section */}
            <div>
              <h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Appearance
              </h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    <KeyframeControls clip={clip} property="opacity" label="Opacity" value={clip.opacity} />
                    <label className="text-[11px] text-[var(--text-muted)]">Opacity</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={clip.opacity}
                      onChange={(e) =>
                        updateClipProperty(clip.id, "opacity", parseFloat(e.target.value))
                      }
                      className="w-16 accent-zinc-100"
                    />
                    <span className="text-[10px] font-mono text-[var(--text-muted)] w-8 text-right">
                      {Math.round(clip.opacity * 100)}%
                    </span>
                  </div>
                </div>
                {trackType !== "adjustment" && <div className="flex items-center justify-between gap-2">
                  <label className="text-[11px] text-[var(--text-muted)]">Blend Mode</label>
                  <select
                    value={clip.blendMode}
                    onChange={(e) =>
                      updateClipProperty(clip.id, "blendMode", e.target.value as BlendMode)
                    }
                    className="w-24 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-xs text-[var(--text-primary)] focus:outline-none"
                  >
                    {[
                      "normal", "multiply", "screen", "overlay", "darken",
                      "lighten", "color-dodge", "color-burn", "hard-light",
                      "soft-light", "difference", "exclusion",
                    ].map((mode) => (
                      <option key={mode} value={mode}>
                        {mode.charAt(0).toUpperCase() + mode.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>}
                {trackType !== "adjustment" && <div className="flex items-center justify-between gap-2">
                  <label className="text-[11px] text-[var(--text-muted)]">Volume</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={clip.volume}
                      onChange={(e) =>
                        updateClipProperty(clip.id, "volume", parseFloat(e.target.value))
                      }
                      className="w-16 accent-zinc-100"
                    />
                    <span className="text-[10px] font-mono text-[var(--text-muted)] w-8 text-right">
                      {Math.round(clip.volume * 100)}%
                    </span>
                  </div>
                </div>}
              </div>
            </div>

            {clip.lottieParams && (
              <>
                <div className="h-px bg-[var(--border-default)]" />
                <div className="space-y-2">
                  <h3 className="text-[10px] font-mono font-semibold text-pink-300 uppercase tracking-wider">Lottie animation</h3>
                  <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
                    <span className="truncate">Asset {clip.lottieParams.assetId.slice(0, 8)}</span>
                    <label className="flex items-center gap-1">Loop <input type="checkbox" checked={clip.lottieParams.loop !== false} onChange={(e) => updateClipProperty(clip.id, "lottieParams", { ...clip.lottieParams!, loop: e.target.checked })} /></label>
                  </div>
                  <PropertyInput label="Speed" value={clip.lottieParams.speed ?? 1} onChange={(v) => updateClipProperty(clip.id, "lottieParams", { ...clip.lottieParams!, speed: Math.max(0.01, Number(v) || 1) })} step={0.05} min={0.01} max={4} suffix="×" />
                  <p className="text-[9px] leading-3 text-[var(--text-muted)]">Canvas-rendered in preview and frame export. Use normal transform controls for placement.</p>
                </div>
              </>
            )}

            {/* Text Properties (text clips only) */}
            {trackType === "text" && clip.textParams && (
              <>
                <div className="h-px bg-[var(--border-default)]" />
                <div>
                  <h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                    Text
                  </h3>
                  <div className="space-y-2">
                    <div>
                      <label className="text-[11px] text-[var(--text-muted)] block mb-1">Content</label>
                      <textarea
                        value={clip.textParams.text}
                        onChange={(e) => updateClipTextParams(clip.id, { text: e.target.value })}
                        rows={2}
                        className="w-full px-2 py-1.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-xs text-[var(--text-primary)] resize-none focus:border-zinc-500 focus:outline-none"
                      />
                    </div>
                    <RichTextRunsEditor
                      params={clip.textParams}
                      onChange={(params) => updateClipTextParams(clip.id, params)}
                    />
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] text-[var(--text-muted)]">Font</label>
                      <select
                        value={
                          clip.textParams.fontId ||
                          `google:${clip.textParams.fontFamily.split(",")[0]!.replace(/"/g, "").trim()}`
                        }
                        onChange={(e) => {
                          const fontId = e.target.value;
                          const entry = fontOptions.find((f) => f.id === fontId);
                          if (!entry) return;
                          if (entry.source === "google") {
                            loadFont(entry.familyName);
                            updateClipTextParams(clip.id, {
                              fontId,
                              fontFamily: getFontCSS(entry.familyName),
                            });
                          } else {
                            void loadFontById(fontId).then(() => {
                              updateClipTextParams(clip.id, {
                                fontId,
                                fontFamily: getFontCSS(entry.familyName),
                              });
                            });
                          }
                        }}
                        className="w-28 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-xs text-[var(--text-primary)] focus:outline-none"
                      >
                        {fontOptions.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.source === "upload" ? `${f.familyName} (upload)` : f.familyName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <PropertyInput
                      label="Size"
                      value={clip.textParams.fontSize}
                      onChange={(v) => updateClipTextParams(clip.id, { fontSize: parseInt(v) || 48 })}
                      step={1}
                      min={8}
                      max={400}
                      suffix="px"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] text-[var(--text-muted)]">Weight</label>
                      <select
                        value={clip.textParams.fontWeight}
                        onChange={(e) => updateClipTextParams(clip.id, { fontWeight: e.target.value })}
                        className="w-20 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-xs text-[var(--text-primary)] focus:outline-none"
                      >
                        {["300", "400", "500", "600", "700", "800", "900"].map((w) => (
                          <option key={w} value={w}>{w}</option>
                        ))}
                      </select>
                    </div>
                    <KineticAnimatorEditor
                      params={clip.textParams}
                      onChange={(params) => updateClipTextParams(clip.id, params)}
                    />
                    {clip.captionBinding && (
                      <div className="rounded border border-amber-900/70 bg-amber-950/20 p-2 space-y-1.5">
                        <label className="block text-[10px] font-mono uppercase tracking-wider text-amber-200">Caption graphics preset
                          <select
                            value={clip.textParams.captionPresetId || ""}
                            onChange={(event) => {
                              const next = applyCaptionPreset(clip.textParams!, event.target.value, clip.duration);
                              if (next) updateClipTextParams(clip.id, next);
                            }}
                            className="mt-1 w-full px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]"
                          >
                            <option value="" disabled>Select reusable look…</option>
                            {CAPTION_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                          </select>
                        </label>
                        <div className="grid grid-cols-3 gap-1.5">
                          {(["maxWidth", "backgroundPadding", "backgroundRadius"] as const).map((key) => (
                            <label key={key} className="text-[9px] text-amber-200/80">{key === "maxWidth" ? "Width" : key === "backgroundPadding" ? "Padding" : "Radius"}
                              <input type="number" min={0} max={key === "maxWidth" ? 4000 : 100} step={1} value={clip.textParams?.[key] ?? 0}
                                onChange={(event) => updateClipTextParams(clip.id, { [key]: Math.max(0, Number(event.target.value) || 0) })}
                                className="mt-0.5 w-full px-1 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)]" />
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] text-[var(--text-muted)]">Color</label>
                      <input
                        type="color"
                        value={clip.textParams.color}
                        onChange={(e) => updateClipTextParams(clip.id, { color: e.target.value })}
                        className="w-8 h-6 rounded border border-[var(--border-default)] cursor-pointer"
                      />
                    </div>
                    <div className="rounded border border-violet-900/60 bg-violet-950/15 p-2 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] font-mono uppercase tracking-wider text-violet-200">Gradient fill</label>
                        <button
                          type="button"
                          onClick={() => updateClipTextParams(clip.id, {
                            fillGradient: clip.textParams!.fillGradient
                              ? undefined
                              : { type: "linear", from: clip.textParams!.color, to: "#8b5cf6", angle: 0 },
                          })}
                          className="text-[10px] text-violet-200 hover:text-white"
                        >
                          {clip.textParams.fillGradient ? "Disable" : "Enable"}
                        </button>
                      </div>
                      {clip.textParams.fillGradient && (
                        <div className="grid grid-cols-[1fr_1fr_48px] gap-1">
                          <input type="color" value={clip.textParams.fillGradient.from} onChange={(e) => updateClipTextParams(clip.id, { fillGradient: { ...clip.textParams!.fillGradient!, from: e.target.value } })} className="h-6 w-full rounded" title="Gradient start" />
                          <input type="color" value={clip.textParams.fillGradient.to} onChange={(e) => updateClipTextParams(clip.id, { fillGradient: { ...clip.textParams!.fillGradient!, to: e.target.value } })} className="h-6 w-full rounded" title="Gradient end" />
                          <input type="number" value={clip.textParams.fillGradient.angle ?? 0} onChange={(e) => updateClipTextParams(clip.id, { fillGradient: { ...clip.textParams!.fillGradient!, angle: Number(e.target.value) || 0 } })} className="w-full px-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px]" title="Angle" />
                        </div>
                      )}
                    </div>
                    <label className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
                      Outline only
                      <input type="checkbox" checked={clip.textParams.fillEnabled === false} onChange={(e) => updateClipTextParams(clip.id, { fillEnabled: !e.target.checked })} />
                    </label>
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] text-[var(--text-muted)]">Align</label>
                      <div className="flex gap-0.5">
                        {(["left", "center", "right"] as const).map((align) => (
                          <button
                            key={align}
                            onClick={() => updateClipTextParams(clip.id, { textAlign: align })}
                            className={`px-2 py-0.5 rounded text-[10px] ${
                              clip.textParams!.textAlign === align
                                ? "bg-zinc-700 text-white"
                                : "text-zinc-400 hover:text-white"
                            }`}
                          >
                            {align.charAt(0).toUpperCase() + align.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] text-[var(--text-muted)]">Stroke</label>
                      <div className="flex items-center gap-1">
                        <input
                          type="color"
                          value={clip.textParams.stroke || "#000000"}
                          onChange={(e) => updateClipTextParams(clip.id, { stroke: e.target.value, strokeWidth: clip.textParams!.strokeWidth || 2 })}
                          className="w-6 h-5 rounded border border-[var(--border-default)] cursor-pointer"
                        />
                        <input
                          type="number"
                          value={clip.textParams.strokeWidth || 0}
                          onChange={(e) => updateClipTextParams(clip.id, { strokeWidth: parseFloat(e.target.value) })}
                          min={0}
                          max={20}
                          step={0.5}
                          className="w-12 px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] font-mono text-[var(--text-primary)] focus:outline-none"
                        />
                      </div>
                    </div>
                    <PropertyInput
                      label="Tracking"
                      value={clip.textParams.letterSpacing ?? 0}
                      onChange={(v) =>
                        updateClipTextParams(clip.id, {
                          letterSpacing: parseFloat(v) || 0,
                        })
                      }
                      step={0.5}
                      min={-20}
                      max={40}
                      suffix="px"
                    />
                    <PropertyInput
                      label="Leading"
                      value={clip.textParams.lineHeight}
                      onChange={(v) =>
                        updateClipTextParams(clip.id, {
                          lineHeight: parseFloat(v) || 1.3,
                        })
                      }
                      step={0.05}
                      min={0.8}
                      max={3}
                    />
                    <div>
                      <label className="text-[11px] text-[var(--text-muted)] block mb-1">Shadow</label>
                      <input
                        type="text"
                        value={clip.textParams.shadow || ""}
                        onChange={(e) =>
                          updateClipTextParams(clip.id, {
                            shadow: e.target.value || undefined,
                          })
                        }
                        placeholder="0 2px 8px rgba(0,0,0,0.5)"
                        className="w-full px-2 py-1.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-xs font-mono text-[var(--text-primary)] focus:border-zinc-500 focus:outline-none"
                      />
                    </div>
                    <LayerDepthEditor
                      shadow={clip.textParams.shadowStyle}
                      glow={clip.textParams.glow}
                      onChange={(next) => updateClipTextParams(clip.id, {
                        shadowStyle: next.shadow,
                        glow: next.glow,
                      })}
                    />
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] text-[var(--text-muted)]">Background</label>
                      <div className="flex items-center gap-1">
                        <input
                          type="color"
                          value={
                            clip.textParams.backgroundColor?.startsWith("#")
                              ? clip.textParams.backgroundColor.slice(0, 7)
                              : "#000000"
                          }
                          onChange={(e) =>
                            updateClipTextParams(clip.id, {
                              backgroundColor: e.target.value,
                            })
                          }
                          className="w-6 h-5 rounded border border-[var(--border-default)] cursor-pointer"
                        />
                        <input
                          type="text"
                          value={clip.textParams.backgroundColor || ""}
                          onChange={(e) =>
                            updateClipTextParams(clip.id, {
                              backgroundColor: e.target.value || undefined,
                            })
                          }
                          placeholder="transparent"
                          className="w-24 px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] font-mono text-[var(--text-primary)] focus:outline-none"
                        />
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] text-[var(--text-muted)]">Kinetic</label>
                      <select
                        defaultValue=""
                        onChange={(e) => {
                          const id = e.target.value;
                          if (!id || !clip?.textParams) return;
                          const next = applyTextAnimatorPreset(
                            clip.textParams,
                            id,
                            clip.duration
                          );
                          updateClipTextParams(clip.id, {
                            split: next.split,
                            animators: next.animators,
                          });
                          e.target.value = "";
                        }}
                        className="w-28 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-xs text-[var(--text-primary)] focus:outline-none"
                      >
                        <option value="" disabled>Apply...</option>
                        {TEXT_ANIMATOR_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] text-[var(--text-muted)]">Clip motion</label>
                      <select
                        defaultValue=""
                        onChange={(e) => {
                          const preset = TEXT_ANIMATION_PRESETS.find((p) => p.id === e.target.value);
                          if (!preset || !clip) return;
                          const kfs = preset.generateKeyframes(clip.duration);
                          for (const k of kfs) addKeyframe(clip.id, k.property, k.time, k.value, k.easing);
                          e.target.value = "";
                        }}
                        className="w-28 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-xs text-[var(--text-primary)] focus:outline-none"
                      >
                        <option value="" disabled>Apply...</option>
                        {TEXT_ANIMATION_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* Shape Properties (shape clips only) */}
            {trackType === "shape" && clip.shapeParams && (
              <>
                <div className="h-px bg-[var(--border-default)]" />
                <div>
                  <h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                    Shape
                  </h3>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] text-[var(--text-muted)]">Type</label>
                      <select
                        value={clip.shapeParams.shape}
                        onChange={(e) => updateClipShapeParams(clip.id, { shape: e.target.value as ShapeType })}
                        className="w-24 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-xs text-[var(--text-primary)] focus:outline-none"
                      >
                        {(["rect", "ellipse", "triangle", "polygon", "star", "line", "path"] as const).map((s) => (
                          <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] text-[var(--text-muted)]">Fill</label>
                      <input
                        type="color"
                        value={clip.shapeParams.fill}
                        onChange={(e) => updateClipShapeParams(clip.id, { fill: e.target.value })}
                        className="w-8 h-6 rounded border border-[var(--border-default)] cursor-pointer"
                      />
                    </div>
                    <div className="rounded border border-violet-900/60 bg-violet-950/15 p-2 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] font-mono uppercase tracking-wider text-violet-200">Gradient fill</label>
                        <button
                          type="button"
                          onClick={() => updateClipShapeParams(clip.id, {
                            fillGradient: clip.shapeParams!.fillGradient
                              ? undefined
                              : { type: "linear", from: clip.shapeParams!.fill, to: "#8b5cf6", angle: 0 },
                          })}
                          className="text-[10px] text-violet-200 hover:text-white"
                        >
                          {clip.shapeParams.fillGradient ? "Disable" : "Enable"}
                        </button>
                      </div>
                      {clip.shapeParams.fillGradient && (
                        <div className="grid grid-cols-[1fr_1fr_48px] gap-1">
                          <input type="color" value={clip.shapeParams.fillGradient.from} onChange={(e) => updateClipShapeParams(clip.id, { fillGradient: { ...clip.shapeParams!.fillGradient!, from: e.target.value } })} className="h-6 w-full rounded" title="Gradient start" />
                          <input type="color" value={clip.shapeParams.fillGradient.to} onChange={(e) => updateClipShapeParams(clip.id, { fillGradient: { ...clip.shapeParams!.fillGradient!, to: e.target.value } })} className="h-6 w-full rounded" title="Gradient end" />
                          <input type="number" value={clip.shapeParams.fillGradient.angle ?? 0} onChange={(e) => updateClipShapeParams(clip.id, { fillGradient: { ...clip.shapeParams!.fillGradient!, angle: Number(e.target.value) || 0 } })} className="w-full px-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px]" title="Angle" />
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] text-[var(--text-muted)]">Stroke</label>
                      <div className="flex items-center gap-1">
                        <input
                          type="color"
                          value={clip.shapeParams.stroke === "transparent" ? "#000000" : clip.shapeParams.stroke}
                          onChange={(e) => updateClipShapeParams(clip.id, { stroke: e.target.value })}
                          className="w-6 h-5 rounded border border-[var(--border-default)] cursor-pointer"
                        />
                        <input
                          type="number"
                          value={clip.shapeParams.strokeWidth}
                          onChange={(e) => updateClipShapeParams(clip.id, { strokeWidth: parseFloat(e.target.value) || 0 })}
                          min={0}
                          max={50}
                          step={1}
                          className="w-12 px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] font-mono text-[var(--text-primary)] focus:outline-none"
                        />
                      </div>
                    </div>
                    <LayerDepthEditor
                      shadow={clip.shapeParams.shadow}
                      glow={clip.shapeParams.glow}
                      onChange={(next) => updateClipShapeParams(clip.id, {
                        shadow: next.shadow,
                        glow: next.glow,
                      })}
                    />
                    <PropertyInput
                      label="Width"
                      value={clip.shapeParams.width}
                      onChange={(v) => updateClipShapeParams(clip.id, { width: parseInt(v) || 200 })}
                      step={1}
                      min={1}
                      suffix="px"
                    />
                    <PropertyInput
                      label="Height"
                      value={clip.shapeParams.height}
                      onChange={(v) => updateClipShapeParams(clip.id, { height: parseInt(v) || 200 })}
                      step={1}
                      min={1}
                      suffix="px"
                    />
                    {clip.shapeParams.shape === "rect" && (
                      <PropertyInput
                        label="Radius"
                        value={clip.shapeParams.cornerRadius || 0}
                        onChange={(v) => updateClipShapeParams(clip.id, { cornerRadius: parseInt(v) || 0 })}
                        step={1}
                        min={0}
                        suffix="px"
                      />
                    )}
                    {(clip.shapeParams.shape === "polygon" || clip.shapeParams.shape === "star") && (
                      <PropertyInput
                        label="Points"
                        value={clip.shapeParams.points || (clip.shapeParams.shape === "polygon" ? 6 : 5)}
                        onChange={(v) => updateClipShapeParams(clip.id, { points: parseInt(v) || 5 })}
                        step={1}
                        min={3}
                        max={20}
                      />
                    )}
                    {clip.shapeParams.shape === "star" && (
                      <PropertyInput
                        label="Inner R"
                        value={((clip.shapeParams.innerRadius || 0.4) * 100).toFixed(0)}
                        onChange={(v) => updateClipShapeParams(clip.id, { innerRadius: (parseInt(v) || 40) / 100 })}
                        step={5}
                        min={10}
                        max={90}
                        suffix="%"
                      />
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] text-[var(--text-muted)]">Animation</label>
                      <select
                        defaultValue=""
                        onChange={(e) => {
                          const preset = SHAPE_ANIMATION_PRESETS.find((p) => p.id === e.target.value);
                          if (!preset || !clip) return;
                          const kfs = preset.generateKeyframes(clip.duration);
                          for (const k of kfs) addKeyframe(clip.id, k.property, k.time, k.value, k.easing);
                          e.target.value = "";
                        }}
                        className="w-28 px-1.5 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-xs text-[var(--text-primary)] focus:outline-none"
                      >
                        <option value="" disabled>Apply...</option>
                        {SHAPE_ANIMATION_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </>
            )}

            <div className="h-px bg-[var(--border-default)]" />

            {/* Transition section */}
            <MaskInspector clip={clip} />
            <TransitionInspector clipId={clip.id} />

            <div className="h-px bg-[var(--border-default)]" />

            <ChromaKeyInspector clip={clip} />

            <div className="h-px bg-[var(--border-default)]" />

            {/* Effects section */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                  Effects
                </h3>
                <button
                  onClick={() => {
                    const store = useUIStore.getState();
                    if (!store.panels.effects) store.togglePanel("effects");
                  }}
                  className="text-[10px] text-zinc-300 hover:underline font-medium"
                >
                  + Add
                </button>
              </div>
              {clip.effects.length === 0 ? (
                <p className="text-[11px] text-[var(--text-muted)]">No active effects</p>
              ) : (
                <div className="space-y-1.5">
                  {clip.effects.map((effect) => (
                    <EffectParams key={effect.id} clipId={clip.id} effect={effect} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
