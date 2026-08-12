"use client";

import { useCallback, useRef, useEffect, useState } from "react";
import type { Clip, Track } from "@tempo/types";
import { useSelectionStore } from "@/stores/selection.store";
import { useTimelineStore } from "@/stores/timeline.store";
import { useUIStore } from "@/stores/ui.store";
import { useMediaStore } from "@/stores/media.store";
import { useSequenceStore } from "@/stores/sequence.store";
import { getAssetPreviewUrl, resolveMediaUrl } from "@/lib/media-url";
import { isNestClip, normalizeAudioAutomationPoints } from "@tempo/editor-core";
import { toast } from "sonner";

interface ClipBlockProps {
  clip: Clip;
  track: Track;
  zoom: number;
  onContextMenu: (e: React.MouseEvent, clipId: string, trackId: string) => void;
  getSnapTargets: () => number[];
}

const TRIM_HANDLE_WIDTH = 6;
const SNAP_THRESHOLD_PX = 8;

const TRACK_COLORS: Record<string, string> = {
  video: "bg-blue-900/60 border-blue-700 hover:bg-blue-800/60",
  audio: "bg-green-900/60 border-green-700 hover:bg-green-800/60",
  text: "bg-purple-900/60 border-purple-700 hover:bg-purple-800/60",
  shape: "bg-orange-900/60 border-orange-700 hover:bg-orange-800/60",
  effect: "bg-pink-900/60 border-pink-700 hover:bg-pink-800/60",
  adjustment: "bg-fuchsia-900/60 border-fuchsia-700 hover:bg-fuchsia-800/60",
  null: "bg-slate-800/60 border-slate-600 hover:bg-slate-700/60",
};

