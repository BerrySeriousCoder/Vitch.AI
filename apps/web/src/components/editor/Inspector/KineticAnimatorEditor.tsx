"use client";

import { normalizeAnimator } from "@tempo/editor-core";
import type {
  TextAnimator,
  TextAnimatorProperty,
  TextParams,
  TextSplitMode,
} from "@tempo/types";

const PROPERTY_OPTIONS: Array<{ value: TextAnimatorProperty; label: string }> = [
  { value: "opacity", label: "Opacity" },
  { value: "offsetX", label: "X position" },
  { value: "offsetY", label: "Y position" },
  { value: "scale", label: "Scale" },
  { value: "rotation", label: "Rotation" },
  { value: "tracking", label: "Tracking" },
  { value: "blur", label: "Blur" },
  { value: "color", label: "Fill color" },
];

const SPLIT_OPTIONS: Array<{ value: TextSplitMode; label: string }> = [
  { value: "none", label: "Off" },
  { value: "char", label: "Characters" },
  { value: "word", label: "Words" },
  { value: "line", label: "Lines" },
];

function defaultAnimator(property: TextAnimatorProperty, textColor: string): TextAnimator {
  if (property === "color") {
    return normalizeAnimator({
      property,
      fromColor: textColor,
      toColor: "#FFFFFF",
    });
  }
  return normalizeAnimator({ property });
}

function NumericField({
  label,
  value,
  min,
  step = 0.01,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="min-w-0 text-[10px] text-[var(--text-muted)]">
      <span className="block mb-0.5 truncate">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        className="w-full min-w-0 px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] font-mono text-[var(--text-primary)] focus:outline-none"
      />
    </label>
  );
}

/**
 * Focused editor for the animator stack of one text layer. The Inspector owns
 * persistence while this component owns input normalization and stack edits.
 */
export function KineticAnimatorEditor({
  params,
  onChange,
}: {
  params: TextParams;
  onChange: (patch: Partial<TextParams>) => void;
}) {
  const animators = (params.animators || []).map((animator) => normalizeAnimator(animator));
  const split = params.split || "none";

  const replaceAnimators = (next: TextAnimator[]) => onChange({ animators: next });

  const updateAnimator = (index: number, patch: Partial<TextAnimator>) => {
    replaceAnimators(
      animators.map((animator, currentIndex) =>
        currentIndex === index ? normalizeAnimator({ ...animator, ...patch }) : animator
      )
    );
  };

  const setProperty = (index: number, property: TextAnimatorProperty) => {
    const current = animators[index]!;
    const next = defaultAnimator(property, params.color);
    updateAnimator(index, {
      ...next,
      offsetSec: current.offsetSec,
      durationSec: current.durationSec,
      staggerSec: current.staggerSec,
      ease: current.ease,
      range: current.range,
    });
  };

  return (
    <section className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-primary)] p-2">
      <div className="flex items-center justify-between gap-2">
        <label className="text-[11px] text-[var(--text-muted)]">Animate units</label>
        <select
          value={split}
          onChange={(event) => {
            const split = event.target.value as TextSplitMode;
            onChange({ split, animators: split === "none" ? [] : animators });
          }}
          className="w-28 px-1.5 py-1 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded text-xs text-[var(--text-primary)] focus:outline-none"
        >
          {SPLIT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      {split !== "none" && (
        <>
          <p className="text-[10px] leading-4 text-[var(--text-muted)]">
            Stack channels to animate every character, word, or line. A unit range targets only part of the text.
          </p>
          <div className="space-y-2">
            {animators.map((animator, index) => (
              <div key={`${index}-${animator.property}`} className="space-y-1.5 rounded border border-[var(--border-default)] p-1.5">
                <div className="flex items-center gap-1">
                  <select
                    value={animator.property}
                    onChange={(event) => setProperty(index, event.target.value as TextAnimatorProperty)}
                    className="min-w-0 flex-1 px-1 py-0.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded text-[10px] text-[var(--text-primary)] focus:outline-none"
                  >
                    {PROPERTY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => replaceAnimators(animators.filter((_, currentIndex) => currentIndex !== index))}
                    className="px-1.5 py-0.5 rounded text-[10px] text-red-300 hover:bg-red-500/10"
                    aria-label={`Remove ${animator.property} animator`}
                  >
                    Remove
                  </button>
                </div>

                {animator.property === "color" ? (
                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="text-[10px] text-[var(--text-muted)]">
                      <span className="block mb-0.5">From color</span>
                      <input
                        type="color"
                        value={animator.fromColor || "#FFFFFF"}
                        onChange={(event) => updateAnimator(index, { fromColor: event.target.value })}
                        className="h-6 w-full cursor-pointer rounded border border-[var(--border-default)] bg-[var(--bg-secondary)]"
                      />
                    </label>
                    <label className="text-[10px] text-[var(--text-muted)]">
                      <span className="block mb-0.5">To color</span>
                      <input
                        type="color"
                        value={animator.toColor || "#FFFFFF"}
                        onChange={(event) => updateAnimator(index, { toColor: event.target.value })}
                        className="h-6 w-full cursor-pointer rounded border border-[var(--border-default)] bg-[var(--bg-secondary)]"
                      />
                    </label>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-1.5">
                    <NumericField label="From" value={animator.from} step={0.1} onChange={(value) => updateAnimator(index, { from: value })} />
                    <NumericField label="To" value={animator.to} step={0.1} onChange={(value) => updateAnimator(index, { to: value })} />
                  </div>
                )}

                <div className="grid grid-cols-3 gap-1.5">
                  <NumericField label="Offset (s)" value={animator.offsetSec} min={0} onChange={(value) => updateAnimator(index, { offsetSec: value })} />
                  <NumericField label="Duration (s)" value={animator.durationSec} min={0.01} onChange={(value) => updateAnimator(index, { durationSec: value })} />
                  <NumericField label="Stagger (s)" value={animator.staggerSec} min={0} onChange={(value) => updateAnimator(index, { staggerSec: value })} />
                </div>

                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                    <input
                      type="checkbox"
                      checked={Boolean(animator.range)}
                      onChange={(event) => updateAnimator(index, { range: event.target.checked ? [0, 1] : undefined })}
                    />
                    Target units
                  </label>
                  {animator.range && (
                    <div className="grid flex-1 grid-cols-2 gap-1.5">
                      <NumericField label="Start" value={animator.range[0]} min={0} step={1} onChange={(value) => updateAnimator(index, { range: [Math.min(Math.floor(value), animator.range![1] - 1), animator.range![1]] })} />
                      <NumericField label="End" value={animator.range[1]} min={0} step={1} onChange={(value) => updateAnimator(index, { range: [animator.range![0], Math.max(Math.floor(value), animator.range![0] + 1)] })} />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => replaceAnimators([...animators, defaultAnimator("opacity", params.color)])}
            className="w-full px-2 py-1 rounded border border-dashed border-[var(--border-default)] text-[10px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
          >
            Add animator
          </button>
        </>
      )}
    </section>
  );
}
