import type { MediaAsset, MediaAnalysis } from "@tempo/types";
import { eq } from "drizzle-orm";
import { db, mediaAssets } from "@tempo/db";
import type { ProjectState } from "./project-state.js";
import {
  refreshMediaAssets,
  toClientMediaAsset,
} from "./media-assets.js";

function analysisOf(asset: MediaAsset): MediaAnalysis | undefined {
  return asset.metadata?.analysis;
}

function statusOf(asset: MediaAsset): string {
  return asset.metadata?.analysisStatus || "none";
}

function matchesQuery(asset: MediaAsset, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const analysis = analysisOf(asset);
  const hay = [
    asset.name,
    asset.type,
    analysis?.summary,
    analysis?.mood,
    analysis?.shotType,
    analysis?.setting,
    analysis?.cameraMotion,
    ...(analysis?.tags || []),
    ...(analysis?.subjects || []),
    ...(analysis?.bestFor || []),
    ...(analysis?.textInFrame || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  return tokens.every((token) => hay.includes(token));
}

function getAssets(state: ProjectState): MediaAsset[] {
  return state.mediaAssets || [];
}

export const mediaToolDefinitions = [
  {
    name: "list_media",
    description:
      "List project media assets with semantic analysis summaries (when ready). Use before choosing clips for an edit. Refreshes analysis from the database.",
    parameters: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: ["video", "audio", "image"],
          description: "Optional filter by media type",
        },
      },
      required: [],
    },
  },
  {
    name: "get_media_analysis",
    description:
      "Get full semantic analysis for one media asset (summary, tags, shot, mood, palette, moments, bestFor). Refreshes from the database.",
    parameters: {
      type: "object" as const,
      properties: {
        mediaId: { type: "string", description: "Media asset ID" },
      },
      required: ["mediaId"],
    },
  },
  {
    name: "search_media",
    description:
      "Search media by free-text query matched against name, tags, subjects, mood, shot, setting, and summary. Prefer this when the user asks for a specific kind of footage.",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search text, e.g. 'sunset beach wide'" },
        type: {
          type: "string",
          enum: ["video", "audio", "image"],
          description: "Optional media type filter",
        },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
];

export const mediaToolExecutors: Record<
  string,
  (
    args: Record<string, any>,
    state: ProjectState
  ) => Promise<{ result: string; state: ProjectState }>
> = {
  list_media: async (args, state) => {
    let assets = await refreshMediaAssets(state);
    if (args.type) assets = assets.filter((a) => a.type === args.type);
    if (assets.length === 0) {
      return { result: "No media assets in this project.", state };
    }

    const lines = assets.map((a) => {
      const analysis = analysisOf(a);
      const status = statusOf(a);
      const dur = a.duration ?? a.metadata?.duration;
      const audioSt = a.metadata?.audioAnalysisStatus;
      const bpm = a.metadata?.audioRhythm?.bpm;
      const segs = a.metadata?.audioTranscript?.segments?.length;
      const audioBit =
        a.type === "audio" || a.type === "video"
          ? ` | audio=${audioSt || "none"}${bpm != null ? ` bpm=${bpm}` : ""}${segs != null ? ` segs=${segs}` : ""}`
          : "";
      const base = `- ${a.id} | ${a.type} | "${a.name}" | dur=${dur ?? "n/a"}s | analysis=${status}${audioBit}`;
      if ((status === "ready" || status === "skipped") && analysis) {
        return `${base}\n  summary: ${analysis.summary}\n  tags: ${(analysis.tags || []).join(", ") || "—"}\n  shot=${analysis.shotType || "—"} mood=${analysis.mood || "—"} bestFor=${(analysis.bestFor || []).join(", ") || "—"}`;
      }
      return base;
    });

    return { result: `Media library (${assets.length}):\n${lines.join("\n")}`, state };
  },

  get_media_analysis: async (args, state) => {
    await refreshMediaAssets(state);
    let asset = getAssets(state).find((a) => a.id === args.mediaId);
    if (!asset) {
      // Direct fetch if not in project list (edge case)
      const row = await db.query.mediaAssets.findFirst({
        where: eq(mediaAssets.id, args.mediaId),
      });
      if (row) asset = toClientMediaAsset(row);
    }
    if (!asset) return { result: `Error: Media ${args.mediaId} not found`, state };

    const status = statusOf(asset);
    const analysis = analysisOf(asset);
    const payload = {
      id: asset.id,
      name: asset.name,
      type: asset.type,
      duration: asset.duration ?? asset.metadata?.duration ?? null,
      technical: {
        width: asset.metadata?.width,
        height: asset.metadata?.height,
        fps: asset.metadata?.fps,
        codec: asset.metadata?.codec,
        mimeType: asset.metadata?.mimeType,
      },
      analysisStatus: status,
      analysis: analysis || null,
    };
    return { result: JSON.stringify(payload, null, 2), state };
  },

  search_media: async (args, state) => {
    const query = String(args.query || "");
    let assets = (await refreshMediaAssets(state)).filter((a) =>
      matchesQuery(a, query)
    );
    if (args.type) assets = assets.filter((a) => a.type === args.type);
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
    assets = assets.slice(0, limit);

    if (assets.length === 0) {
      return { result: `No media matched query "${query}".`, state };
    }

    const lines = assets.map((a) => {
      const analysis = analysisOf(a);
      return `- ${a.id} "${a.name}" (${a.type}) — ${analysis?.summary || statusOf(a)}`;
    });
    return {
      result: `Search "${query}" → ${assets.length} result(s):\n${lines.join("\n")}`,
      state,
    };
  },
};
