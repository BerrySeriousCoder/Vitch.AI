"use client";

import { useState } from "react";
import { getEffectDefinition } from "@/lib/effects/registry";
import { useTimelineStore } from "@/stores/timeline.store";
import { usePlaybackStore } from "@/stores/playback.store";
import { useLutsStore } from "@/stores/luts.store";
import { listBuiltinLutEntries } from "@/lib/luts";
import { interpolateValue, resolveEffectParamsAtTime } from "@/lib/keyframes/interpolation";
import type { Effect } from "@tempo/types";
import { CurvesEditor } from "./CurvesEditor";
import { ColorWheelsEditor } from "./ColorWheelsEditor";

interface EffectParamsProps {
  clipId: string;
  effect: Effect;
}

function ParamSparkline({
  effect,
  paramKey,
  duration,
  min,
  max,
}: {
  effect: Effect;
  paramKey: string;
  duration: number;
  min: number;
  max: number;
}) {
  const kfs = (effect.keyframes || []).filter((k) => k.property === paramKey);
  if (kfs.length < 1 || duration <= 0) return null;

  const w = 120;
  const h = 22;
  const samples = 24;
  const span = Math.max(1e-6, max - min);
  const points: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * duration;
    const raw =
      (interpolateValue(effect.keyframes || [], t, paramKey) as number | undefined) ??
      (Number(effect.params[paramKey]) || min);
    const yNorm = 1 - (Math.max(min, Math.min(max, Number(raw))) - min) / span;
    const x = (i / samples) * w;
    const y = 2 + yNorm * (h - 4);
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }

  return (
    <svg
      width={w}
      height={h}
      className="mt-0.5 text-amber-500/80"
      aria-hidden
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        points={points.join(" ")}
      />
    </svg>
  );
}

