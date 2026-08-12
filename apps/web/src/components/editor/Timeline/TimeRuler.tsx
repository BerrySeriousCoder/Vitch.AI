"use client";

import { useCallback, useRef } from "react";
import { usePlaybackStore } from "@/stores/playback.store";

interface TimeRulerProps {
  zoom: number;
  scrollLeft: number;
  width: number;
  containerWidth: number;
  markers?: Array<{ id: string; time: number; label: string; color: string }>;
  onAddMarker?: (time: number) => void;
  onRemoveMarker?: (id: string) => void;
  onSelectMarker?: (id: string) => void;
  selectedMarkerId?: string | null;
}

function formatTimeRuler(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getMarkerInterval(zoom: number): number {
  if (zoom < 20) return 10;
  if (zoom < 40) return 5;
  if (zoom < 80) return 1;
  if (zoom < 150) return 0.5;
  return 0.25;
}

export function TimeRuler({ zoom, scrollLeft, width, containerWidth, markers: timelineMarkers = [], onAddMarker, onRemoveMarker, onSelectMarker, selectedMarkerId }: TimeRulerProps) {
  const isDragging = useRef(false);

  const posToTime = useCallback(
    (clientX: number, rect: DOMRect) => {
      return Math.max(0, (clientX - rect.left + scrollLeft) / zoom);
    },
    [zoom, scrollLeft]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const time = posToTime(e.clientX, rect);
      if (e.shiftKey) { onAddMarker?.(time); return; }
      usePlaybackStore.getState().seek(time);
      isDragging.current = true;

      const handleMouseMove = (e: MouseEvent) => {
        if (!isDragging.current) return;
        const t = posToTime(e.clientX, rect);
        usePlaybackStore.getState().seek(t);
      };

      const handleMouseUp = () => {
        isDragging.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [posToTime, onAddMarker]
  );

  const interval = getMarkerInterval(zoom);
  const visibleStart = Math.floor(scrollLeft / zoom / interval) * interval;
  const visibleEnd = (scrollLeft + containerWidth) / zoom + interval;

  const markers: { time: number; isMajor: boolean }[] = [];
  for (let t = visibleStart; t <= visibleEnd; t += interval) {
    const time = Math.round(t * 1000) / 1000;
    const isMajor = interval >= 1 ? time % 5 === 0 : time % 1 === 0;
    markers.push({ time, isMajor });
  }

  return (
    <div
      className="h-6 bg-[var(--bg-tertiary)] border-b border-[var(--border-default)] relative cursor-pointer select-none"
      style={{ width }}
      onMouseDown={handleMouseDown}
    >
      {markers.map(({ time, isMajor }) => (
        <div
          key={time}
          className="absolute top-0 h-full flex flex-col justify-end"
          style={{ left: time * zoom }}
        >
          <div
            className={`w-px ${isMajor ? "h-3 bg-zinc-600" : "h-2 bg-zinc-700"}`}
          />
          {isMajor && (
            <span className="text-[9px] font-mono text-[var(--text-muted)] ml-1 absolute top-0.5 whitespace-nowrap">
              {formatTimeRuler(time)}
            </span>
          )}
        </div>
      ))}
      {timelineMarkers.map((marker) => (
        <button
          key={marker.id}
          type="button"
          title={`${marker.label} · right click to remove`}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            usePlaybackStore.getState().seek(marker.time);
            onSelectMarker?.(marker.id);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemoveMarker?.(marker.id);
          }}
          className={`absolute top-0 h-full w-px ${selectedMarkerId === marker.id ? "z-10 ring-1 ring-white/80" : ""}`}
          style={{ left: marker.time * zoom, backgroundColor: marker.color }}
        >
          <span className="absolute left-0 top-0.5 ml-1 max-w-16 truncate text-[8px] text-amber-300">
            {marker.label}
          </span>
        </button>
      ))}
    </div>
  );
}
