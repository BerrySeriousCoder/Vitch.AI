import type { Keyframe } from "@tempo/types";
import {
  TEXT_ANIMATION_PRESETS,
  SHAPE_ANIMATION_PRESETS,
  applyAnimationPresetToKeyframes,
} from "./animation-presets";
import { TEXT_ANIMATOR_PRESETS, applyTextAnimatorPreset } from "./text-animators";
import { EFFECT_PRESETS, getEffectPreset } from "./effect-presets";
import type { TextParams } from "@tempo/types";

export type TempoPackKind =
  | "animation"
  | "effect"
  | "transition"
  | "caption"
  | "kinetic"
  | "mixed";

export interface TempoPackPreset {
  id: string;
  name: string;
  description?: string;
  kind: TempoPackKind;
  /** For animation/keyframe presets */
  animationPresetId?: string;
  /** For kinetic text */
  kineticPresetId?: string;
  /** For effect presets */
  effectPresetId?: string;
}

export interface TempoPackManifest {
  id: string;
  name: string;
  version: string;
  kind: TempoPackKind;
  presets: TempoPackPreset[];
}

export interface TempoPack {
  manifest: TempoPackManifest;
  /** Absolute or virtual root for assets/ (optional) */
  rootPath?: string;
}

const BUILTIN_CORE: TempoPackManifest = {
  id: "builtin:core",
  name: "Tempo Core",
  version: "1.0.0",
  kind: "mixed",
  presets: [
    ...TEXT_ANIMATION_PRESETS.map((p) => ({
      id: `anim:${p.id}`,
      name: p.name,
      description: p.description,
      kind: "animation" as const,
      animationPresetId: p.id,
    })),
    ...SHAPE_ANIMATION_PRESETS.map((p) => ({
      id: `anim:${p.id}`,
      name: p.name,
      description: p.description,
      kind: "animation" as const,
      animationPresetId: p.id,
    })),
    ...TEXT_ANIMATOR_PRESETS.map((p) => ({
      id: `kinetic:${p.id}`,
      name: p.name,
      description: p.description,
      kind: "kinetic" as const,
      kineticPresetId: p.id,
    })),
    ...EFFECT_PRESETS.map((p) => ({
      id: `fx:${p.id}`,
      name: p.name,
      description: p.description,
      kind: "effect" as const,
      effectPresetId: p.id,
    })),
  ],
};

/** Always-available builtins (not project-scoped). */
const builtins = new Map<string, TempoPack>([
  ["builtin:core", { manifest: BUILTIN_CORE }],
]);

/** Project-scoped packs: projectId → packId → pack */
const projectRegistries = new Map<string, Map<string, TempoPack>>();

function projectMap(projectId: string): Map<string, TempoPack> {
  let map = projectRegistries.get(projectId);
  if (!map) {
    map = new Map();
    projectRegistries.set(projectId, map);
  }
  return map;
}

/**
 * Register a pack. Builtins (`builtin:*`) ignore projectId.
 * Project packs require projectId and are isolated per project.
 */
export function registerTempoPack(
  pack: TempoPack,
  projectId?: string | null
): void {
  const id = pack.manifest.id;
  if (id.startsWith("builtin:")) {
    builtins.set(id, pack);
    return;
  }
  if (!projectId) {
    throw new Error(`registerTempoPack(${id}): projectId required for non-builtin packs`);
  }
  projectMap(projectId).set(id, pack);
}

/** Drop all non-builtin packs for a project (call before reload-from-disk). */
export function clearProjectPacks(projectId: string): void {
  projectRegistries.delete(projectId);
}

export function listTempoPacks(projectId?: string | null): TempoPackManifest[] {
  const out = [...builtins.values()].map((p) => p.manifest);
  if (projectId) {
    const map = projectRegistries.get(projectId);
    if (map) {
      for (const pack of map.values()) out.push(pack.manifest);
    }
  }
  return out;
}

