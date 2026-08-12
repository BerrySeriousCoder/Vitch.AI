"use client";

import { useState, useMemo } from "react";
import { useSelectionStore } from "@/stores/selection.store";
import { useTimelineStore } from "@/stores/timeline.store";
import { getAllEffects, getCategories, getEffectDefinition } from "@/lib/effects/registry";
import { effectPresets } from "@/lib/effects/presets";
import { EffectParams } from "./EffectParams";
import { TEXT_ANIMATION_PRESETS } from "@/lib/animations/text-presets";
import { SHAPE_ANIMATION_PRESETS } from "@/lib/animations/shape-presets";
import type { EffectParamValue } from "@tempo/types";

export function EffectsBrowser() {
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds);
  const tracks = useTimelineStore((s) => s.tracks);
  const addEffect = useTimelineStore((s) => s.addEffect);
  const addKeyframe = useTimelineStore((s) => s.addKeyframe);
  const copyClipAttributes = useTimelineStore((s) => s.copyClipAttributes);

  const [tab, setTab] = useState<"effects" | "presets" | "animations">("effects");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const clip = useMemo(() => {
    if (selectedClipIds.size === 0) return null;
    const firstId = selectedClipIds.values().next().value;
    for (const track of tracks) {
      const found = track.clips.find((c) => c.id === firstId);
      if (found) return found;
    }
    return null;
  }, [selectedClipIds, tracks]);

  const categories = getCategories();
  const allEffects = getAllEffects();
  const filteredEffects = selectedCategory
    ? allEffects.filter((e) => e.category === selectedCategory)
    : allEffects;

  const handleAddEffect = (type: string) => {
    if (!clip) return;
    const def = getEffectDefinition(type);
    if (!def) return;

    const defaultParams: Record<string, EffectParamValue> = {};
    for (const [key, paramDef] of Object.entries(def.params)) {
      defaultParams[key] = paramDef.defaultValue;
    }

    addEffect(clip.id, {
      type: def.type,
      name: def.name,
      enabled: true,
      params: defaultParams,
      keyframes: [],
    });
  };

  const handleApplyPreset = (preset: typeof effectPresets[0]) => {
    if (!clip) return;
    for (const fx of preset.effects) {
      addEffect(clip.id, fx);
    }
  };

  const applyAttributesToSelection = (scopes: Array<"effects" | "color" | "motion" | "audio">) => {
    if (!clip) return;
    const targets = [...selectedClipIds].filter((id) => id !== clip.id);
    if (targets.length === 0) return;
    copyClipAttributes(clip.id, targets, scopes, true);
  };

  return (
    <div className="h-full flex flex-col bg-[var(--bg-secondary)]">
      <div className="h-9 flex items-center px-3 border-b border-[var(--border-default)] flex-shrink-0">
        <span className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
          Effects
        </span>
      </div>

      {!clip ? (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-[11px] text-[var(--text-muted)] text-center">
            Select a clip to add effects
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* Applied effects */}
          {clip.effects.length > 0 && (
            <div className="p-2 space-y-1.5 border-b border-[var(--border-default)]">
              <h4 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider px-1">
                Applied
              </h4>
              {clip.effects.map((effect) => (
                <EffectParams key={effect.id} clipId={clip.id} effect={effect} />
              ))}
              {selectedClipIds.size > 1 && (
                <div className="flex gap-1 pt-1">
                  <button onClick={() => applyAttributesToSelection(["color"])} className="px-1.5 py-1 text-[9px] rounded bg-[var(--bg-tertiary)] hover:text-white">Match grade</button>
                  <button onClick={() => applyAttributesToSelection(["effects"])} className="px-1.5 py-1 text-[9px] rounded bg-[var(--bg-tertiary)] hover:text-white">Copy FX stack</button>
                  <button onClick={() => applyAttributesToSelection(["motion", "audio"])} className="px-1.5 py-1 text-[9px] rounded bg-[var(--bg-tertiary)] hover:text-white">Copy motion/audio</button>
                </div>
              )}
            </div>
          )}

          {/* Tabs */}
          <div className="flex border-b border-[var(--border-default)]">
            {(["effects", "presets", "animations"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${
                  tab === t
                    ? "text-[var(--text-primary)] border-b-2 border-zinc-400"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {tab === "effects" ? (
            <div className="p-2">
              {/* Category filter */}
              <div className="flex gap-1 mb-2 flex-wrap">
                <button
                  onClick={() => setSelectedCategory(null)}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    !selectedCategory
                      ? "bg-zinc-700 text-zinc-100"
                      : "text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]"
                  }`}
                >
                  All
                </button>
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium capitalize transition-colors ${
                      selectedCategory === cat
                        ? "bg-zinc-700 text-zinc-100"
                        : "text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              {/* Effects list */}
              <div className="space-y-0.5">
                {filteredEffects.map((def) => (
                  <button
                    key={def.type}
                    onClick={() => handleAddEffect(def.type)}
                    className="w-full flex items-center justify-between px-2 py-1.5 rounded hover:bg-[var(--bg-tertiary)] text-left transition-colors group"
                  >
                    <span className="text-[11px] text-[var(--text-primary)]">{def.name}</span>
                    <span className="text-[10px] text-[var(--text-muted)] capitalize">
                      {def.category}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : tab === "presets" ? (
            <div className="p-2 space-y-1.5">
              {effectPresets.map((preset) => (
                <button
                  key={preset.name}
                  onClick={() => handleApplyPreset(preset)}
                  className="w-full px-2.5 py-2 rounded border border-[var(--border-default)] hover:border-zinc-600 bg-[var(--bg-primary)] text-left transition-colors"
                >
                  <p className="text-[11px] font-medium text-[var(--text-primary)]">
                    {preset.name}
                  </p>
                  <p className="text-[9px] text-[var(--text-muted)] mt-0.5">
                    {preset.description}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <div className="p-2 space-y-3">
              <div>
                <h4 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider px-1 mb-1.5">
                  Text Animations
                </h4>
                <div className="space-y-0.5">
                  {TEXT_ANIMATION_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      onClick={() => {
                        if (!clip) return;
                        const kfs = preset.generateKeyframes(clip.duration);
                        for (const k of kfs) addKeyframe(clip.id, k.property, k.time, k.value, k.easing);
                      }}
                      className="w-full px-2 py-1.5 rounded hover:bg-[var(--bg-tertiary)] text-left transition-colors"
                    >
                      <p className="text-[11px] text-[var(--text-primary)]">{preset.name}</p>
                      <p className="text-[9px] text-[var(--text-muted)]">{preset.description}</p>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <h4 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider px-1 mb-1.5">
                  Shape Animations
                </h4>
                <div className="space-y-0.5">
                  {SHAPE_ANIMATION_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      onClick={() => {
                        if (!clip) return;
                        const kfs = preset.generateKeyframes(clip.duration);
                        for (const k of kfs) addKeyframe(clip.id, k.property, k.time, k.value, k.easing);
                      }}
                      className="w-full px-2 py-1.5 rounded hover:bg-[var(--bg-tertiary)] text-left transition-colors"
                    >
                      <p className="text-[11px] text-[var(--text-primary)]">{preset.name}</p>
                      <p className="text-[9px] text-[var(--text-muted)]">{preset.description}</p>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
