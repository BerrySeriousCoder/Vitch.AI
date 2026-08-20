import { describe, expect, it } from "vitest";
import type { BlueprintSegment, ProjectSettings } from "@tempo/types";
import { getDeliveryProfile } from "@tempo/editor-core";
import { adaptTextOverlaysForDelivery } from "./reference-layout-adaptation.service.js";

const segment: BlueprintSegment = {
  index: 0, startTime: 0, duration: 2, shotType: "wide", motionType: "static",
  transitionToNext: "cut", energyLevel: 50, visualDescription: "", colorPalette: [], effects: [],
  textOverlays: [
    { text: "LOVE", style: "bold", position: "custom", animation: "static", geometry: { x: 0.28, y: 0.3, width: 0.35, height: 0.12 } },
    { text: "HOW", style: "bold", position: "custom", animation: "static", geometry: { x: 0.7, y: 0.55, width: 0.3, height: 0.12 } },
  ],
  onBeat: false, speed: 1,
};

describe("reference text delivery adaptation", () => {
  it("fits a landscape text group into portrait title-safe bounds without changing topology", () => {
    const profile = getDeliveryProfile("instagram-reel")!;
    const settings: ProjectSettings = { width: profile.width, height: profile.height, fps: 30, duration: 2, backgroundColor: "#000", sampleRate: 44100, deliveryProfile: profile };
    const result = adaptTextOverlaysForDelivery({ referenceWidth: 1920, referenceHeight: 1080, aspectRatio: "16:9" }, segment, settings);
    expect(result.adapted).toBe(true);
    const geometries = result.overlays.map((overlay) => overlay.geometry!);
    expect(geometries[0]!.x).toBeLessThan(geometries[1]!.x);
    for (const geometry of geometries) {
      expect(geometry.x - geometry.width! / 2).toBeGreaterThanOrEqual(profile.titleSafe.x - 0.001);
      expect(geometry.x + geometry.width! / 2).toBeLessThanOrEqual(profile.titleSafe.x + profile.titleSafe.width + 0.001);
      expect(geometry.y - geometry.height! / 2).toBeGreaterThanOrEqual(profile.titleSafe.y - 0.001);
      expect(geometry.y + geometry.height! / 2).toBeLessThanOrEqual(profile.titleSafe.y + profile.titleSafe.height + 0.001);
    }
  });

  it("leaves same-aspect normalized geometry untouched", () => {
    const profile = getDeliveryProfile("youtube-landscape")!;
    const settings: ProjectSettings = { width: profile.width, height: profile.height, fps: 30, duration: 2, backgroundColor: "#000", sampleRate: 44100, deliveryProfile: profile };
    const result = adaptTextOverlaysForDelivery({ referenceWidth: 1920, referenceHeight: 1080, aspectRatio: "16:9" }, segment, settings);
    expect(result.adapted).toBe(false);
    expect(result.overlays).toBe(segment.textOverlays);
  });
});
