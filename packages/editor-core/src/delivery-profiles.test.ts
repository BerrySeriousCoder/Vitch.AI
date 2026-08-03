import { describe, expect, it } from "vitest";
import {
  estimateTextBounds,
  getDeliveryProfile,
  resolveDeliveryProfile,
  resolveGraphicGeometry,
  validateGraphicGeometry,
} from "./delivery-profiles";

describe("delivery profiles and graphic geometry", () => {
  it("resolves a Reel profile from legacy 1080x1920 settings", () => {
    const profile = resolveDeliveryProfile({ width: 1080, height: 1920, fps: 30 });
    expect(profile.id).toBe("instagram-reel");
    expect(profile.orientation).toBe("portrait");
  });

  it("keeps exact absolute geometry under creative-director control", () => {
    const profile = getDeliveryProfile("instagram-reel")!;
    const geometry = resolveGraphicGeometry(
      profile,
      { schemaVersion: 1, mode: "absolute", x: 330, y: 510, width: 420, height: 120, safety: "none", overflow: "allow", source: "agent" },
      { width: 100, height: 40 }
    );
    expect(geometry.centerX).toBe(330);
    expect(geometry.centerY).toBe(510);
    expect(geometry.width).toBe(420);
    expect(geometry.height).toBe(120);
  });

  it("resolves zone layouts responsively and clamps to title safe", () => {
    const profile = getDeliveryProfile("instagram-reel")!;
    const geometry = resolveGraphicGeometry(
      profile,
      { schemaVersion: 1, mode: "zone", zone: "lower-third", alignX: "center", alignY: "end", offsetY: 2, widthRatio: 0.8, safety: "title", overflow: "clamp", source: "template" },
      { width: 900, height: 180 }
    );
    expect(geometry.clamped).toBe(true);
    expect(validateGraphicGeometry(profile, { schemaVersion: 1, mode: "zone", zone: "lower-third", alignX: "center", alignY: "end", offsetY: 2, widthRatio: 0.8, safety: "title", overflow: "clamp" }, geometry).some((issue) => issue.code === "outside_title_safe")).toBe(false);
  });

  it("warns when exact geometry intersects platform UI", () => {
    const profile = getDeliveryProfile("instagram-reel")!;
    const layout = { schemaVersion: 1 as const, mode: "absolute" as const, x: 990, y: 1500, width: 150, height: 400, safety: "none" as const, overflow: "allow" as const };
    const geometry = resolveGraphicGeometry(profile, layout, { width: 150, height: 400 });
    expect(validateGraphicGeometry(profile, layout, geometry).some((issue) => issue.code === "platform_ui_occlusion")).toBe(true);
  });

  it("preserves deliberate overflow as a warning under warn policy", () => {
    const profile = getDeliveryProfile("youtube-landscape")!;
    const layout = {
      schemaVersion: 1 as const,
      mode: "absolute" as const,
      x: -20,
      y: 540,
      width: 300,
      height: 100,
      safety: "none" as const,
      overflow: "warn" as const,
    };
    const geometry = resolveGraphicGeometry(profile, layout, { width: 300, height: 100 });
    expect(validateGraphicGeometry(profile, layout, geometry)).toContainEqual(
      expect.objectContaining({ code: "outside_composition", severity: "warning" })
    );
  });

  it("provides a conservative multiline text estimate", () => {
    const bounds = estimateTextBounds({ text: "A deliberately long social caption", fontSize: 60, lineHeight: 1.1, maxWidth: 400, backgroundPadding: 12 });
    expect(bounds.width).toBeLessThanOrEqual(424);
    expect(bounds.height).toBeGreaterThan(60);
  });
});
