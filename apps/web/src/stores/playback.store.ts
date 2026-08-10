import { create } from "zustand";

interface PlaybackState {
  /** Current playhead position in seconds */
  currentTime: number;
  /** Whether the timeline is currently playing */
  isPlaying: boolean;
  /** Total duration of the project in seconds */
  duration: number;
  /** Playback volume (0-1) */
  volume: number;

  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seek: (time: number) => void;
  setDuration: (duration: number) => void;
  setVolume: (volume: number) => void;
  /** Publish the transport clock to React at a bounded UI cadence. */
  syncClock: (time: number) => void;
  reset: () => void;
}

let anchorTime = 0;
let anchorWallTime = 0;

function wallTime(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** High-resolution transport time for render/audio code; does not rerender React. */
export function getPlaybackClockTime(): number {
  const state = usePlaybackStore.getState();
  if (!state.isPlaying) return state.currentTime;
  const elapsed = Math.max(0, (wallTime() - anchorWallTime) / 1000);
  const time = anchorTime + elapsed;
  return state.duration > 0 ? Math.min(state.duration, time) : time;
}

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  currentTime: 0,
  isPlaying: false,
  duration: 0,
  volume: 1,

  play: () => {
    const state = get();
    if (state.isPlaying) return;
    anchorTime = state.currentTime;
    anchorWallTime = wallTime();
    set({ isPlaying: true });
  },
  pause: () => {
    const currentTime = getPlaybackClockTime();
    anchorTime = currentTime;
    anchorWallTime = wallTime();
    set({ isPlaying: false, currentTime });
  },
  togglePlay: () => {
    if (get().isPlaying) get().pause();
    else get().play();
  },
  seek: (time) => {
    const currentTime = Math.max(0, time);
    anchorTime = currentTime;
    anchorWallTime = wallTime();
    set({ currentTime });
  },
  setDuration: (duration) => set({ duration }),
  setVolume: (volume) => set({ volume: Math.max(0, Math.min(1, volume)) }),
  syncClock: (currentTime) => set({ currentTime }),
  reset: () => {
    anchorTime = 0;
    anchorWallTime = wallTime();
    set({ currentTime: 0, isPlaying: false, duration: 0, volume: 1 });
  },
}));
