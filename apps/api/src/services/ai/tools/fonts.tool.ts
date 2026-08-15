import type { Track, Clip, FontAsset } from "@tempo/types";
import { eq } from "drizzle-orm";
import { db, fontAssets } from "@tempo/db";
import {
  resolveTextFont,
  toolOk,
  toolErr,
} from "@tempo/editor-core";
import type { ProjectState } from "./project-state.js";
import { getGoogleFontCatalog } from "../../google-fonts.service.js";

function findClip(
  state: ProjectState,
  clipId: string
): { track: Track; clip: Clip } | null {
  for (const track of state.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

function toFontAsset(row: typeof fontAssets.$inferSelect): FontAsset {
  return {
    id: row.id,
    familyName: row.familyName,
    fileName: row.fileName,
    url: row.url,
    format: row.format as FontAsset["format"],
    projectId: row.projectId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function loadProjectFonts(
  state: ProjectState
): Promise<{ fonts: FontAsset[]; error?: string }> {
  if (!state.projectId) {
    return { fonts: state.fontAssets || [] };
  }
  try {
    const rows = await db.query.fontAssets.findMany({
      where: eq(fontAssets.projectId, state.projectId),
    });
    const assets = rows.map(toFontAsset);
    state.fontAssets = assets;
    return { fonts: assets };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to load project fonts";
    return {
      fonts: state.fontAssets || [],
      error: `Database error loading fonts: ${message}`,
    };
  }
}

export const fontsToolDefinitions = [
  {
    name: "list_fonts",
    description:
      "List available fonts: built-in Google families (id google:Family) and project-uploaded fonts (uuid ids). Use before set_text_font.",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Optional family-name search, e.g. condensed, Bebas, Hindi" },
        category: { type: "string", enum: ["sans", "serif", "display", "mono", "script"] },
        limit: { type: "number", description: "Maximum results, default 100, max 500" },
      },
    },
  },
  {
    name: "set_text_font",
    description:
      "Set a text clip's font by fontId (google:Inter or an uploaded font uuid from list_fonts). Updates textParams.fontId and fontFamily.",
    parameters: {
      type: "object" as const,
      properties: {
        clipId: { type: "string", description: "Text clip ID" },
        fontId: {
          type: "string",
          description: "Font id from list_fonts, e.g. google:Inter or upload uuid",
        },
      },
      required: ["clipId", "fontId"],
    },
  },
];

export const fontsToolExecutors: Record<
  string,
  (
    args: Record<string, any>,
    state: ProjectState
  ) =>
    | { result: string; state: ProjectState }
    | Promise<{ result: string; state: ProjectState }>
> = {
  list_fonts: async (args, state) => {
    const { fonts: uploads, error } = await loadProjectFonts(state);
    const catalog = await getGoogleFontCatalog();
    const query = String(args.query || "").trim().toLocaleLowerCase();
    const category = String(args.category || "");
    const limit = Math.max(1, Math.min(500, Number(args.limit) || 100));
    const google = catalog
      .filter((font) => !query || font.familyName.toLocaleLowerCase().includes(query))
      .filter((font) => !category || font.category === category)
      .slice(0, limit);
    const entries = [
      ...google,
      ...uploads.map((f) => ({
        id: f.id,
        familyName: f.familyName,
        source: "upload" as const,
      })),
    ];
    return {
      result: JSON.stringify({
        fonts: entries,
        count: entries.length,
        googleCatalogCount: catalog.length,
        ...(error ? { warning: error } : {}),
      }),
      state,
    };
  },

  set_text_font: async (args, state) => {
    const found = findClip(state, args.clipId);
    if (!found) {
      return {
        result: toolErr(`Clip "${args.clipId}" not found`, {
          code: "CLIP_NOT_FOUND",
          fixHint:
            "Use exact clipId from add_text_clip JSON (ok.clipId). Prefer passing fontId on add_text_clip / update_text_clip instead of a second call.",
        }),
        state,
      };
    }
    if (!found.clip.textParams) {
      return {
        result: toolErr(`Clip "${args.clipId}" is not a text clip`, {
          code: "NOT_TEXT_CLIP",
        }),
        state,
      };
    }

    const { fonts: uploads, error } = await loadProjectFonts(state);
    const uploadMap = new Map(uploads.map((f) => [f.id, f.familyName]));
    const catalog = await getGoogleFontCatalog();
    const resolved = resolveTextFont(
      String(args.fontId),
      uploadMap,
      catalog.map((font) => font.familyName)
    );
    if (!resolved) {
      return {
        result: toolErr(
          `Unknown fontId "${args.fontId}". Call list_fonts.${
            error ? ` (${error})` : ""
          }`,
          { code: "UNKNOWN_FONT" }
        ),
        state,
      };
    }

    found.clip.textParams.fontId = resolved.fontId;
    found.clip.textParams.fontFamily = resolved.fontFamily;

    return {
      result: toolOk(
        `Set font on ${args.clipId} to ${resolved.familyName} (${resolved.fontId})${
          error ? ` Warning: ${error}` : ""
        }`,
        { clipId: found.clip.id, trackId: found.track.id }
      ),
      state,
    };
  },
};
