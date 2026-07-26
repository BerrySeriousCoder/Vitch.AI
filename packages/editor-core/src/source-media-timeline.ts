import type { Clip } from "@tempo/types";

/** Tolerance used for timing comparisons, in seconds. */
export const TIMING_EPSILON = 1e-9;

/** The fields needed to map between source-media and timeline time. */
export type ClipTiming = Pick<
  Clip,
  "startTime" | "duration" | "sourceOffset" | "speed"
>;

/** A half-open interval: [start, end). */
export type TimeInterval = readonly [start: number, end: number];

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
}

function validatePoint(name: string, value: number): void {
  requireFinite(name, value);
}

function validateInterval(
  name: string,
  interval: TimeInterval
): void {
  const [start, end] = interval;
  requireFinite(`${name} start`, start);
  requireFinite(`${name} end`, end);

  if (end < start) {
    throw new RangeError(`${name} end must be greater than or equal to start`);
  }
}

/**
 * Validates timing fields and derived range endpoints.
 *
 * Zero-duration clips are valid but have empty source and timeline ranges.
 */
export function validateClipTiming(clip: ClipTiming): void {
  requireFinite("clip.startTime", clip.startTime);
  requireFinite("clip.duration", clip.duration);
  requireFinite("clip.sourceOffset", clip.sourceOffset);
  requireFinite("clip.speed", clip.speed);

  if (clip.startTime < 0) {
    throw new RangeError("clip.startTime must be greater than or equal to zero");
  }
  if (clip.duration < 0) {
    throw new RangeError("clip.duration must be greater than or equal to zero");
  }
  if (clip.sourceOffset < 0) {
    throw new RangeError("clip.sourceOffset must be greater than or equal to zero");
  }
  if (clip.speed === 0 || !Number.isFinite(clip.speed)) {
    throw new RangeError("clip.speed must be a non-zero finite number");
  }

  requireFinite("clip timeline end", clip.startTime + clip.duration);
  requireFinite(
    "clip source end",
    clip.sourceOffset + clip.duration * Math.abs(clip.speed)
  );
}

/** Returns the half-open source-media range consumed by the clip. */
export function getSourceRange(clip: ClipTiming): TimeInterval {
  validateClipTiming(clip);
  const mag = Math.abs(clip.speed);
  return [
    clip.sourceOffset,
    clip.sourceOffset + clip.duration * mag,
  ];
}

/** Alias that makes the range's association with a clip explicit. */
export const getClipSourceRange = getSourceRange;

function normalizePointAtStart(
  point: number,
  start: number,
  end: number
): number | null {
  if (end <= start) {
    return null;
  }
  if (point >= end || point < start - TIMING_EPSILON) {
    return null;
  }
  return point < start ? start : point;
}

/**
 * Maps a source-media point into timeline time.
 * Returns null when the point is outside the clip's half-open source range.
 */
export function mapSourcePointToTimeline(
  clip: ClipTiming,
  sourceTime: number
): number | null {
  validateClipTiming(clip);
  validatePoint("sourceTime", sourceTime);

  const [sourceStart, sourceEnd] = getSourceRange(clip);
  const normalizedSourceTime = normalizePointAtStart(
    sourceTime,
    sourceStart,
    sourceEnd
  );

  if (normalizedSourceTime === null) {
    return null;
  }

  const mag = Math.abs(clip.speed);
  if (clip.speed < 0) {
    return clip.startTime + (sourceEnd - normalizedSourceTime) / mag;
  }
  return (
    clip.startTime +
    (normalizedSourceTime - clip.sourceOffset) / mag
  );
}

/**
 * Maps a timeline point into source-media time.
 * Returns null when the point is outside the clip's half-open timeline range.
 */
export function mapTimelinePointToSource(
  clip: ClipTiming,
  timelineTime: number
): number | null {
  validateClipTiming(clip);
  validatePoint("timelineTime", timelineTime);

  const timelineEnd = clip.startTime + clip.duration;
  const normalizedTimelineTime = normalizePointAtStart(
    timelineTime,
    clip.startTime,
    timelineEnd
  );

  if (normalizedTimelineTime === null) {
    return null;
  }

  const mag = Math.abs(clip.speed);
  const t = normalizedTimelineTime - clip.startTime;
  if (clip.speed < 0) {
    return clip.sourceOffset + (clip.duration - t) * mag;
  }
  return clip.sourceOffset + t * mag;
}

/**
 * Intersects a source-media interval with the clip and maps that intersection
 * into a half-open timeline interval. Empty or boundary-only intersections
 * return null.
 */
export function mapSourceIntervalToTimeline(
  clip: ClipTiming,
  sourceInterval: TimeInterval
): TimeInterval | null {
  validateClipTiming(clip);
  validateInterval("source interval", sourceInterval);

  const [sourceStart, sourceEnd] = getSourceRange(clip);
  const intersectionStart = Math.max(sourceInterval[0], sourceStart);
  const intersectionEnd = Math.min(sourceInterval[1], sourceEnd);

  if (intersectionEnd - intersectionStart <= TIMING_EPSILON) {
    return null;
  }

  const mag = Math.abs(clip.speed);
  const t0 = clip.startTime + (intersectionStart - sourceStart) / mag;
  const t1 = clip.startTime + (intersectionEnd - sourceStart) / mag;
  if (clip.speed < 0) {
    // Reverse: source start maps near timeline end
    const a = clip.startTime + (sourceEnd - intersectionEnd) / mag;
    const b = clip.startTime + (sourceEnd - intersectionStart) / mag;
    return [a, b];
  }
  return [t0, t1];
}
