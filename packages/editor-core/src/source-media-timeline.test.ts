import { describe, expect, it } from "vitest";
import {
  TIMING_EPSILON,
  getClipSourceRange,
  getSourceRange,
  mapSourceIntervalToTimeline,
  mapSourcePointToTimeline,
  mapTimelinePointToSource,
  validateClipTiming,
  type ClipTiming,
} from "./source-media-timeline.js";

const identityClip: ClipTiming = {
  startTime: 0,
  duration: 10,
  sourceOffset: 0,
  speed: 1,
};

describe("validateClipTiming", () => {
  it("accepts valid and zero-duration clip timing", () => {
    expect(() => validateClipTiming(identityClip)).not.toThrow();
    expect(() =>
      validateClipTiming({ ...identityClip, duration: 0 })
    ).not.toThrow();
  });

  it.each(["startTime", "duration", "sourceOffset", "speed"] as const)(
    "rejects non-finite %s",
    (field) => {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(() =>
          validateClipTiming({ ...identityClip, [field]: value })
        ).toThrow(RangeError);
      }
    }
  );

  it("rejects zero speed and negative time fields", () => {
    expect(() =>
      validateClipTiming({ ...identityClip, speed: 0 })
    ).toThrow(RangeError);
    expect(() =>
      validateClipTiming({ ...identityClip, speed: -1 })
    ).not.toThrow();
    expect(() =>
      validateClipTiming({ ...identityClip, startTime: -1 })
    ).toThrow(RangeError);
    expect(() =>
      validateClipTiming({ ...identityClip, duration: -1 })
    ).toThrow(RangeError);
    expect(() =>
      validateClipTiming({ ...identityClip, sourceOffset: -1 })
    ).toThrow(RangeError);
  });

  it("rejects overflow in derived endpoints", () => {
    expect(() =>
      validateClipTiming({
        startTime: Number.MAX_VALUE,
        duration: Number.MAX_VALUE,
        sourceOffset: 0,
        speed: 1,
      })
    ).toThrow(RangeError);
    expect(() =>
      validateClipTiming({
        startTime: 0,
        duration: Number.MAX_VALUE,
        sourceOffset: 0,
        speed: Number.MAX_VALUE,
      })
    ).toThrow(RangeError);
  });
});

describe("source range", () => {
  it("returns the identity range", () => {
    expect(getSourceRange(identityClip)).toEqual([0, 10]);
    expect(getClipSourceRange(identityClip)).toEqual([0, 10]);
  });

  it("applies source offset and speed", () => {
    expect(
      getSourceRange({
        startTime: 20,
        duration: 4,
        sourceOffset: 10,
        speed: 2,
      })
    ).toEqual([10, 18]);
  });
});

