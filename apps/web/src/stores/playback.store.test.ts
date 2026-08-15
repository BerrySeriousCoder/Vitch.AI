import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlaybackClockTime, usePlaybackStore } from "./playback.store";

describe("playback transport clock", () => {
  let now = 1_000;

  beforeEach(() => {
    now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    usePlaybackStore.getState().reset();
    usePlaybackStore.getState().setDuration(10);
  });

  afterEach(() => {
    usePlaybackStore.getState().reset();
    vi.restoreAllMocks();
  });

  it("advances independently from bounded React publications", () => {
    const transport = usePlaybackStore.getState();
    transport.seek(2);
    transport.play();
    now += 500;

    expect(getPlaybackClockTime()).toBeCloseTo(2.5, 5);
    expect(usePlaybackStore.getState().currentTime).toBe(2);

    transport.syncClock(getPlaybackClockTime());
    expect(usePlaybackStore.getState().currentTime).toBeCloseTo(2.5, 5);
  });

  it("captures exact clock time on pause and reanchors on seek", () => {
    const transport = usePlaybackStore.getState();
    transport.play();
    now += 750;
    transport.pause();
    expect(usePlaybackStore.getState().currentTime).toBeCloseTo(0.75, 5);

    transport.seek(4);
    transport.play();
    now += 250;
    expect(getPlaybackClockTime()).toBeCloseTo(4.25, 5);
  });

  it("clamps the render clock to duration", () => {
    const transport = usePlaybackStore.getState();
    transport.seek(9.8);
    transport.play();
    now += 500;
    expect(getPlaybackClockTime()).toBe(10);
  });
});