export function getTempoPack(
  packId: string,
  projectId?: string | null
): TempoPack | undefined {
  const builtin = builtins.get(packId);
  if (builtin) return builtin;
  if (!projectId) return undefined;
  return projectRegistries.get(projectId)?.get(packId);
}

export function listPresets(
  packId?: string,
  projectId?: string | null
): Array<TempoPackPreset & { packId: string }> {
  if (packId) {
    const pack = getTempoPack(packId, projectId);
    if (!pack) return [];
    return pack.manifest.presets.map((pr) => ({
      ...pr,
      packId: pack.manifest.id,
    }));
  }
  return listTempoPacks(projectId).flatMap((manifest) => {
    const pack = getTempoPack(manifest.id, projectId);
    if (!pack) return [];
    return pack.manifest.presets.map((pr) => ({
      ...pr,
      packId: pack.manifest.id,
    }));
  });
}

export function validateTempoPackManifest(
  input: unknown
): { ok: true; value: TempoPackManifest } | { ok: false; message: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, message: "manifest must be an object" };
  }
  const raw = input as Record<string, unknown>;
  if (!raw.id || !raw.name || !raw.version) {
    return { ok: false, message: "manifest requires id, name, version" };
  }
  if (!Array.isArray(raw.presets)) {
    return { ok: false, message: "manifest.presets must be an array" };
  }
  for (const p of raw.presets) {
    if (!p || typeof p !== "object" || !(p as any).id || !(p as any).name) {
      return { ok: false, message: "each preset needs id and name" };
    }
  }
  return {
    ok: true,
    value: {
      id: String(raw.id),
      name: String(raw.name),
      version: String(raw.version),
      kind: (raw.kind as TempoPackKind) || "mixed",
      presets: (raw.presets as any[]).map((p) => ({
        id: String(p.id),
        name: String(p.name),
        description: p.description != null ? String(p.description) : undefined,
        kind: (p.kind as TempoPackKind) || "mixed",
        animationPresetId: p.animationPresetId
          ? String(p.animationPresetId)
          : undefined,
        kineticPresetId: p.kineticPresetId
          ? String(p.kineticPresetId)
          : undefined,
        effectPresetId: p.effectPresetId ? String(p.effectPresetId) : undefined,
      })),
    },
  };
}

/** Safe join under a root — rejects zip-slip (`..`) paths. */
export function safePackPath(root: string, relative: string): string | null {
  const normRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = relative.replace(/\\/g, "/").split("/");
  if (parts.some((p) => p === "..")) return null;
  const joined = [normRoot, ...parts.filter((p) => p && p !== ".")].join("/");
  if (!joined.startsWith(normRoot + "/") && joined !== normRoot) return null;
  return joined;
}

export type ApplyPresetResult =
  | { ok: true; keyframes?: Keyframe[]; textParams?: TextParams; effectPresetId?: string }
  | { ok: false; message: string };

export function applyPreset(
  packId: string,
  presetId: string,
  opts: { clipDuration: number; textParams?: TextParams },
  projectId?: string | null
): ApplyPresetResult {
  const pack = getTempoPack(packId, projectId);
  if (!pack) return { ok: false, message: `Unknown pack ${packId}` };
  const preset = pack.manifest.presets.find((p) => p.id === presetId);
  if (!preset) return { ok: false, message: `Unknown preset ${presetId}` };

  if (preset.kineticPresetId && opts.textParams) {
    return {
      ok: true,
      textParams: applyTextAnimatorPreset(
        opts.textParams,
        preset.kineticPresetId,
        opts.clipDuration
      ),
    };
  }
  if (preset.animationPresetId) {
    const kfs = applyAnimationPresetToKeyframes(
      preset.animationPresetId,
      opts.clipDuration
    );
    if (!kfs) return { ok: false, message: `Animation preset missing` };
    return { ok: true, keyframes: kfs };
  }
  if (preset.effectPresetId) {
    if (!getEffectPreset(preset.effectPresetId)) {
      return { ok: false, message: `Effect preset missing` };
    }
    return { ok: true, effectPresetId: preset.effectPresetId };
  }
  return { ok: false, message: "Preset has no apply target" };
}
