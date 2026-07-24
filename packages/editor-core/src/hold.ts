import type { ClipHold } from "@tempo/types";

export function normalizeHold(
  input: Partial<ClipHold> | null | undefined
): ClipHold | null {
  if (!input) return null;
  const at = input.at === "in" ? "in" : input.at === "out" ? "out" : null;
  if (!at) return null;
  const durationSec = Math.max(0, Number(input.durationSec) || 0);
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) return null;
  return { at, durationSec };
}

export function validateHold(
  input: unknown
): { ok: true; value: ClipHold | null } | { ok: false; message: string } {
  if (input == null) return { ok: true, value: null };
  if (typeof input !== "object") {
    return { ok: false, message: "hold must be an object or null" };
  }
  const raw = input as Record<string, unknown>;
  if (raw.at !== "in" && raw.at !== "out") {
    return { ok: false, message: 'hold.at must be "in" or "out"' };
  }
  if (!Number.isFinite(Number(raw.durationSec))) {
    return { ok: false, message: "hold.durationSec must be finite" };
  }
  return { ok: true, value: normalizeHold(raw as Partial<ClipHold>) };
}

/**
 * How much additional timeline hold is needed when media handle is short.
 * `needSec` / `availableSec` are in source seconds for the steal side.
 */
export function planHoldExtension(
  needSec: number,
  availableSec: number
): { holdSourceSec: number; useMediaSec: number } {
  const need = Math.max(0, Number.isFinite(needSec) ? needSec : 0);
  const avail = Math.max(0, Number.isFinite(availableSec) ? availableSec : 0);
  const useMediaSec = Math.min(need, avail);
  const holdSourceSec = Math.max(0, need - useMediaSec);
  return { holdSourceSec, useMediaSec };
}
