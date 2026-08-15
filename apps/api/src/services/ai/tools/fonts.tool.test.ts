import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Clip, Track, FontAsset } from "@tempo/types";
import { fontsToolExecutors, loadProjectFonts } from "./fonts.tool.js";
import { createProjectState } from "./index.js";

vi.mock("@tempo/db", () => {
  const findMany = vi.fn();
  return {
    db: {
      query: {
        fontAssets: { findMany },
      },
    },
    fontAssets: {
      projectId: "project_id",
      id: "id",
    },
  };
});

import { db } from "@tempo/db";

function textTrack(clipOverrides: Partial<Clip> = {}): Track {
  const clip: Clip = {
    id: "text-1",
    trackId: "t-text",
    sourceMediaId: null,
    startTime: 0,
    duration: 3,
    sourceOffset: 0,
    speed: 1,
    volume: 1,
    muted: false,
    opacity: 1,
    blendMode: "normal",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    effects: [],
    keyframes: [],
    mask: null,
    textParams: {
      text: "Hello",
      fontFamily: "Inter, sans-serif",
      fontSize: 48,
      fontWeight: "600",
      color: "#ffffff",
      textAlign: "center",
      lineHeight: 1.3,
    },
    ...clipOverrides,
  };
  return {
    id: "t-text",
    name: "Text",
    type: "text",
    order: 0,
    locked: false,
    visible: true,
    solo: false,
    clips: [clip],
  };
}

const upload: FontAsset = {
  id: "font-upload-1",
  familyName: "BrandDisplay",
  fileName: "BrandDisplay.otf",
  url: "/uploads/fonts/BrandDisplay.otf",
  format: "opentype",
  projectId: "p1",
  createdAt: new Date().toISOString(),
};

describe("fonts tools", () => {
  beforeEach(() => {
    vi.mocked(db.query.fontAssets.findMany).mockReset();
  });

  it("list_fonts includes google + uploads (in-memory)", async () => {
    const state = createProjectState([textTrack()], undefined, {
      fontAssets: [upload],
    });
    const { result } = await fontsToolExecutors.list_fonts!({}, state);
    const parsed = JSON.parse(result) as {
      fonts: { id: string; source: string }[];
    };
    expect(parsed.fonts.some((f) => f.id === "google:Inter")).toBe(true);
    expect(parsed.fonts.some((f) => f.id === "font-upload-1")).toBe(true);
  });

  it("list_fonts loads uploads from DB when projectId set", async () => {
    vi.mocked(db.query.fontAssets.findMany).mockResolvedValue([
      {
        id: "font-upload-1",
        projectId: "p1",
        userId: "u1",
        familyName: "BrandDisplay",
        fileName: "BrandDisplay.otf",
        url: "/uploads/fonts/BrandDisplay.otf",
        format: "opentype",
        createdAt: new Date(),
      },
    ] as any);

    const state = createProjectState([textTrack()], undefined, {
      projectId: "p1",
    });
    const { result } = await fontsToolExecutors.list_fonts!({}, state);
    const parsed = JSON.parse(result) as {
      fonts: { id: string }[];
      warning?: string;
    };
    expect(parsed.warning).toBeUndefined();
    expect(parsed.fonts.some((f) => f.id === "font-upload-1")).toBe(true);
    expect(db.query.fontAssets.findMany).toHaveBeenCalled();
  });

  it("loadProjectFonts surfaces DB errors", async () => {
    vi.mocked(db.query.fontAssets.findMany).mockRejectedValue(
      new Error("relation font_assets does not exist")
    );
    const state = createProjectState([], undefined, { projectId: "p1" });
    const { fonts, error } = await loadProjectFonts(state);
    expect(fonts).toEqual([]);
    expect(error).toMatch(/Database error/);
  });

  it("set_text_font applies google fontId", async () => {
    const state = createProjectState([textTrack()]);
    const { result, state: next } = await fontsToolExecutors.set_text_font!(
      { clipId: "text-1", fontId: "google:Bebas Neue" },
      state
    );
    expect(result).toContain("Bebas Neue");
    const clip = next.tracks[0]!.clips[0]!;
    expect(clip.textParams?.fontId).toBe("google:Bebas Neue");
    expect(clip.textParams?.fontFamily).toContain("Bebas Neue");
  });

  it("set_text_font applies uploaded font from DB", async () => {
    vi.mocked(db.query.fontAssets.findMany).mockResolvedValue([
      {
        id: "font-upload-1",
        projectId: "p1",
        userId: "u1",
        familyName: "BrandDisplay",
        fileName: "BrandDisplay.otf",
        url: "/uploads/fonts/BrandDisplay.otf",
        format: "opentype",
        createdAt: new Date(),
      },
    ] as any);

    const state = createProjectState([textTrack()], undefined, {
      projectId: "p1",
    });
    const { state: next } = await fontsToolExecutors.set_text_font!(
      { clipId: "text-1", fontId: "font-upload-1" },
      state
    );
    expect(next.tracks[0]!.clips[0]!.textParams?.fontId).toBe("font-upload-1");
    expect(next.tracks[0]!.clips[0]!.textParams?.fontFamily).toContain(
      "BrandDisplay"
    );
  });

  it("set_text_font rejects unknown fontId", async () => {
    const state = createProjectState([textTrack()]);
    const { result } = await fontsToolExecutors.set_text_font!(
      { clipId: "text-1", fontId: "google:NotARealFont" },
      state
    );
    expect(result).toMatch(/Unknown fontId/i);
  });
});
