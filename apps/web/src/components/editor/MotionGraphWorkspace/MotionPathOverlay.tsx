"use client";

import { useCallback, useMemo } from "react";
import { interpolateValue } from "@tempo/editor-core";
import { usePlaybackStore } from "@/stores/playback.store";
import { useProjectStore } from "@/stores/project.store";
import { useSelectionStore } from "@/stores/selection.store";
import { useTimelineStore } from "@/stores/timeline.store";
import { useUIStore } from "@/stores/ui.store";

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function MotionPathOverlay() {
  const visible = useUIStore((state) => state.panels.motionGraph);
  const tracks = useTimelineStore((state) => state.tracks);
  const selectedClipIds = useSelectionStore((state) => state.selectedClipIds);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const settings = useProjectStore((state) => state.settings);
  const addKeyframe = useTimelineStore((state) => state.addKeyframe);

  const clip = useMemo(() => {
    const id = selectedClipIds.values().next().value as string | undefined;
    return id ? tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === id) ?? null : null;
  }, [tracks, selectedClipIds]);
  const localTime = clip ? clamp(currentTime - clip.startTime, 0, clip.duration) : 0;
  const xKeys = clip?.keyframes.filter((keyframe) => keyframe.property === "transform.x") ?? [];
  const yKeys = clip?.keyframes.filter((keyframe) => keyframe.property === "transform.y") ?? [];
  const times = [...new Set([...xKeys, ...yKeys].map((keyframe) => keyframe.time))].sort((a, b) => a - b);
  const resolvedX = clip ? Number(interpolateValue(clip.keyframes, localTime, "transform.x") ?? clip.transform.x) : 0;
  const resolvedY = clip ? Number(interpolateValue(clip.keyframes, localTime, "transform.y") ?? clip.transform.y) : 0;

  const points = clip ? times.map((time) => ({
    x: Number(interpolateValue(clip.keyframes, time, "transform.x") ?? clip.transform.x),
    y: Number(interpolateValue(clip.keyframes, time, "transform.y") ?? clip.transform.y),
  })) : [];

  const dragTarget = useCallback((event: React.PointerEvent<SVGCircleElement>) => {
    if (!clip) return;
    event.preventDefault();
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const move = (moveEvent: PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      const x = clamp(((moveEvent.clientX - rect.left) / rect.width) * settings.width, 0, settings.width);
      const y = clamp(((moveEvent.clientY - rect.top) / rect.height) * settings.height, 0, settings.height);
      addKeyframe(clip.id, "transform.x", localTime, x);
      addKeyframe(clip.id, "transform.y", localTime, y);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  }, [clip, localTime, settings.width, settings.height, addKeyframe]);

  if (!visible || !clip || (!xKeys.length && !yKeys.length)) return null;

  return (
    <svg viewBox={`0 0 ${settings.width} ${settings.height}`} className="absolute inset-0 z-[19] h-full w-full touch-none" aria-label="Motion path overlay">
      {points.length > 1 && <polyline points={points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke="rgba(74, 222, 128, 0.85)" strokeWidth="3" strokeDasharray="8 6" vectorEffect="non-scaling-stroke" />}
      {points.map((point, index) => <circle key={`${point.x}-${point.y}-${index}`} cx={point.x} cy={point.y} r="7" fill="#14532d" stroke="#bbf7d0" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
      <circle cx={resolvedX} cy={resolvedY} r="11" fill="#052e16" stroke="#86efac" strokeWidth="3" vectorEffect="non-scaling-stroke" className="cursor-move" onPointerDown={dragTarget}><title>Drag to add position keyframes at the current frame</title></circle>
      <line x1={resolvedX - 16} y1={resolvedY} x2={resolvedX + 16} y2={resolvedY} stroke="#dcfce7" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <line x1={resolvedX} y1={resolvedY - 16} x2={resolvedX} y2={resolvedY + 16} stroke="#dcfce7" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
