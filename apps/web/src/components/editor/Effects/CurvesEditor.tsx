"use client";

import { useRef } from "react";
import { createDefaultCurve, normalizeCurvePoints } from "@tempo/editor-core";
import type { CurvePoint } from "@tempo/types";

const WIDTH = 176;
const HEIGHT = 96;
const PADDING = 8;

const CHANNEL_COLOR: Record<string, string> = {
  Luma: "#e5e7eb",
  Red: "#fb7185",
  Green: "#4ade80",
  Blue: "#60a5fa",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function svgPoint(point: CurvePoint): [number, number] {
  return [
    PADDING + point.x * (WIDTH - PADDING * 2),
    HEIGHT - PADDING - point.y * (HEIGHT - PADDING * 2),
  ];
}

function pointFromPointer(
  event: React.PointerEvent<SVGSVGElement>
): CurvePoint {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left - PADDING) / (rect.width - PADDING * 2), 0, 1),
    y: clamp(1 - (event.clientY - rect.top - PADDING) / (rect.height - PADDING * 2), 0, 1),
  };
}

/** Dedicated interaction surface for non-keyframeable RGB/luma curve data. */
export function CurvesEditor({
  label,
  points,
  onChange,
}: {
  label: string;
  points: readonly CurvePoint[];
  onChange: (points: CurvePoint[]) => void;
}) {
  const draggingIndex = useRef<number | null>(null);
  const curve = normalizeCurvePoints(points);
  const color = CHANNEL_COLOR[label] || "#e5e7eb";
  const svgPoints = curve.map(svgPoint);

  const updatePoint = (index: number, point: CurvePoint) => {
    const previous = curve[index - 1];
    const next = curve[index + 1];
    const x =
      index === 0
        ? 0
        : index === curve.length - 1
          ? 1
          : clamp(point.x, previous!.x + 0.01, next!.x - 0.01);
    onChange(curve.map((current, currentIndex) =>
      currentIndex === index ? { x, y: point.y } : current
    ));
  };

  return (
    <div className="space-y-1 rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] p-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-[var(--text-muted)]">{label}</span>
        <button
          type="button"
          onClick={() => onChange(createDefaultCurve())}
          className="text-[9px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          Reset
        </button>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full touch-none rounded bg-[#0a0a0a]"
        onPointerDown={(event) => {
          const [cursorX, cursorY] = svgPoint(pointFromPointer(event));
          const hitIndex = svgPoints.findIndex(([x, y]) => Math.hypot(x - cursorX, y - cursorY) < 10);
          if (hitIndex >= 0) {
            draggingIndex.current = hitIndex;
          } else if (curve.length < 8) {
            const candidate = pointFromPointer(event);
            const next = normalizeCurvePoints([...curve, candidate]);
            onChange(next);
            draggingIndex.current = next.findIndex(
              (point) => Math.abs(point.x - candidate.x) < 0.001 && Math.abs(point.y - candidate.y) < 0.001
            );
          }
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (draggingIndex.current == null) return;
          updatePoint(draggingIndex.current, pointFromPointer(event));
        }}
        onPointerUp={(event) => {
          draggingIndex.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          draggingIndex.current = null;
        }}
        aria-label={`${label} curve editor`}
        role="img"
      >
        {[0.25, 0.5, 0.75].map((ratio) => (
          <g key={ratio} stroke="#27272a" strokeWidth="1">
            <line x1={PADDING} y1={PADDING + ratio * (HEIGHT - PADDING * 2)} x2={WIDTH - PADDING} y2={PADDING + ratio * (HEIGHT - PADDING * 2)} />
            <line x1={PADDING + ratio * (WIDTH - PADDING * 2)} y1={PADDING} x2={PADDING + ratio * (WIDTH - PADDING * 2)} y2={HEIGHT - PADDING} />
          </g>
        ))}
        <line x1={PADDING} y1={HEIGHT - PADDING} x2={WIDTH - PADDING} y2={PADDING} stroke="#3f3f46" strokeDasharray="3 3" />
        <polyline fill="none" stroke={color} strokeWidth="2" points={svgPoints.map(([x, y]) => `${x},${y}`).join(" ")} />
        {svgPoints.map(([x, y], index) => (
          <circle key={`${curve[index]!.x}-${index}`} cx={x} cy={y} r="3.5" fill={color} stroke="#111827" strokeWidth="1.5" />
        ))}
      </svg>
      <p className="text-[9px] leading-3 text-[var(--text-muted)]">Click to add a point; drag points to shape the curve.</p>
    </div>
  );
}
