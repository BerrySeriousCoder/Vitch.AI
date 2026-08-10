"use client";

import { useEffect, useRef } from "react";
import { getPlaybackClockTime, usePlaybackStore } from "@/stores/playback.store";

export function usePlaybackLoop() {
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const rafRef = useRef<number>(0);
  const lastPublishedRef = useRef<number>(0);

  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(rafRef.current);
      return;
    }

    lastPublishedRef.current = performance.now();

    const loop = (now: number) => {
      const { duration, pause, seek, syncClock } = usePlaybackStore.getState();
      const clockTime = getPlaybackClockTime();

      if (duration > 0 && clockTime >= duration) {
        pause();
        seek(0);
      } else if (now - lastPublishedRef.current >= 50) {
        // UI subscribers do not need a 60 Hz React render. The compositor
        // reads getPlaybackClockTime() directly at its full frame cadence.
        lastPublishedRef.current = now;
        syncClock(clockTime);
      }

      if (usePlaybackStore.getState().isPlaying) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying]);
}
