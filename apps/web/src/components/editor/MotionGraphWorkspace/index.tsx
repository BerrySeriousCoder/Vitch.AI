"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { usePlaybackStore } from "@/stores/playback.store";
import { useSelectionStore } from "@/stores/selection.store";
import { useTimelineStore } from "@/stores/timeline.store";
import type { Clip, EasingType, Keyframe } from "@tempo/types";

const BASE_PROPERTIES = [
  "transform.x",
  "transform.y",
  "transform.scaleX",
  "transform.scaleY",
  "transform.rotation",
  "opacity",
];

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function findClip(tracks: ReturnType<typeof useTimelineStore.getState>["tracks"], id: string) {
  return tracks.flatMap((track) => track.clips).find((clip) => clip.id === id) ?? null;
}

function propertyValue(clip: Clip, property: string): number | string | boolean {
  switch (property) {
    case "transform.x": return clip.transform.x;
    case "transform.y": return clip.transform.y;
    case "transform.scaleX": return clip.transform.scaleX;
    case "transform.scaleY": return clip.transform.scaleY;
    case "transform.rotation": return clip.transform.rotation;
    case "opacity": return clip.opacity;
    default: return 0;
  }
}

function displayProperty(property: string) {
  const names: Record<string, string> = {
    "transform.x": "Position X",
    "transform.y": "Position Y",
    "transform.scaleX": "Scale X",
    "transform.scaleY": "Scale Y",
    "transform.rotation": "Rotation",
    opacity: "Opacity",
  };
  return names[property] ?? property;
}

