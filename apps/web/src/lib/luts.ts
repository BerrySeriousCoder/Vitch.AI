import type { LutAsset } from "@tempo/types";
import {
  getBuiltinLut,
  parseCubeLut,
  type ParsedCubeLut,
  BUILTIN_LUT_IDS,
} from "@tempo/editor-core";
import { resolveMediaUrl } from "@/lib/media-url";

const assetById = new Map<string, LutAsset>();
const parsedById = new Map<string, ParsedCubeLut>();
const loadPromises = new Map<string, Promise<ParsedCubeLut | null>>();

type LutReadyListener = () => void;
const readyListeners = new Set<LutReadyListener>();

export function onLutReady(listener: LutReadyListener): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

export function notifyLutReady(): void {
  for (const l of readyListeners) l();
}

export function listBuiltinLutEntries(): Array<{ id: string; name: string }> {
  return BUILTIN_LUT_IDS.map((id) => ({
    id,
    name: id === "builtin:identity" ? "Identity" : "Cinematic",
  }));
}

export function registerLutAsset(asset: LutAsset): void {
  assetById.set(asset.id, asset);
  parsedById.delete(asset.id);
  loadPromises.delete(asset.id);
}

export function unregisterLutAsset(lutId: string): void {
  assetById.delete(lutId);
  parsedById.delete(lutId);
  loadPromises.delete(lutId);
}

export function clearRegisteredLutAssets(): void {
  assetById.clear();
  parsedById.clear();
  loadPromises.clear();
}

export function getRegisteredLutAsset(lutId: string): LutAsset | undefined {
  return assetById.get(lutId);
}

export function listRegisteredLutAssets(): LutAsset[] {
  return Array.from(assetById.values());
}

/** Resolve builtin or uploaded LUT volume for WebGPU / preview. */
export async function loadLutById(lutId: string): Promise<ParsedCubeLut | null> {
  if (!lutId) return null;
  const builtin = getBuiltinLut(lutId);
  if (builtin) return builtin;

  const cached = parsedById.get(lutId);
  if (cached) return cached;

  const existing = loadPromises.get(lutId);
  if (existing) return existing;

  const promise = (async () => {
    const asset = assetById.get(lutId);
    if (!asset) return null;
    try {
      const url = resolveMediaUrl(asset.url);
      if (!url) return null;
      const res = await fetch(url);
      if (!res.ok) return null;
      const text = await res.text();
      const parsed = parseCubeLut(text);
      parsedById.set(lutId, parsed);
      return parsed;
    } catch {
      return null;
    }
  })();

  loadPromises.set(lutId, promise);
  const result = await promise;
  loadPromises.delete(lutId);
  return result;
}