describe("point mapping", () => {
  it("maps identity points and excludes the half-open end", () => {
    expect(mapSourcePointToTimeline(identityClip, 0)).toBe(0);
    expect(mapSourcePointToTimeline(identityClip, 4.25)).toBe(4.25);
    expect(mapTimelinePointToSource(identityClip, 4.25)).toBe(4.25);
    expect(mapSourcePointToTimeline(identityClip, 10)).toBeNull();
    expect(mapTimelinePointToSource(identityClip, 10)).toBeNull();
  });

  it("returns null for every point on a zero-duration clip", () => {
    const emptyClip = { ...identityClip, duration: 0 };

    expect(mapSourcePointToTimeline(emptyClip, 0)).toBeNull();
    expect(mapTimelinePointToSource(emptyClip, 0)).toBeNull();
  });

  it("maps timeline and source offsets", () => {
    const clip: ClipTiming = {
      startTime: 5,
      duration: 10,
      sourceOffset: 20,
      speed: 1,
    };

    expect(mapSourcePointToTimeline(clip, 23)).toBe(8);
    expect(mapTimelinePointToSource(clip, 8)).toBe(23);
    expect(mapSourcePointToTimeline(clip, 19)).toBeNull();
    expect(mapTimelinePointToSource(clip, 4)).toBeNull();
  });

  it("maps fast and slow playback", () => {
    const fastClip: ClipTiming = {
      startTime: 20,
      duration: 4,
      sourceOffset: 10,
      speed: 2,
    };
    const slowClip: ClipTiming = {
      startTime: 20,
      duration: 4,
      sourceOffset: 10,
      speed: 0.5,
    };

    expect(mapSourcePointToTimeline(fastClip, 14)).toBe(22);
    expect(mapTimelinePointToSource(fastClip, 22)).toBe(14);
    expect(mapSourcePointToTimeline(slowClip, 11)).toBe(22);
    expect(mapTimelinePointToSource(slowClip, 22)).toBe(11);
  });

  it("uses epsilon to normalize a point just before the start", () => {
    const clip: ClipTiming = {
      startTime: 5,
      duration: 2,
      sourceOffset: 10,
      speed: 1,
    };

    expect(
      mapSourcePointToTimeline(clip, 10 - TIMING_EPSILON / 2)
    ).toBe(5);
    expect(
      mapTimelinePointToSource(clip, 5 - TIMING_EPSILON / 2)
    ).toBe(10);
    expect(
      mapSourcePointToTimeline(clip, 10 - TIMING_EPSILON * 2)
    ).toBeNull();
  });

  it("rejects non-finite point arguments", () => {
    expect(() =>
      mapSourcePointToTimeline(identityClip, Number.NaN)
    ).toThrow(RangeError);
    expect(() =>
      mapTimelinePointToSource(identityClip, Number.POSITIVE_INFINITY)
    ).toThrow(RangeError);
  });
});

describe("source interval mapping", () => {
  const clip: ClipTiming = {
    startTime: 100,
    duration: 4,
    sourceOffset: 10,
    speed: 2,
  };

  it("maps an interval fully inside the source range", () => {
    expect(mapSourceIntervalToTimeline(clip, [12, 16])).toEqual([101, 103]);
  });

  it("clips intervals at the source range start and end", () => {
    expect(mapSourceIntervalToTimeline(clip, [8, 12])).toEqual([100, 101]);
    expect(mapSourceIntervalToTimeline(clip, [16, 20])).toEqual([103, 104]);
    expect(mapSourceIntervalToTimeline(clip, [8, 20])).toEqual([100, 104]);
  });

  it("returns null for disjoint, empty, boundary-only, and epsilon-empty intervals", () => {
    expect(mapSourceIntervalToTimeline(clip, [0, 10])).toBeNull();
    expect(mapSourceIntervalToTimeline(clip, [18, 20])).toBeNull();
    expect(mapSourceIntervalToTimeline(clip, [12, 12])).toBeNull();
    expect(mapSourceIntervalToTimeline(clip, [10, 10 + TIMING_EPSILON / 2])).toBeNull();
  });

  it("rejects invalid intervals", () => {
    expect(() => mapSourceIntervalToTimeline(clip, [2, 1])).toThrow(
      RangeError
    );
    expect(() =>
      mapSourceIntervalToTimeline(clip, [0, Number.NaN])
    ).toThrow(RangeError);
  });
});

describe("round trips", () => {
  const clip: ClipTiming = {
    startTime: 7.25,
    duration: 9.5,
    sourceOffset: 13.75,
    speed: 1.25,
  };

  it.each([7.25, 8, 11.125, 16.749999])(
    "maps timeline point %s to source and back",
    (timelineTime) => {
      const sourceTime = mapTimelinePointToSource(clip, timelineTime);
      expect(sourceTime).not.toBeNull();
      expect(mapSourcePointToTimeline(clip, sourceTime!)).toBeCloseTo(
        timelineTime,
        12
      );
    }
  );

  it.each([13.75, 14, 19.5, 25.624999])(
    "maps source point %s to timeline and back",
    (sourceTime) => {
      const timelineTime = mapSourcePointToTimeline(clip, sourceTime);
      expect(timelineTime).not.toBeNull();
      expect(mapTimelinePointToSource(clip, timelineTime!)).toBeCloseTo(
        sourceTime,
        12
      );
    }
  );
});