export function EffectParams({ clipId, effect }: EffectParamsProps) {
  const updateEffectParam = useTimelineStore((s) => s.updateEffectParam);
  const removeEffect = useTimelineStore((s) => s.removeEffect);
  const setEffectEnabled = useTimelineStore((s) => s.setEffectEnabled);
  const reorderEffects = useTimelineStore((s) => s.reorderEffects);
  const addEffectKeyframe = useTimelineStore((s) => s.addEffectKeyframe);
  const removeEffectKeyframe = useTimelineStore((s) => s.removeEffectKeyframe);
  const tracks = useTimelineStore((s) => s.tracks);
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const projectLuts = useLutsStore((s) => s.luts);
  const [focusedParam, setFocusedParam] = useState<string | null>(null);

  const clip = tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  const timeInClip = clip ? currentTime - clip.startTime : 0;
  const effectIndex = clip?.effects.findIndex((candidate) => candidate.id === effect.id) ?? -1;
  const moveEffect = (delta: number) => {
    if (!clip || effectIndex < 0) return;
    const to = effectIndex + delta;
    if (to < 0 || to >= clip.effects.length) return;
    const ids = clip.effects.map((candidate) => candidate.id);
    [ids[effectIndex], ids[to]] = [ids[to]!, ids[effectIndex]!];
    reorderEffects(clipId, ids);
  };

  const def = getEffectDefinition(effect.type);
  if (!def) {
    return (
      <div className="px-3 py-2 text-[11px] text-[var(--text-muted)]">
        Unknown effect type: {effect.type}
      </div>
    );
  }

  const lutOptions = [
    ...listBuiltinLutEntries(),
    ...projectLuts.map((l) => ({ id: l.id, name: l.name })),
  ];

  return (
    <div className="border border-[var(--border-default)] rounded bg-[var(--bg-primary)] overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1.5 bg-[var(--bg-tertiary)]">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEffectEnabled(clipId, effect.id, !effect.enabled)}
            className={`w-3 h-3 rounded-sm border ${
              effect.enabled
                ? "bg-blue-500 border-blue-400"
                : "bg-zinc-800 border-zinc-600"
            }`}
          />
          <span className="text-[11px] font-medium text-[var(--text-primary)]">
            {effect.name}
          </span>
        </div>
        <button
          onClick={() => removeEffect(clipId, effect.id)}
          className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors"
        >
          ×
        </button>
        <div className="flex items-center gap-1">
          <button onClick={() => moveEffect(-1)} disabled={effectIndex <= 0} className="text-[10px] text-zinc-500 hover:text-zinc-200 disabled:opacity-30" title="Move effect earlier in stack">↑</button>
          <button onClick={() => moveEffect(1)} disabled={!clip || effectIndex === clip.effects.length - 1} className="text-[10px] text-zinc-500 hover:text-zinc-200 disabled:opacity-30" title="Move effect later in stack">↓</button>
        </div>
      </div>

      {effect.enabled && (
        <div className="p-2 space-y-2">
          {effect.type === "lift-gamma-gain" ? (
            <ColorWheelsEditor clipId={clipId} effect={effect} timeInClip={timeInClip} />
          ) : Object.entries(def.params).map(([paramKey, paramDef]) => {
            const keyframeable =
              paramDef.keyframeable !== false && paramDef.type === "number";
            const kfs = (effect.keyframes || []).filter(
              (k) => k.property === paramKey
            );
            const existingKf = kfs.find(
              (k) => Math.abs(k.time - timeInClip) < 0.05
            );
            const resolved = resolveEffectParamsAtTime(
              effect,
              Math.max(0, timeInClip)
            );
            const currentValue =
              resolved[paramKey] ??
              effect.params[paramKey] ??
              paramDef.defaultValue;

            if (paramDef.type === "curve") {
              return (
                <CurvesEditor
                  key={paramKey}
                  label={paramDef.label}
                  points={Array.isArray(currentValue) ? currentValue : []}
                  onChange={(points) =>
                    updateEffectParam(clipId, effect.id, paramKey, points)
                  }
                />
              );
            }

            const setNumberParam = (next: number) => {
              if (keyframeable && kfs.length > 0) {
                addEffectKeyframe(
                  clipId,
                  effect.id,
                  paramKey,
                  Math.max(0, timeInClip),
                  next
                );
              } else {
                updateEffectParam(clipId, effect.id, paramKey, next);
              }
            };

            return (
              <div key={paramKey} className="space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1 min-w-0">
                    {keyframeable && (
                      <button
                        type="button"
                        onClick={() => {
                          if (existingKf) {
                            removeEffectKeyframe(clipId, effect.id, existingKf.id);
                          } else {
                            addEffectKeyframe(
                              clipId,
                              effect.id,
                              paramKey,
                              Math.max(0, timeInClip),
                              Number(currentValue)
                            );
                          }
                        }}
                        className={`w-3.5 h-3.5 flex items-center justify-center transition-colors flex-shrink-0 ${
                          existingKf
                            ? "text-yellow-400"
                            : kfs.length > 0
                              ? "text-yellow-700"
                              : "text-zinc-600 hover:text-zinc-400"
                        }`}
                        title={
                          existingKf
                            ? `Remove keyframe for ${paramDef.label}`
                            : `Add keyframe for ${paramDef.label}`
                        }
                      >
                        <svg
                          viewBox="0 0 10 10"
                          className="w-2.5 h-2.5"
                          fill="currentColor"
                        >
                          <path d="M5 0 L10 5 L5 10 L0 5 Z" />
                        </svg>
                      </button>
                    )}
                    <label className="text-[10px] text-[var(--text-muted)] truncate">
                      {paramDef.label}
                    </label>
                  </div>
                  <div
                    className="flex items-center gap-1.5"
                    onFocus={() => setFocusedParam(paramKey)}
                    onMouseDown={() => setFocusedParam(paramKey)}
                  >
                    {paramDef.type === "number" && (
                      <>
                        <input
                          type="range"
                          min={paramDef.min ?? 0}
                          max={paramDef.max ?? 100}
                          step={paramDef.step ?? 1}
                          value={Number(currentValue)}
                          onChange={(e) =>
                            setNumberParam(parseFloat(e.target.value))
                          }
                          className="w-14 accent-zinc-100"
                        />
                        <span className="text-[9px] font-mono text-[var(--text-muted)] w-8 text-right">
                          {Number(currentValue).toFixed(
                            (paramDef.step ?? 1) < 1 ? 2 : 0
                          )}
                          {paramDef.unit || ""}
                        </span>
                      </>
                    )}
                    {paramDef.type === "boolean" && (
                      <button
                        onClick={() =>
                          updateEffectParam(
                            clipId,
                            effect.id,
                            paramKey,
                            !(effect.params[paramKey] ?? paramDef.defaultValue)
                          )
                        }
                        className={`px-2 py-0.5 rounded text-[10px] ${
                          effect.params[paramKey]
                            ? "bg-blue-600 text-white"
                            : "bg-zinc-800 text-zinc-400"
                        }`}
                      >
                        {effect.params[paramKey] ? "ON" : "OFF"}
                      </button>
                    )}
                    {paramDef.type === "string" && paramKey === "lutId" && (
                      <select
                        value={String(
                          effect.params[paramKey] ?? paramDef.defaultValue
                        )}
                        onChange={(e) =>
                          updateEffectParam(
                            clipId,
                            effect.id,
                            paramKey,
                            e.target.value
                          )
                        }
                        className="max-w-[140px] px-1 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-zinc-200"
                      >
                        {lutOptions.map((opt) => (
                          <option key={opt.id} value={opt.id}>
                            {opt.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {paramDef.type === "string" && paramKey === "profile" && effect.type === "input-color-transform" && (
                      <select value={String(effect.params[paramKey] ?? paramDef.defaultValue)} onChange={(e) => updateEffectParam(clipId, effect.id, paramKey, e.target.value)} className="max-w-[140px] px-1 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-zinc-200">
                        <option value="rec709">Rec.709 / SDR</option><option value="slog3">Sony S-Log3</option><option value="hlg">Rec.2100 HLG</option>
                      </select>
                    )}
                    {paramDef.type === "string" && paramKey !== "lutId" && !(paramKey === "profile" && effect.type === "input-color-transform") && (
                      <input
                        type="text"
                        value={String(
                          effect.params[paramKey] ?? paramDef.defaultValue
                        )}
                        onChange={(e) =>
                          updateEffectParam(
                            clipId,
                            effect.id,
                            paramKey,
                            e.target.value
                          )
                        }
                        className="w-24 px-1 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-zinc-200"
                      />
                    )}
                  </div>
                </div>
                {keyframeable &&
                  focusedParam === paramKey &&
                  kfs.length > 0 &&
                  clip && (
                    <ParamSparkline
                      effect={effect}
                      paramKey={paramKey}
                      duration={clip.duration}
                      min={paramDef.min ?? 0}
                      max={paramDef.max ?? 100}
                    />
                  )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
