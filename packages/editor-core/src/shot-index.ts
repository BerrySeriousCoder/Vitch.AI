import type {
  MediaAsset,
  MediaAnalysis,
  ShotIndex,
  ShotIndexEntry,
} from "@tempo/types";

export interface FilterShotsOpts {
  assetId?: string;
  tags?: string[];
  shotType?: string;
  query?: string;
}

function tokenOverlap(a: string, b: string): boolean {
  const ta = a
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
  const hay = b.toLowerCase();
  return ta.some((t) => hay.includes(t));
}

/** Flatten shot indexes from a media library. */
export function shotsFromAssets(assets: readonly MediaAsset[]): ShotIndexEntry[] {
  const out: ShotIndexEntry[] = [];
  for (const asset of assets) {
    const indexed = asset.metadata?.shotIndex?.shots;
    if (indexed && indexed.length > 0) {
      out.push(...indexed);
      continue;
    }
    const synthetic = syntheticShotFromAnalysis(asset);
    if (synthetic) out.push(synthetic);
  }
  return out;
}

/** Build a single full-asset shot from clip-level analysis when no index exists. */
export function syntheticShotFromAnalysis(
  asset: MediaAsset
): ShotIndexEntry | null {
  if (asset.type === "audio") return null;
  const analysis: MediaAnalysis | undefined = asset.metadata?.analysis;
  const duration =
    asset.duration && asset.duration > 0
      ? asset.duration
      : asset.type === "image"
        ? 5
        : Number(asset.metadata?.duration) || 5;
  const now = new Date().toISOString();
  return {
    id: `${asset.id}-full`,
    assetId: asset.id,
    start: 0,
    end: duration,
    summary: analysis?.summary,
    tags: analysis?.tags || [],
    subjects: analysis?.subjects || [],
    shotType: analysis?.shotType,
    cameraMotion: analysis?.cameraMotion,
    mood: analysis?.mood,
    energy: undefined,
    bestFor: analysis?.bestFor || [],
    thumbnailUrl: asset.thumbnailUrl || undefined,
    analyzedAt: analysis?.analyzedAt || now,
  };
}

export function filterShots(
  shots: readonly ShotIndexEntry[],
  opts: FilterShotsOpts = {}
): ShotIndexEntry[] {
  let out = [...shots];
  if (opts.assetId) {
    out = out.filter((s) => s.assetId === opts.assetId);
  }
  if (opts.shotType) {
    out = out.filter(
      (s) => (s.shotType || "").toLowerCase() === opts.shotType!.toLowerCase()
    );
  }
  if (opts.tags?.length) {
    const want = new Set(opts.tags.map((t) => t.toLowerCase()));
    out = out.filter((s) =>
      (s.tags || []).some((t) => want.has(t.toLowerCase()))
    );
  }
  if (opts.query) {
    out = out.filter((s) => {
      const hay = [
        s.summary,
        ...(s.tags || []),
        ...(s.subjects || []),
        ...(s.bestFor || []),
      ]
        .filter(Boolean)
        .join(" ");
      return tokenOverlap(opts.query!, hay);
    });
  }
  return out;
}

export function normalizeShotIndex(
  raw: Partial<ShotIndex> | null | undefined,
  fallbackModel = "unknown"
): ShotIndex | null {
  if (!raw || !Array.isArray(raw.shots)) return null;
  return {
    schemaVersion: 1,
    shots: raw.shots.filter(
      (s): s is ShotIndexEntry =>
        !!s &&
        typeof s.id === "string" &&
        typeof s.assetId === "string" &&
        Number.isFinite(s.start) &&
        Number.isFinite(s.end)
    ),
    model: raw.model || fallbackModel,
    analyzedAt: raw.analyzedAt || new Date().toISOString(),
  };
}
