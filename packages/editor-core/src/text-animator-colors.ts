/**
 * Color parsing and interpolation used by kinetic text animators.
 * Kept separate from the motion resolver so colour handling can also be
 * reused by future rich-text and preset-pack importers.
 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return `#${trimmed.slice(1).split("").map((part) => part + part).join("")}`.toUpperCase();
  }
  return null;
}

export function interpolateHexColor(from: string, to: string, amount: number): string {
  const start = normalizeHexColor(from) || "#FFFFFF";
  const end = normalizeHexColor(to) || "#FFFFFF";
  const t = clamp(amount, 0, 1);
  const channels = [1, 3, 5].map((index) => {
    const a = Number.parseInt(start.slice(index, index + 2), 16);
    const b = Number.parseInt(end.slice(index, index + 2), 16);
    return Math.round(a + (b - a) * t).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`.toUpperCase();
}