export function ClipBlock({ clip, track, zoom, onContextMenu, getSnapTargets }: ClipBlockProps) {
  const isSelected = useSelectionStore((s) => s.selectedClipIds.has(clip.id));
  const selectClip = useSelectionStore((s) => s.selectClip);
  const toggleClip = useSelectionStore((s) => s.toggleClip);
  const moveClip = useTimelineStore((s) => s.moveClip);
  const trimClip = useTimelineStore((s) => s.trimClip);
  const updateClipProperty = useTimelineStore((s) => s.updateClipProperty);
  const nest = isNestClip(clip);
  const seqName = useSequenceStore((s) =>
    nest && clip.sourceSequenceId
      ? s.sequences.find((x) => x.id === clip.sourceSequenceId)?.name
      : null
  );
  const enterSequence = useSequenceStore((s) => s.enterSequence);
  const dragRef = useRef<{
    type: "move" | "trim-left" | "trim-right";
    startX: number;
    originalStartTime: number;
    originalDuration: number;
  } | null>(null);

  function snapTime(time: number): number {
    if (!useUIStore.getState().snapEnabled) return time;
    const targets = getSnapTargets();
    const threshold = SNAP_THRESHOLD_PX / zoom;
    for (const target of targets) {
      if (Math.abs(time - target) < threshold) return target;
    }
    return time;
  }

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, type: "move" | "trim-left" | "trim-right") => {
      if (track.locked) return;
      e.stopPropagation();

      if (type === "move") {
        if (e.shiftKey) {
          toggleClip(clip.id);
        } else {
          selectClip(clip.id);
        }
      }

      dragRef.current = {
        type,
        startX: e.clientX,
        originalStartTime: clip.startTime,
        originalDuration: clip.duration,
      };

      const handleMouseMove = (e: MouseEvent) => {
        if (!dragRef.current) return;
        const dx = e.clientX - dragRef.current.startX;
        const dt = dx / zoom;

        if (dragRef.current.type === "move") {
          const newStart = snapTime(
            Math.max(0, dragRef.current.originalStartTime + dt)
          );
          moveClip(clip.id, track.id, newStart);
        } else if (dragRef.current.type === "trim-left") {
          const minDt = clip.sourceMediaId
            ? Math.max(
                -dragRef.current.originalStartTime,
                -clip.sourceOffset / (clip.speed || 1)
              )
            : -dragRef.current.originalStartTime;
          const maxDt = dragRef.current.originalDuration - 0.1;
          const clampedDt = Math.max(minDt, Math.min(maxDt, dt));
          const snappedStart = snapTime(dragRef.current.originalStartTime + clampedDt);
          const newStart = Math.max(
            dragRef.current.originalStartTime + minDt,
            Math.min(dragRef.current.originalStartTime + maxDt, snappedStart)
          );
          const actualDt = newStart - dragRef.current.originalStartTime;
          trimClip(
            clip.id,
            newStart,
            dragRef.current.originalDuration - actualDt
          );
        } else if (dragRef.current.type === "trim-right") {
          const newDuration = Math.max(0.1, dragRef.current.originalDuration + dt);
          const endTime = snapTime(dragRef.current.originalStartTime + newDuration);
          trimClip(
            clip.id,
            dragRef.current.originalStartTime,
            endTime - dragRef.current.originalStartTime
          );
        }
      };

      const handleMouseUp = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor =
        type === "move"
          ? "grabbing"
          : "ew-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [clip, track, zoom, selectClip, toggleClip, moveClip, trimClip, getSnapTargets]
  );

  const mediaAssets = useMediaStore((s) => s.assets);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const [waveformPeaks, setWaveformPeaks] = useState<number[] | null>(null);

  const sourceAsset = clip.sourceMediaId
    ? mediaAssets.find((a) => a.id === clip.sourceMediaId)
    : undefined;
  const previewUrl =
    (track.type === "video" || sourceAsset?.type === "image") && sourceAsset
      ? getAssetPreviewUrl(sourceAsset)
      : null;

  useEffect(() => {
    if (track.type !== "audio" && track.type !== "video") return;
    if (!clip.sourceMediaId) return;

    const asset = mediaAssets.find((a) => a.id === clip.sourceMediaId);
    if (!asset?.waveformUrl) return;

    const url = resolveMediaUrl(asset.waveformUrl);
    if (!url) return;
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (data?.peaks && Array.isArray(data.peaks)) {
          setWaveformPeaks(data.peaks);
        }
      })
      .catch(() => {});
  }, [clip.sourceMediaId, track.type, mediaAssets]);

  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas || !waveformPeaks) return;

    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = track.type === "audio" ? "rgba(74, 222, 128, 0.35)" : "rgba(96, 165, 250, 0.25)";

    const step = waveformPeaks.length / w;
    for (let i = 0; i < w; i++) {
      const idx = Math.floor(i * step);
      const peak = waveformPeaks[idx] ?? 0;
      const barH = peak * h * 0.8;
      ctx.fillRect(i, (h - barH) / 2, 1, barH);
    }
  }, [waveformPeaks, clip.duration, zoom, track.type]);

  const colorClass = nest
    ? "bg-teal-900/70 border-teal-600 hover:bg-teal-800/70"
    : TRACK_COLORS[track.type] || TRACK_COLORS.video;
  const widthPx = clip.duration * zoom;
  const isAudioBearing = track.type === "audio" || track.type === "video";
  const volumePoints = normalizeAudioAutomationPoints(clip.audioAutomation?.volume, "volume", clip.duration);
  const envelopePoints = volumePoints.length ? volumePoints : [{ time: 0, value: 1 }, { time: clip.duration, value: 1 }];
  const envelopePath = envelopePoints
    .map((point, index) => `${index === 0 ? "M" : "L"}${(point.time / Math.max(0.001, clip.duration)) * 100} ${100 - (point.value / 2) * 100}`)
    .join(" ");

  const updateVolumePoint = useCallback((pointIndex: number | null, clientX: number, clientY: number, rect: DOMRect) => {
    const time = Math.max(0, Math.min(clip.duration, ((clientX - rect.left) / Math.max(1, rect.width)) * clip.duration));
    const value = Math.max(0, Math.min(2, (1 - (clientY - rect.top) / Math.max(1, rect.height)) * 2));
    const next = [...volumePoints];
    if (pointIndex == null) next.push({ id: crypto.randomUUID(), time, value, interpolation: "linear" });
    else if (next[pointIndex]) next[pointIndex] = { ...next[pointIndex]!, time, value };
    updateClipProperty(clip.id, "audioAutomation", {
      ...(clip.audioAutomation || {}),
      volume: normalizeAudioAutomationPoints(next, "volume", clip.duration),
    });
  }, [clip, updateClipProperty, volumePoints]);

  const beginEnvelopeDrag = useCallback((event: React.MouseEvent<SVGCircleElement>, pointIndex: number | null) => {
    if (track.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    updateVolumePoint(pointIndex, event.clientX, event.clientY, rect);
    const move = (next: MouseEvent) => updateVolumePoint(pointIndex, next.clientX, next.clientY, rect);
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }, [track.locked, updateVolumePoint]);

  const beginFadeDrag = useCallback((event: React.MouseEvent<HTMLButtonElement>, side: "in" | "out") => {
    if (track.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const block = event.currentTarget.parentElement;
    if (!block) return;
    const rect = block.getBoundingClientRect();
    const setFade = (clientX: number) => {
      const amount = side === "in"
        ? ((clientX - rect.left) / Math.max(1, rect.width)) * clip.duration
        : ((rect.right - clientX) / Math.max(1, rect.width)) * clip.duration;
      updateClipProperty(clip.id, side === "in" ? "fadeInSec" : "fadeOutSec", Math.max(0, Math.min(clip.duration, amount)));
    };
    setFade(event.clientX);
    const move = (next: MouseEvent) => setFade(next.clientX);
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }, [clip, track.locked, updateClipProperty]);
  const label = nest
    ? seqName || "Sequence"
    : sourceAsset?.name
      ? sourceAsset.name.length > 18
        ? `${sourceAsset.name.slice(0, 16)}…`
        : sourceAsset.name
      : clip.sourceMediaId
        ? "Media"
        : track.type === "adjustment"
          ? "Adjustment"
        : track.type === "text"
          ? "Text"
          : track.type === "null"
            ? "Null controller"
          : "Clip";

  return (
    <div
      className={`absolute top-1 bottom-1 rounded cursor-grab border shadow-xs transition-shadow ${colorClass} ${
        isSelected ? "ring-2 ring-blue-500 ring-offset-0 border-blue-400 z-10" : ""
      }`}
      style={{
        left: clip.startTime * zoom,
        width: Math.max(widthPx, 4),
      }}
      onMouseDown={(e) => handleMouseDown(e, "move")}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!nest || !clip.sourceSequenceId) return;
        const r = enterSequence(clip.sourceSequenceId);
        if (!r.ok) toast.error(r.message);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e, clip.id, track.id);
      }}
    >
      {/* Left trim handle */}
      <div
        className="absolute left-0 top-0 bottom-0 cursor-ew-resize z-20 hover:bg-white/10 rounded-l"
        style={{ width: TRIM_HANDLE_WIDTH }}
        onMouseDown={(e) => handleMouseDown(e, "trim-left")}
      />

      {/* Filmstrip / still preview for video & image clips */}
      {previewUrl && !waveformPeaks && (
        <div
          className="absolute inset-0 pointer-events-none opacity-50"
          style={{
            backgroundImage: `url(${previewUrl})`,
            backgroundSize: "auto 100%",
            backgroundRepeat: "repeat-x",
            backgroundPosition: "left center",
          }}
        />
      )}

      {/* Waveform canvas */}
      {waveformPeaks && (
        <canvas
          ref={waveformCanvasRef}
          width={Math.max(Math.round(widthPx), 4)}
          height={30}
          className="absolute inset-0 w-full h-full pointer-events-none"
        />
      )}

      {/* Clip-local volume envelope. Drag a dot; double-click the line to add one. */}
      {isSelected && isAudioBearing && widthPx >= 24 && (
        <svg
          className="absolute inset-x-1 inset-y-1 z-20 overflow-visible"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          onDoubleClick={(event) => {
            if (track.locked) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            updateVolumePoint(null, event.clientX, event.clientY, rect);
          }}
          aria-label="Clip volume automation"
        >
          <path d={envelopePath} fill="none" stroke="rgb(250 204 21)" strokeWidth="2" vectorEffect="non-scaling-stroke" className="drop-shadow" />
          {volumePoints.map((point, index) => (
            <circle
              key={point.id || `${point.time}-${index}`}
              cx={(point.time / Math.max(0.001, clip.duration)) * 100}
              cy={100 - (point.value / 2) * 100}
              r="3"
              fill="rgb(254 240 138)"
              stroke="rgb(133 77 14)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              className="cursor-ns-resize"
              onMouseDown={(event) => beginEnvelopeDrag(event, index)}
            />
          ))}
        </svg>
      )}

      {/* Premiere-style fade handles: drag from either edge to set the fade. */}
      {isSelected && isAudioBearing && widthPx >= 32 && (
        <>
          <button
            type="button"
            className="absolute top-0 z-30 h-2 w-2 -translate-x-1/2 rounded-full border border-yellow-200 bg-yellow-500 shadow cursor-ew-resize"
            style={{ left: `${((clip.fadeInSec ?? 0) / Math.max(0.001, clip.duration)) * 100}%` }}
            onMouseDown={(event) => beginFadeDrag(event, "in")}
            title={`Fade in ${(clip.fadeInSec ?? 0).toFixed(2)}s`}
            aria-label="Drag fade in handle"
          />
          <button
            type="button"
            className="absolute top-0 z-30 h-2 w-2 -translate-x-1/2 rounded-full border border-yellow-200 bg-yellow-500 shadow cursor-ew-resize"
            style={{ left: `${100 - ((clip.fadeOutSec ?? 0) / Math.max(0.001, clip.duration)) * 100}%` }}
            onMouseDown={(event) => beginFadeDrag(event, "out")}
            title={`Fade out ${(clip.fadeOutSec ?? 0).toFixed(2)}s`}
            aria-label="Drag fade out handle"
          />
        </>
      )}

      {/* Clip label */}
      <div className="absolute inset-0 flex items-center overflow-hidden px-2 bg-gradient-to-r from-black/40 via-transparent to-transparent">
        <span className="text-[10px] font-medium text-zinc-100 truncate pointer-events-none drop-shadow">
          {nest ? (
            <>
              <span className="text-teal-300 font-mono mr-1">SEQ</span>
              {label}
            </>
          ) : (
            <>
              {clip.parentId && <span className="text-cyan-300 font-mono mr-1">P</span>}
              {clip.trackMatte && <span className="text-amber-300 font-mono mr-1">{clip.trackMatte.type === "alpha" ? "α" : "Y"}</span>}
              {clip.linkGroupId && <span className="text-emerald-300 font-mono mr-1" title="Linked A/V">⛓</span>}
              {clip.lottieParams && <span className="text-pink-300 font-mono mr-1" title="Lottie animation">LOT</span>}
              {clip.textParams?.richTextRuns?.length && <span className="text-violet-300 font-mono mr-1" title="Rich text">RT</span>}
              {label}
            </>
          )}
        </span>
        {widthPx > 60 && (
          <span className="text-[9px] text-zinc-300 ml-1 font-mono pointer-events-none drop-shadow">
            {clip.duration.toFixed(1)}s
          </span>
        )}
      </div>

      {/* Keyframe diamond markers */}
      {clip.keyframes.length > 0 &&
        clip.keyframes.map((kf) => {
          const xPos = (kf.time / clip.duration) * widthPx;
          if (xPos < 0 || xPos > widthPx) return null;
          return (
            <div
              key={kf.id}
              className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rotate-45 bg-yellow-400 border border-yellow-600 z-10 pointer-events-none"
              style={{ left: xPos - 4 }}
            />
          );
        })}
      {clip.effects.flatMap((fx) =>
        (fx.keyframes || []).map((kf) => {
          const xPos = (kf.time / clip.duration) * widthPx;
          if (xPos < 0 || xPos > widthPx) return null;
          return (
            <div
              key={`${fx.id}-${kf.id}`}
              className="absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 rotate-45 bg-amber-600/70 border border-amber-800/80 z-10 pointer-events-none"
              style={{ left: xPos - 3 }}
              title={`${fx.name}.${kf.property}`}
            />
          );
        })
      )}

      {/* Right trim handle */}
      <div
        className="absolute right-0 top-0 bottom-0 cursor-ew-resize z-20 hover:bg-white/10 rounded-r"
        style={{ width: TRIM_HANDLE_WIDTH }}
        onMouseDown={(e) => handleMouseDown(e, "trim-right")}
      />
    </div>
  );
}
