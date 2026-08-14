"use client";

import { useCallback, useMemo } from "react";
import { usePlaybackStore } from "@/stores/playback.store";
import { useProjectStore } from "@/stores/project.store";
import { useSelectionStore } from "@/stores/selection.store";
import { useTimelineStore } from "@/stores/timeline.store";
import { useUIStore } from "@/stores/ui.store";
import {
  normalizeMotionTrack,
  normalizePlanarTrack,
  resolveMotionTrackAtTime,
  resolvePlanarTrackAtTime,
} from "@tempo/editor-core";
import type { Clip, Mask, MotionTrackSample, PlanarTrackPoint } from "@tempo/types";

const SAMPLE_EPSILON = 1 / 60;

function findClip(tracks: ReturnType<typeof useTimelineStore.getState>["tracks"], id: string) {
  return tracks.flatMap((track) => track.clips).find((clip) => clip.id === id) ?? null;
}

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function upsertMotionSample(samples: MotionTrackSample[], time: number, next: MotionTrackSample) {
  const nearest = samples.reduce((best, sample, index) =>
    Math.abs(sample.time - time) < Math.abs(samples[best]!.time - time) ? index : best, 0);
  if (samples.length && Math.abs(samples[nearest]!.time - time) <= SAMPLE_EPSILON) {
    return samples.map((sample, index) => index === nearest ? { ...sample, ...next, time: samples[nearest]!.time } : sample);
  }
  return [...samples, { ...next, time }].sort((a, b) => a.time - b.time);
}

function upsertPlanarSample(
  samples: NonNullable<Clip["planarTrack"]>["samples"],
  time: number,
  corners: [PlanarTrackPoint, PlanarTrackPoint, PlanarTrackPoint, PlanarTrackPoint]
) {
  const nearest = samples.reduce((best, sample, index) =>
    Math.abs(sample.time - time) < Math.abs(samples[best]!.time - time) ? index : best, 0);
  if (samples.length && Math.abs(samples[nearest]!.time - time) <= SAMPLE_EPSILON) {
    return samples.map((sample, index) => index === nearest ? { ...sample, corners } : sample);
  }
  return [...samples, { time, corners, confidence: 1 }].sort((a, b) => a.time - b.time);
}

