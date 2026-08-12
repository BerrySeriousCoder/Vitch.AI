"use client";

interface PlayheadProps {
  currentTime: number;
  zoom: number;
  height: number;
}

export function Playhead({ currentTime, zoom, height }: PlayheadProps) {
  const left = currentTime * zoom;

  return (
    <div
      className="absolute top-0 z-30 pointer-events-none"
      style={{ left, height }}
    >
      {/* Marker head */}
      <div className="w-3 h-3 bg-red-500 rounded-full -translate-x-[5px] -translate-y-0.5 pointer-events-auto cursor-grab" />
      {/* Line */}
      <div className="w-px bg-red-500 absolute left-0 top-2" style={{ height: height - 8 }} />
    </div>
  );
}
