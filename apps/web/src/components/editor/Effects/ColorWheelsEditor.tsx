"use client";

import type { PointerEvent } from "react";
import type { Effect } from "@tempo/types";
import { useTimelineStore } from "@/stores/timeline.store";
import { resolveEffectParamsAtTime } from "@/lib/keyframes/interpolation";

type WheelId = "lift" | "gamma" | "gain";
type Channel = "Red" | "Green" | "Blue" | "Master";

interface WheelDefinition {
  id: WheelId;
  title: string;
  description: string;
}

const WHEELS: WheelDefinition[] = [
  { id: "lift", title: "Lift", description: "Shadow balance" },
  { id: "gamma", title: "Gamma", description: "Midtone balance" },
  { id: "gain", title: "Gain", description: "Highlight balance" },
];

const CHANNELS: Array<{ channel: Channel; className: string }> = [
  { channel: "Red", className: "accent-red-400" },
  { channel: "Green", className: "accent-emerald-400" },
  { channel: "Blue", className: "accent-blue-400" },
];

function paramKey(wheel: WheelId, channel: Channel): string {
  return `${wheel}${channel}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function ColorWheelsEditor({
  clipId,
  effect,
  timeInClip,
}: {
  clipId: string;
  effect: Effect;
  timeInClip: number;
}) {
  const updateEffectParam = useTimelineStore((state) => state.updateEffectParam);
  const addEffectKeyframe = useTimelineStore((state) => state.addEffectKeyframe);
  const removeEffectKeyframe = useTimelineStore((state) => state.removeEffectKeyframe);
  const resolved = resolveEffectParamsAtTime(effect, Math.max(0, timeInClip));

  const valueFor = (key: string) => Number(resolved[key] ?? effect.params[key] ?? 0);

  const setValues = (wheel: WheelId, updates: Record<string, number>) => {
    const keys = (["Red", "Green", "Blue", "Master"] as Channel[]).map((channel) =>
      paramKey(wheel, channel)
    );
    const hasKeyframes = (effect.keyframes || []).some((keyframe) => keys.includes(keyframe.property));
    for (const [key, value] of Object.entries(updates)) {
      if (hasKeyframes) {
        addEffectKeyframe(clipId, effect.id, key, Math.max(0, timeInClip), value);
      } else {
        updateEffectParam(clipId, effect.id, key, value);
      }
    }
  };

  const setWheelFromPointer = (wheel: WheelId, event: PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    let x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    let y = (0.5 - (event.clientY - rect.top) / rect.height) * 2;
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    // A zero-sum RGB offset gives the wheel a meaningful chroma direction;
    // the Master slider remains available for neutral brightness movement.
    const strength = 0.5;
    setValues(wheel, {
      [paramKey(wheel, "Red")]: clamp((x - y * 0.5) * strength, -1, 1),
      [paramKey(wheel, "Green")]: clamp(y * strength, -1, 1),
      [paramKey(wheel, "Blue")]: clamp((-x - y * 0.5) * strength, -1, 1),
    });
  };

  const wheelPosition = (wheel: WheelId) => {
    const red = valueFor(paramKey(wheel, "Red"));
    const green = valueFor(paramKey(wheel, "Green"));
    const blue = valueFor(paramKey(wheel, "Blue"));
    const neutral = (red + green + blue) / 3;
    const x = clamp(((red - neutral) - (blue - neutral)) / 1.5, -1, 1);
    const y = clamp((green - neutral) / 0.5, -1, 1);
    return { left: `${(x + 1) * 50}%`, top: `${(1 - y) * 50}%` };
  };

  return (
    <div className="space-y-3">
      <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">
        Balance shadows, midtones, and highlights independently. The wheel sets chroma; Master moves luminance.
      </p>
      {WHEELS.map((wheel) => {
        const keys = (["Red", "Green", "Blue", "Master"] as Channel[]).map((channel) =>
          paramKey(wheel.id, channel)
        );
        const keyframes = (effect.keyframes || []).filter((keyframe) => keys.includes(keyframe.property));
        const keyframesAtPlayhead = keyframes.filter(
          (keyframe) => Math.abs(keyframe.time - timeInClip) < 0.05
        );

        return (
          <section key={wheel.id} className="rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h4 className="text-[10px] font-medium text-[var(--text-primary)]">{wheel.title}</h4>
                <p className="text-[9px] text-[var(--text-muted)]">{wheel.description}</p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  title={keyframesAtPlayhead.length > 0 ? `Remove ${wheel.title} keyframe` : `Keyframe ${wheel.title}`}
                  onClick={() => {
                    if (keyframesAtPlayhead.length > 0) {
                      keyframesAtPlayhead.forEach((keyframe) =>
                        removeEffectKeyframe(clipId, effect.id, keyframe.id)
                      );
                      return;
                    }
                    keys.forEach((key) =>
                      addEffectKeyframe(clipId, effect.id, key, Math.max(0, timeInClip), valueFor(key))
                    );
                  }}
                  className={`flex h-4 w-4 items-center justify-center ${
                    keyframesAtPlayhead.length > 0 ? "text-yellow-400" : keyframes.length > 0 ? "text-yellow-700" : "text-zinc-600 hover:text-zinc-400"
                  }`}
                >
                  <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="currentColor"><path d="M5 0 L10 5 L5 10 L0 5 Z" /></svg>
                </button>
                <button
                  type="button"
                  title={`Reset ${wheel.title}`}
                  onClick={() => setValues(wheel.id, Object.fromEntries(keys.map((key) => [key, 0])))}
                  className="px-1 text-[9px] text-zinc-500 hover:text-zinc-200"
                >
                  Reset
                </button>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label={`${wheel.title} color wheel`}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setWheelFromPointer(wheel.id, event);
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) setWheelFromPointer(wheel.id, event);
                }}
                className="relative h-20 w-20 shrink-0 overflow-hidden rounded-full border border-white/20 shadow-inner"
                style={{ background: "conic-gradient(from 210deg, #ff4d4d, #f5dc4d, #52d273, #4cc9ff, #7b6dff, #f35aca, #ff4d4d)" }}
              >
                <span className="absolute inset-[17%] rounded-full bg-[var(--bg-secondary)]/70" />
                <span
                  className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-zinc-950 shadow"
                  style={wheelPosition(wheel.id)}
                />
              </button>

              <div className="min-w-0 flex-1 space-y-1">
                {CHANNELS.map(({ channel, className }) => {
                  const key = paramKey(wheel.id, channel);
                  const value = valueFor(key);
                  return (
                    <label key={key} className="flex items-center gap-1.5 text-[9px] text-[var(--text-muted)]">
                      <span className="w-3">{channel[0]}</span>
                      <input
                        type="range"
                        min={-1}
                        max={1}
                        step={0.01}
                        value={value}
                        onChange={(event) => setValues(wheel.id, { [key]: Number(event.target.value) })}
                        className={`min-w-0 flex-1 ${className}`}
                      />
                      <span className="w-9 text-right font-mono">{value.toFixed(2)}</span>
                    </label>
                  );
                })}
                {(() => {
                  const key = paramKey(wheel.id, "Master");
                  const value = valueFor(key);
                  return (
                    <label className="flex items-center gap-1.5 text-[9px] text-[var(--text-muted)]">
                      <span className="w-3">Y</span>
                      <input
                        type="range"
                        min={-1}
                        max={1}
                        step={0.01}
                        value={value}
                        onChange={(event) => setValues(wheel.id, { [key]: Number(event.target.value) })}
                        className="min-w-0 flex-1 accent-zinc-100"
                      />
                      <span className="w-9 text-right font-mono">{value.toFixed(2)}</span>
                    </label>
                  );
                })()}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
