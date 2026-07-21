import type { ColorCurves, CurvePoint } from "@tempo/types";

export const MAX_CURVE_POINTS = 8;

export const DEFAULT_CURVE_POINTS: readonly CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export const COLOR_CURVE_CHANNELS = ["luma", "red", "green", "blue"] as const;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function createDefaultCurve(): CurvePoint[] {
  return DEFAULT_CURVE_POINTS.map((point) => ({ ...point }));
}

function normalizePoints(input: unknown): CurvePoint[] {
  if (!Array.isArray(input)) return createDefaultCurve();
  const deduped = new Map<number, CurvePoint>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<CurvePoint>;
    if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) continue;
    const x = clamp(Number(candidate.x), 0, 1);
    deduped.set(x, { x, y: clamp(Number(candidate.y), 0, 1) });
  }
  const points = [...deduped.values()].sort((a, b) => a.x - b.x);
  if (points.length === 0) return createDefaultCurve();
  if (points[0]!.x > 0) points.unshift({ x: 0, y: 0 });
  if (points[points.length - 1]!.x < 1) points.push({ x: 1, y: 1 });
  if (points.length <= MAX_CURVE_POINTS) return points;

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const middle = points.slice(1, -1);
  const wantedMiddle = MAX_CURVE_POINTS - 2;
  const stride = middle.length / wantedMiddle;
  return [
    first,
    ...Array.from({ length: wantedMiddle }, (_, index) =>
      middle[Math.min(middle.length - 1, Math.floor(index * stride))]!
    ),
    last,
  ];
}

/** Repairs persisted/imported curve payloads into a safe monotonic point list. */
export function normalizeCurvePoints(input: unknown): CurvePoint[] {
  return normalizePoints(input).map((point) => ({ ...point }));
}

export function validateCurvePoints(
  input: unknown
): { ok: true; value: CurvePoint[] } | { ok: false; message: string } {
  if (!Array.isArray(input) || input.length < 2 || input.length > MAX_CURVE_POINTS) {
    return {
      ok: false,
      message: `curve must contain 2 to ${MAX_CURVE_POINTS} control points`,
    };
  }
  let previousX = -1;
  const value: CurvePoint[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") {
      return { ok: false, message: "each curve point must be an object" };
    }
    const point = item as Partial<CurvePoint>;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return { ok: false, message: "curve point x and y must be finite numbers" };
    }
    if (point.x! < 0 || point.x! > 1 || point.y! < 0 || point.y! > 1) {
      return { ok: false, message: "curve point x and y must be between 0 and 1" };
    }
    if (point.x! <= previousX) {
      return { ok: false, message: "curve point x values must be strictly increasing" };
    }
    previousX = point.x!;
    value.push({ x: point.x!, y: point.y! });
  }
  if (value[0]!.x !== 0 || value[value.length - 1]!.x !== 1) {
    return { ok: false, message: "curves must begin at x=0 and end at x=1" };
  }
  return { ok: true, value };
}

export function normalizeColorCurves(input?: unknown): ColorCurves {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    luma: normalizeCurvePoints(source.luma),
    red: normalizeCurvePoints(source.red),
    green: normalizeCurvePoints(source.green),
    blue: normalizeCurvePoints(source.blue),
  };
}

/** Piecewise-linear curve sample; mirrors the shader's control-point semantics. */
export function sampleCurve(points: readonly CurvePoint[], input: number): number {
  const curve = normalizeCurvePoints(points);
  const x = clamp(input, 0, 1);
  for (let index = 1; index < curve.length; index++) {
    const right = curve[index]!;
    if (x > right.x) continue;
    const left = curve[index - 1]!;
    const t = (x - left.x) / Math.max(1e-6, right.x - left.x);
    return left.y + (right.y - left.y) * t;
  }
  return curve[curve.length - 1]!.y;
}
