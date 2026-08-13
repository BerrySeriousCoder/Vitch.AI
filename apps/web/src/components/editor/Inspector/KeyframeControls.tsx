"use client";

import { useTimelineStore } from "@/stores/timeline.store";
import { usePlaybackStore } from "@/stores/playback.store";
import type { Clip, EasingType } from "@tempo/types";

interface KeyframeControlsProps {
  clip: Clip;
  property: string;
  label: string;
  value: number | string | boolean;
}

export function KeyframeControls({ clip, property, label, value }: KeyframeControlsProps) {
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const addKeyframe = useTimelineStore((s) => s.addKeyframe);
  const removeKeyframe = useTimelineStore((s) => s.removeKeyframe);

  const timeInClip = currentTime - clip.startTime;

  const existingKf = clip.keyframes.find(
    (k) => k.property === property && Math.abs(k.time - timeInClip) < 0.05
  );

  const hasAnyKeyframes = clip.keyframes.some((k) => k.property === property);

  const handleToggle = () => {
    if (existingKf) {
      removeKeyframe(clip.id, existingKf.id);
    } else {
      addKeyframe(clip.id, property, timeInClip, value);
    }
  };

  return (
    <button
      onClick={handleToggle}
      className={`w-3.5 h-3.5 flex items-center justify-center transition-colors flex-shrink-0 ${
        existingKf
          ? "text-yellow-400"
          : hasAnyKeyframes
          ? "text-yellow-700"
          : "text-zinc-600 hover:text-zinc-400"
      }`}
      title={
        existingKf
          ? `Remove keyframe for ${label}`
          : `Add keyframe for ${label}`
      }
    >
      <svg viewBox="0 0 10 10" className="w-2.5 h-2.5" fill="currentColor">
        <path d="M5 0 L10 5 L5 10 L0 5 Z" />
      </svg>
    </button>
  );
}