function CurveEditor({
  keyframes,
  duration,
  activeId,
  onSelect,
  onUpdate,
}: {
  keyframes: Keyframe[];
  duration: number;
  activeId: string | null;
  onSelect: (keyframeId: string) => void;
  onUpdate: (keyframeId: string, patch: Pick<Keyframe, "time" | "value">) => void;
}) {
  const numeric = keyframes.filter((keyframe): keyframe is Keyframe & { value: number } => typeof keyframe.value === "number");
  const values = numeric.map((keyframe) => keyframe.value);
  const low = Math.min(...values, 0);
  const high = Math.max(...values, 1);
  const padding = Math.max(0.1, (high - low) * 0.12);
  const minValue = low - padding;
  const maxValue = high + padding;
  const range = Math.max(0.0001, maxValue - minValue);
  const toPoint = (keyframe: Keyframe & { value: number }) => ({
    x: 18 + (keyframe.time / Math.max(duration, 0.01)) * 264,
    y: 104 - ((keyframe.value - minValue) / range) * 88,
  });
  const path = numeric.map((keyframe) => {
    const point = toPoint(keyframe);
    return `${point.x},${point.y}`;
  }).join(" ");

  const startDrag = (event: React.PointerEvent<SVGCircleElement>, keyframe: Keyframe & { value: number }) => {
    event.preventDefault();
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const move = (moveEvent: PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      const x = clamp(((moveEvent.clientX - rect.left) / rect.width) * 300, 18, 282);
      const y = clamp(((moveEvent.clientY - rect.top) / rect.height) * 120, 16, 104);
      onUpdate(keyframe.id, {
        time: ((x - 18) / 264) * duration,
        value: minValue + ((104 - y) / 88) * range,
      });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };

  return (
    <div className="rounded border border-[var(--border-default)] bg-[var(--bg-primary)] p-1.5">
      <svg viewBox="0 0 300 120" className="h-32 w-full touch-none" aria-label="Editable animation curve">
        {[16, 38, 60, 82, 104].map((y) => <line key={y} x1="18" x2="282" y1={y} y2={y} stroke="rgba(113,113,122,0.25)" strokeWidth="0.6" />)}
        {[18, 84, 150, 216, 282].map((x) => <line key={x} x1={x} x2={x} y1="16" y2="104" stroke="rgba(113,113,122,0.2)" strokeWidth="0.6" />)}
        {path && <polyline points={path} fill="none" stroke="#67e8f9" strokeWidth="1.5" />}
        {numeric.map((keyframe) => {
          const point = toPoint(keyframe);
          return <circle key={keyframe.id} cx={point.x} cy={point.y} r={activeId === keyframe.id ? "4.1" : "3"} fill={activeId === keyframe.id ? "#fef08a" : "#164e63"} stroke={activeId === keyframe.id ? "#facc15" : "#a5f3fc"} strokeWidth="1" className="cursor-move" onClick={() => onSelect(keyframe.id)} onPointerDown={(event) => startDrag(event, keyframe)}><title>Drag to change timing and value</title></circle>;
        })}
        <text x="2" y="19" fill="#a1a1aa" fontSize="7">{maxValue.toFixed(2)}</text>
        <text x="2" y="106" fill="#a1a1aa" fontSize="7">{minValue.toFixed(2)}</text>
      </svg>
      <p className="px-1 text-[9px] text-[var(--text-muted)]">Drag points horizontally for timing or vertically for value.</p>
    </div>
  );
}

export function MotionGraphWorkspace() {
  const tracks = useTimelineStore((state) => state.tracks);
  const addKeyframe = useTimelineStore((state) => state.addKeyframe);
  const updateKeyframe = useTimelineStore((state) => state.updateKeyframe);
  const removeKeyframe = useTimelineStore((state) => state.removeKeyframe);
  const selectedClipIds = useSelectionStore((state) => state.selectedClipIds);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const [property, setProperty] = useState("transform.x");
  const [activeKeyframeId, setActiveKeyframeId] = useState<string | null>(null);
  const [motionClipboard, setMotionClipboard] = useState<Keyframe[]>([]);

  const selectedId = selectedClipIds.values().next().value as string | undefined;
  const clip = selectedId ? findClip(tracks, selectedId) : null;
  const localTime = clip ? clamp(currentTime - clip.startTime, 0, clip.duration) : 0;
  const properties = [...new Set([...BASE_PROPERTIES, ...(clip?.keyframes.map((keyframe) => keyframe.property) ?? [])])];
  const keyframes = clip?.keyframes.filter((keyframe) => keyframe.property === property).sort((a, b) => a.time - b.time) ?? [];
  const activeKeyframe = keyframes.find((keyframe) => keyframe.id === activeKeyframeId) ?? null;

  const addAtPlayhead = () => {
    if (!clip) return;
    addKeyframe(clip.id, property, localTime, propertyValue(clip, property));
    const created = findClip(useTimelineStore.getState().tracks, clip.id)?.keyframes.find((keyframe) => keyframe.property === property && Math.abs(keyframe.time - localTime) < 0.001);
    if (created) setActiveKeyframeId(created.id);
  };

  const copyAnimation = () => {
    if (!clip || clip.keyframes.length === 0) return toast.error("This layer has no layer keyframes to copy");
    const copied = clip.keyframes.map((keyframe) => ({ ...keyframe, bezierHandles: keyframe.bezierHandles ? [...keyframe.bezierHandles] as Keyframe["bezierHandles"] : undefined }));
    setMotionClipboard(copied);
    toast.success(`Copied ${copied.length} layer keyframes`);
  };

  const pasteAnimation = () => {
    if (!clip || !motionClipboard.length) return toast.error("Copy a layer animation first");
    const targets = [...selectedClipIds].filter((id) => id !== clip.id).map((id) => findClip(useTimelineStore.getState().tracks, id)).filter((candidate): candidate is Clip => Boolean(candidate));
    if (!targets.length) return toast.error("Shift-select target layers, keeping the source layer selected first");
    for (const target of targets) {
      for (const frame of motionClipboard) {
        const scaledTime = (frame.time / Math.max(clip.duration, 0.01)) * target.duration;
        addKeyframe(target.id, frame.property, scaledTime, frame.value, frame.easing);
        const inserted = findClip(useTimelineStore.getState().tracks, target.id)?.keyframes.find((keyframe) => keyframe.property === frame.property && Math.abs(keyframe.time - scaledTime) < 0.001);
        if (inserted) updateKeyframe(target.id, inserted.id, { bezierHandles: frame.bezierHandles });
      }
    }
    toast.success(`Pasted animation onto ${targets.length} layer${targets.length === 1 ? "" : "s"}`);
  };

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg-secondary)] text-[var(--text-primary)]">
      <div className="border-b border-[var(--border-default)] px-3 py-3"><h2 className="text-xs font-semibold">Motion Graph</h2><p className="mt-0.5 text-[10px] leading-relaxed text-[var(--text-muted)]">Edit the selected layer’s timing and values. Motion paths appear in Preview while this panel is open.</p></div>
      {!clip ? <div className="p-3"><p className="rounded border border-dashed border-[var(--border-default)] px-2 py-3 text-center text-[10px] leading-relaxed text-[var(--text-muted)]">Select a visual layer in the timeline to animate it.</p></div> : <>
        <section className="border-b border-[var(--border-default)] p-3 space-y-2"><div className="flex items-center justify-between"><div><p className="text-[11px] font-medium">Layer animation</p><p className="text-[10px] text-[var(--text-muted)]">Playhead {localTime.toFixed(2)}s / {clip.duration.toFixed(2)}s</p></div><button type="button" onClick={addAtPlayhead} className="rounded bg-cyan-200 px-2 py-1 text-[10px] font-semibold text-cyan-950 hover:bg-cyan-100">+ Keyframe</button></div><select value={property} onChange={(event) => { setProperty(event.target.value); setActiveKeyframeId(null); }} className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1.5 py-1 text-[10px] text-[var(--text-primary)]">{properties.map((key) => <option key={key} value={key}>{displayProperty(key)}</option>)}</select>{keyframes.length === 0 ? <p className="rounded border border-dashed border-[var(--border-default)] px-2 py-3 text-center text-[10px] text-[var(--text-muted)]">Add a keyframe at the playhead to start this curve.</p> : <CurveEditor keyframes={keyframes} duration={clip.duration} activeId={activeKeyframeId} onSelect={setActiveKeyframeId} onUpdate={(keyframeId, patch) => updateKeyframe(clip.id, keyframeId, patch)} />}</section>
        {activeKeyframe && <section className="border-b border-[var(--border-default)] p-3 space-y-2"><div className="flex items-center justify-between"><h3 className="text-[11px] font-semibold">Selected keyframe</h3><button type="button" onClick={() => { removeKeyframe(clip.id, activeKeyframe.id); setActiveKeyframeId(null); }} className="text-[10px] text-rose-300 hover:text-rose-100">Delete</button></div><div className="grid grid-cols-2 gap-1.5"><label className="text-[10px] text-[var(--text-muted)]">Time<input type="number" min={0} max={clip.duration} step={0.01} value={activeKeyframe.time} onChange={(event) => updateKeyframe(clip.id, activeKeyframe.id, { time: clamp(Number(event.target.value), 0, clip.duration) })} className="mt-0.5 w-full rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1 py-0.5 text-[10px]" /></label><label className="text-[10px] text-[var(--text-muted)]">Value<input type="number" step={0.01} value={typeof activeKeyframe.value === "number" ? activeKeyframe.value : 0} onChange={(event) => updateKeyframe(clip.id, activeKeyframe.id, { value: Number(event.target.value) })} className="mt-0.5 w-full rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1 py-0.5 text-[10px]" /></label></div><label className="block text-[10px] text-[var(--text-muted)]">Incoming interpolation<select value={activeKeyframe.easing} onChange={(event) => updateKeyframe(clip.id, activeKeyframe.id, { easing: event.target.value as EasingType, bezierHandles: event.target.value === "cubic-bezier" ? activeKeyframe.bezierHandles ?? [0.25, 0.1, 0.25, 1] : undefined })} className="mt-0.5 w-full rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1 py-1 text-[10px]"><option value="hold">Hold / step</option><option value="linear">Linear</option><option value="ease-in">Ease in</option><option value="ease-out">Ease out</option><option value="ease-in-out">Ease in/out</option><option value="cubic-bezier">Cubic Bézier</option></select></label>{activeKeyframe.easing === "cubic-bezier" && <div className="grid grid-cols-4 gap-1">{(["x1", "y1", "x2", "y2"] as const).map((label, index) => <label key={label} className="text-[9px] text-[var(--text-muted)]">{label}<input type="number" min={index === 0 || index === 2 ? 0 : -2} max={index === 0 || index === 2 ? 1 : 3} step={0.01} value={activeKeyframe.bezierHandles?.[index] ?? [0.25, 0.1, 0.25, 1][index]} onChange={(event) => { const handles = [...(activeKeyframe.bezierHandles ?? [0.25, 0.1, 0.25, 1])] as [number, number, number, number]; handles[index] = Number(event.target.value); updateKeyframe(clip.id, activeKeyframe.id, { bezierHandles: handles }); }} className="mt-0.5 w-full rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1 py-0.5 text-[9px]" /></label>)}</div>}<p className="text-[9px] leading-relaxed text-[var(--text-muted)]">Interpolation belongs to this incoming keyframe—the segment before it uses this curve.</p></section>}
        <section className="p-3 space-y-1.5"><div className="flex items-center justify-between"><h3 className="text-[11px] font-semibold">Animation clipboard</h3><span className="text-[9px] text-[var(--text-muted)]">{motionClipboard.length} keys</span></div><button type="button" onClick={copyAnimation} className="w-full rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-200 hover:bg-zinc-800">Copy this layer’s keyframes</button><button type="button" onClick={pasteAnimation} className="w-full rounded border border-cyan-900/70 bg-cyan-950/20 px-2 py-1 text-[10px] text-cyan-100 hover:bg-cyan-900/35">Paste to other selected layers</button><p className="text-[9px] leading-relaxed text-[var(--text-muted)]">Paste scales keyframe timing to each target’s duration and preserves Bézier handles.</p></section>
      </>}
    </div>
  );
}
