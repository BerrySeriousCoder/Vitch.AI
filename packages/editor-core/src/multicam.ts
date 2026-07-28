import type { MulticamAngle, MulticamSettings, MulticamSwitch } from "@tempo/types";

const clamp = (value: unknown, min: number, max: number, fallback: number) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;

function normalizeAngles(input: unknown): MulticamAngle[] {
  if (!Array.isArray(input)) return [];
  const ids = new Set<string>();
  const angles: MulticamAngle[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Partial<MulticamAngle>;
    const id = String(value.id || "").trim();
    const sourceClipId = String(value.sourceClipId || "").trim();
    const sourceMediaId = String(value.sourceMediaId || "").trim();
    if (!id || ids.has(id) || !sourceClipId || !sourceMediaId) continue;
    ids.add(id);
    angles.push({ id, sourceClipId, sourceMediaId, name: String(value.name || `Angle ${angles.length + 1}`).slice(0, 120), sourceOffset: clamp(value.sourceOffset, 0, Number.MAX_SAFE_INTEGER, 0) });
  }
  return angles;
}

/** Validates a multicam EDL, makes switch times monotonic, and guarantees a cut at time zero. */
export function normalizeMulticam(input?: Partial<MulticamSettings> | null): MulticamSettings | null {
  const angles = normalizeAngles(input?.angles);
  if (angles.length < 2) return null;
  const ids = new Set(angles.map((angle) => angle.id));
  const raw = Array.isArray(input?.switches) ? input!.switches : [];
  const switches: MulticamSwitch[] = raw
    .filter((value): value is MulticamSwitch => Boolean(value) && typeof value === "object" && ids.has(String((value as MulticamSwitch).angleId || "")))
    .map((value) => ({ time: clamp(value.time, 0, Number.MAX_SAFE_INTEGER, 0), angleId: String(value.angleId) }))
    .sort((a, b) => a.time - b.time)
    .filter((value, index, sorted) => index === sorted.length - 1 || value.time !== sorted[index + 1]!.time);
  const audioAngleId = ids.has(String(input?.audioAngleId || "")) ? String(input!.audioAngleId) : angles[0]!.id;
  if (switches.length === 0 || switches[0]!.time > 0) switches.unshift({ time: 0, angleId: audioAngleId });
  if (switches[0]!.time === 0) switches[0] = { time: 0, angleId: switches[0]!.angleId };
  const sync = input?.sync && typeof input.sync === "object" && ids.has(String(input.sync.referenceAngleId || ""))
    ? {
        mode: input.sync.mode === "audio-correlation" || input.sync.mode === "clap" || input.sync.mode === "timecode" ? input.sync.mode : "manual" as const,
        referenceAngleId: String(input.sync.referenceAngleId),
        confidenceByAngle: Object.fromEntries(angles.map((angle) => [angle.id, Math.max(0, Math.min(1, Number(input.sync!.confidenceByAngle?.[angle.id]) || 0))])),
        analysedAt: typeof input.sync.analysedAt === "string" ? input.sync.analysedAt : undefined,
      }
    : undefined;
  return { angles, switches, audioAngleId, sync };
}

/** Resolves the active camera at a clip-local time. */
export function resolveMulticamAngleAtTime(input: MulticamSettings | null | undefined, time: number): MulticamAngle | null {
  const multicam = normalizeMulticam(input);
  if (!multicam) return null;
  let angleId = multicam.switches[0]!.angleId;
  for (const cut of multicam.switches) {
    if (cut.time > time) break;
    angleId = cut.angleId;
  }
  return multicam.angles.find((angle) => angle.id === angleId) || null;
}

/** Adds/replaces a live cut at clip-local time without changing other decisions. */
export function setMulticamSwitch(input: MulticamSettings | null | undefined, time: number, angleId: string): MulticamSettings | null {
  const multicam = normalizeMulticam(input);
  if (!multicam || !multicam.angles.some((angle) => angle.id === angleId)) return null;
  const t = clamp(time, 0, Number.MAX_SAFE_INTEGER, 0);
  return normalizeMulticam({ ...multicam, switches: [...multicam.switches.filter((cut) => Math.abs(cut.time - t) > 0.00001), { time: t, angleId }] });
}