export function TrackingOverlay() {
  const trackingVisible = useUIStore((state) => state.panels.tracking);
  const tracks = useTimelineStore((state) => state.tracks);
  const selectedClipIds = useSelectionStore((state) => state.selectedClipIds);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const fps = useProjectStore((state) => state.settings.fps);
  const updateClipProperty = useTimelineStore((state) => state.updateClipProperty);

  const selectedClip = useMemo(() => {
    const first = selectedClipIds.values().next().value as string | undefined;
    return first ? findClip(tracks, first) : null;
  }, [selectedClipIds, tracks]);
  const clip = selectedClip?.motionTrack || selectedClip?.planarTrack || selectedClip?.trackMatte ? selectedClip : null;
  const localTime = clip ? clamp(currentTime - clip.startTime, 0, clip.duration) : 0;
  const motion = clip?.motionTrack ? resolveMotionTrackAtTime(clip.motionTrack, localTime) : null;
  const planar = clip?.planarTrack ? resolvePlanarTrackAtTime(clip.planarTrack, localTime) : null;

  const beginDrag = useCallback((event: React.PointerEvent<SVGElement>, onMove: (point: { x: number; y: number }) => void) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const move = (moveEvent: PointerEvent) => {
      const rect = target.ownerSVGElement?.getBoundingClientRect() ?? target.getBoundingClientRect();
      onMove({ x: clamp((moveEvent.clientX - rect.left) / rect.width), y: clamp((moveEvent.clientY - rect.top) / rect.height) });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  }, []);

  const updateMotionPoint = useCallback((point: { x: number; y: number }) => {
    if (!clip?.motionTrack || !motion) return;
    const normalized = normalizeMotionTrack({
      ...clip.motionTrack,
      samples: upsertMotionSample(clip.motionTrack.samples, localTime, {
        time: localTime,
        x: point.x,
        y: point.y,
        scale: motion.scale,
        rotation: motion.rotation,
        confidence: motion.confidence,
      }),
    });
    if (normalized) updateClipProperty(clip.id, "motionTrack", normalized);
  }, [clip, localTime, motion, updateClipProperty]);

  const updatePlanarCorner = useCallback((cornerIndex: number, point: { x: number; y: number }) => {
    if (!clip?.planarTrack || !planar) return;
    const corners = planar.corners.map((corner, index) => index === cornerIndex ? point : corner) as [PlanarTrackPoint, PlanarTrackPoint, PlanarTrackPoint, PlanarTrackPoint];
    const normalized = normalizePlanarTrack({
      ...clip.planarTrack,
      samples: upsertPlanarSample(clip.planarTrack.samples, localTime, corners),
    });
    if (normalized) updateClipProperty(clip.id, "planarTrack", normalized);
  }, [clip, localTime, planar, updateClipProperty]);

  const moveRotoRegion = useCallback((property: "garbageMask" | "holdoutMask", point: { x: number; y: number }) => {
    if (!clip?.trackMatte) return;
    const region = clip.trackMatte[property];
    if (!region) return;
    const next: Mask = {
      ...region,
      x: clamp(point.x - region.width / 2, 0, 1 - region.width),
      y: clamp(point.y - region.height / 2, 0, 1 - region.height),
    };
    updateClipProperty(clip.id, "trackMatte", { ...clip.trackMatte, [property]: next });
  }, [clip, updateClipProperty]);

  if (!trackingVisible || !clip || (!motion && !planar && !clip.trackMatte)) return null;

  const trackPath = clip.motionTrack?.samples.map((sample) => `${sample.x * 100},${sample.y * 100}`).join(" ");
  const regions = (["garbageMask", "holdoutMask"] as const).map((property) => ({ property, region: clip.trackMatte?.[property] })).filter((entry): entry is { property: "garbageMask" | "holdoutMask"; region: Mask } => Boolean(entry.region));

  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 z-20 h-full w-full touch-none" aria-label="Tracking and roto overlay">
      {trackPath && <polyline points={trackPath} fill="none" stroke="rgba(34, 211, 238, 0.75)" strokeWidth="0.35" strokeDasharray="0.9 0.9" vectorEffect="non-scaling-stroke" />}
      {motion && <>
        <line x1={motion.x * 100 - 2} y1={motion.y * 100} x2={motion.x * 100 + 2} y2={motion.y * 100} stroke="#67e8f9" strokeWidth="0.45" vectorEffect="non-scaling-stroke" />
        <line x1={motion.x * 100} y1={motion.y * 100 - 2} x2={motion.x * 100} y2={motion.y * 100 + 2} stroke="#67e8f9" strokeWidth="0.45" vectorEffect="non-scaling-stroke" />
        <circle cx={motion.x * 100} cy={motion.y * 100} r="1.25" fill="#083344" stroke="#a5f3fc" strokeWidth="0.45" vectorEffect="non-scaling-stroke" className="cursor-move" onPointerDown={(event) => beginDrag(event, updateMotionPoint)}>
          <title>Drag to correct the tracker at this frame</title>
        </circle>
      </>}
      {planar && <>
        <polygon points={planar.corners.map((corner) => `${corner.x * 100},${corner.y * 100}`).join(" ")} fill="rgba(251, 191, 36, 0.1)" stroke="#fbbf24" strokeWidth="0.45" vectorEffect="non-scaling-stroke" />
        {planar.corners.map((corner, index) => <circle key={index} cx={corner.x * 100} cy={corner.y * 100} r="1.1" fill="#451a03" stroke="#fde68a" strokeWidth="0.45" vectorEffect="non-scaling-stroke" className="cursor-move" onPointerDown={(event) => beginDrag(event, (point) => updatePlanarCorner(index, point))}><title>Drag corner {index + 1} to correct this planar track</title></circle>)}
      </>}
      {regions.map(({ property, region }) => <rect key={property} x={region.x * 100} y={region.y * 100} width={region.width * 100} height={region.height * 100} rx="0.8" fill={property === "garbageMask" ? "rgba(34, 197, 94, 0.12)" : "rgba(244, 63, 94, 0.12)"} stroke={property === "garbageMask" ? "#4ade80" : "#fb7185"} strokeWidth="0.35" strokeDasharray="1 0.7" vectorEffect="non-scaling-stroke" className="cursor-move" onPointerDown={(event) => beginDrag(event, (point) => moveRotoRegion(property, point))}><title>Drag {property === "garbageMask" ? "garbage" : "holdout"} region</title></rect>)}
      <text x="2" y="6" fill="#e4e4e7" fontSize="3.2" className="pointer-events-none">{clip.motionTrack?.subject || clip.planarTrack?.surface || "Matte cleanup"} · {Math.round((motion?.confidence ?? planar?.confidence ?? 1) * 100)}%</text>
      <text x="2" y="10" fill="#a1a1aa" fontSize="2.4" className="pointer-events-none">Frame {Math.round(localTime * fps) + 1} · drag handles to correct</text>
    </svg>
  );
}
