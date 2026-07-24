import type { PlanarTrack, PlanarTrackPoint, PlanarTrackSample } from "@tempo/types";

export const MAX_PLANAR_TRACK_SAMPLES = 300;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function point(raw: unknown): PlanarTrackPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as { x?: unknown; y?: unknown };
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
}

function signedArea(corners: readonly PlanarTrackPoint[]): number {
  let area = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    area += a.x * b.y - a.y * b.x;
  }
  return area * 0.5;
}

/** Returns bounded, time-sorted convex corner samples suitable for corner pinning. */
export function normalizePlanarTrackSamples(samples: readonly PlanarTrackSample[] | null | undefined): PlanarTrackSample[] {
  if (!Array.isArray(samples)) return [];
  const deduped = new Map<number, PlanarTrackSample>();
  for (const raw of samples) {
    const time = Number(raw?.time);
    if (!Number.isFinite(time) || !Array.isArray(raw?.corners) || raw.corners.length !== 4) continue;
    const corners: Array<PlanarTrackPoint | null> = raw.corners.map((candidate: PlanarTrackPoint) => point(candidate));
    if (corners.some((candidate) => !candidate)) continue;
    const quad = corners as PlanarTrackPoint[];
    // Degenerate/reversed/self-crossing pins make a projective render unstable.
    if (Math.abs(signedArea(quad)) < 0.0005) continue;
    const cross = quad.map((a, i) => {
      const b = quad[(i + 1) % 4]!;
      const c = quad[(i + 2) % 4]!;
      return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    });
    if (!cross.every((value) => value > 0) && !cross.every((value) => value < 0)) continue;
    deduped.set(Math.max(0, time), {
      time: Math.max(0, time),
      corners: quad as PlanarTrackSample["corners"],
      confidence: Number.isFinite(Number(raw.confidence)) ? clamp(Number(raw.confidence), 0, 1) : undefined,
    });
  }
  return [...deduped.values()].sort((a, b) => a.time - b.time).slice(0, MAX_PLANAR_TRACK_SAMPLES);
}

export function normalizePlanarTrack(input: PlanarTrack | null | undefined): PlanarTrack | null {
  if (!input || typeof input !== "object" || !input.sourceClipId) return null;
  const samples = normalizePlanarTrackSamples(input.samples);
  if (samples.length < 2) return null;
  return { sourceClipId: String(input.sourceClipId), surface: String(input.surface || "surface").slice(0, 160), samples };
}

export function resolvePlanarTrackAtTime(track: PlanarTrack | null | undefined, time: number): PlanarTrackSample | null {
  const normalized = normalizePlanarTrack(track);
  if (!normalized) return null;
  const samples = normalized.samples;
  const t = Math.max(0, Number(time) || 0);
  let left = samples[0]!;
  let right = samples[samples.length - 1]!;
  for (let index = 1; index < samples.length; index++) {
    if (t <= samples[index]!.time) { left = samples[index - 1]!; right = samples[index]!; break; }
  }
  const amount = clamp((t - left.time) / Math.max(0.00001, right.time - left.time), 0, 1);
  return {
    time: t,
    corners: left.corners.map((corner, index) => ({
      x: corner.x + (right.corners[index]!.x - corner.x) * amount,
      y: corner.y + (right.corners[index]!.y - corner.y) * amount,
    })) as PlanarTrackSample["corners"],
    confidence: (left.confidence ?? 1) + ((right.confidence ?? 1) - (left.confidence ?? 1)) * amount,
  };
}
