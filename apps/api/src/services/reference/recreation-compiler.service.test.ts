import { describe, expect, it } from "vitest";
import type {
  EditBlueprint,
  MediaAsset,
  ProjectSettings,
  Track,
} from "@tempo/types";
import type { AssetMapping } from "./asset-matching.service.js";
import { getDeliveryProfile } from "@tempo/editor-core";
import {
  compileRecreationDraft,
  inferredTextFontSize,
  settingsForReference,
  validateRecreationConformance,
} from "./recreation-compiler.service.js";

const settings: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 0,
  backgroundColor: "#000000",
  sampleRate: 44100,
};

function blueprint(overrides: Partial<EditBlueprint> = {}): EditBlueprint {
  return {
    id: "blueprint-1",
    referenceUrl: "https://www.youtube.com/shorts/example",
    totalDuration: 4,
    aspectRatio: "1080:1920",
    referenceWidth: 1080,
    referenceHeight: 1920,
    segments: [
      {
        index: 0,
        startTime: 0,
        duration: 2,
        shotType: "close-up",
        motionType: "tracking",
        transitionToNext: "cut",
        energyLevel: 70,
        visualDescription: "A person enters frame",
        colorPalette: ["#111111", "#ffffff"],
        effects: [],
        textOverlays: [
          {
            text: "START NOW",
            style: "bold",
            position: "custom",
            animation: "slide-up",
            appearance: {
              fontFamilyClass: "display",
              fontWeight: 900,
              fontSizeRatio: 0.07,
              color: "#F6C744",
              strokeColor: "#321000",
              strokeWidthRatio: 0.04,
              backgroundColor: "#000000",
              backgroundOpacity: 0.6,
              textAlign: "left",
              letterSpacingRatio: 0.05,
              shadow: true,
              rotation: -4,
            },
            geometry: { x: 0.42, y: 0.3, width: 0.58, height: 0.12, confidence: 0.9 },
          },
        ],
        onBeat: true,
        speed: 1,
      },
      {
        index: 1,
        startTime: 2,
        duration: 2,
        shotType: "wide",
        motionType: "static",
        transitionToNext: "none",
        energyLevel: 45,
        visualDescription: "Product beauty shot",
        colorPalette: ["#222222"],
        effects: [],
        textOverlays: [],
        onBeat: false,
        speed: 1,
      },
    ],
    audioAnalysis: {
      bpm: 0,
      beats: [],
      energyCurve: [],
      mood: "calm",
      genre: "unknown",
      beatSource: "unavailable",
      beatConfidence: 0,
    },
    overallStyle: {
      colorGrading: "neutral",
      pacing: "moderate",
      mood: "calm",
      genre: "unknown",
    },
    createdAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

function media(id: string, duration = 12): MediaAsset {
  return {
    id,
    projectId: "project-1",
    name: `${id}.mp4`,
    type: "video",
    url: `/uploads/${id}.mp4`,
    thumbnailUrl: null,
    proxyUrl: null,
    waveformUrl: null,
    duration,
    status: "ready",
    metadata: { fileSize: 1000, mimeType: "video/mp4", width: 1080, height: 1920 },
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

function music(id: string, duration = 12): MediaAsset {
  return {
    ...media(id, duration),
    name: `${id}.wav`,
    type: "audio",
    url: `/uploads/${id}.wav`,
    metadata: {
      fileSize: 1000,
      mimeType: "audio/wav",
      audioRhythm: {
        bpm: 120,
        beats: [],
        energyCurve: [],
        analyzedAt: "2026-08-11T00:00:00.000Z",
        model: "fixture",
      },
    },
  };
}

const mappings: AssetMapping[] = [
  { segmentIndex: 0, assetId: "asset-a", assetName: "asset-a.mp4", inPoint: 1, duration: 2, confidence: 0.9 },
  { segmentIndex: 1, assetId: "asset-b", assetName: "asset-b.mp4", inPoint: 2, duration: 2, confidence: 0.8 },
];

describe("Edit Like This recreation compiler", () => {
  it("fits text to measured glyph geometry when fontSizeRatio is absent", () => {
    const size = inferredTextFontSize({
      text: "MOUNTAIN",
      style: "kinetic",
      position: "center",
      animation: "measured",
      geometry: { x: 0.5, y: 0.5, width: 0.64, height: 0.16 },
      appearance: { fontWidth: "condensed", uppercase: true },
    }, settings);
    expect(size).toBeGreaterThan(140);
    expect(size).toBeLessThan(180);
  });

  it("preserves the user-selected delivery profile and dimensions", () => {
    const reel = getDeliveryProfile("instagram-reel")!;
    const selected = { ...settings, width: reel.width, height: reel.height, deliveryProfile: reel };
    const resolved = settingsForReference(selected, blueprint());
    expect(resolved.width).toBe(1080);
    expect(resolved.height).toBe(1920);
    expect(resolved.deliveryProfile?.id).toBe("instagram-reel");
    expect(resolved.duration).toBe(4);
  });

  it("keeps an Instagram Reel contract throughout reference compilation", async () => {
    const reel = getDeliveryProfile("instagram-reel")!;
    const selected = { ...settings, width: reel.width, height: reel.height, deliveryProfile: reel };
    const draft = await compileRecreationDraft(
      { id: "project-1", name: "Reel", settings: selected, tracks: [] },
      [media("asset-a"), media("asset-b")],
      blueprint(),
      mappings
    );
    expect(draft.settings).toMatchObject({ width: 1080, height: 1920 });
    expect(draft.settings.deliveryProfile?.id).toBe("instagram-reel");
    expect(draft.warnings.some((warning) => warning.includes("Reflowed"))).toBe(false);
  });

  it("assembles every mapped segment and text overlay with durable geometry", async () => {
    const existingTrack: Track = {
      id: "existing",
      name: "User notes",
      type: "shape",
      order: 0,
      locked: false,
      visible: true,
      solo: false,
      clips: [],
    };
    const draft = await compileRecreationDraft(
      {
        id: "project-1",
        name: "Test",
        settings,
        tracks: [existingTrack],
        transitions: [],
      },
      [media("asset-a"), media("asset-b")],
      blueprint(),
      mappings
    );

    expect(draft.state.tracks.some((track) => track.id === "existing")).toBe(true);
    expect(draft.manifest.entries.filter((entry) => entry.binding.kind === "segment")).toHaveLength(2);
    expect(draft.manifest.entries.filter((entry) => entry.binding.kind === "text-overlay")).toHaveLength(1);
    const segmentClips = draft.state.tracks.flatMap((track) => track.clips).filter((clip) => clip.referenceEditBinding?.kind === "segment");
    expect(segmentClips.every((clip) => clip.mediaLayout?.fit === "cover")).toBe(true);
    const textClip = draft.state.tracks.flatMap((track) => track.clips).find((clip) => clip.referenceEditBinding?.kind === "text-overlay");
    expect(textClip?.layout).toMatchObject({ mode: "normalized", x: 0.42, y: 0.3 });
    expect(textClip?.textParams).toMatchObject({
      fontFamily: '"Bebas Neue", sans-serif',
      fontId: "google:Bebas Neue",
      fontWeight: "900",
      color: "#F6C744",
      stroke: "#321000",
      textAlign: "left",
      backgroundColor: "rgba(0, 0, 0, 0.6)",
    });
    expect(textClip?.textParams?.fontSize).toBe(76);
    expect(textClip?.transform.rotation).toBe(-4);

    const report = validateRecreationConformance(
      {
        tracks: draft.state.tracks,
        transitions: draft.state.transitions,
        sequences: draft.state.sequences,
        mediaAssets: draft.state.mediaAssets,
        settings: draft.settings,
        audioMixer: draft.state.audioMixer,
      },
      blueprint(),
      draft.manifest
    );
    expect(report.ok).toBe(true);
    expect(report.checkedSegments).toBe(2);
    expect(report.checkedTextOverlays).toBe(1);

    textClip!.textParams!.text = "A paraphrased title";
    const changedTextReport = validateRecreationConformance(
      {
        tracks: draft.state.tracks,
        transitions: draft.state.transitions,
        sequences: draft.state.sequences,
        mediaAssets: draft.state.mediaAssets,
        settings: draft.settings,
        audioMixer: draft.state.audioMixer,
      },
      blueprint(),
      draft.manifest
    );
    expect(changedTextReport.ok).toBe(false);
    expect(changedTextReport.issues.some((issue) => issue.code === "text_transcription_mismatch")).toBe(true);
  });

  it("slows a mapped clip instead of consuming beyond its source", async () => {
    const shortBlueprint = blueprint({
      segments: [{ ...blueprint().segments[0]!, duration: 4, speed: 2, textOverlays: [] }],
      totalDuration: 4,
    });
    const draft = await compileRecreationDraft(
      { id: "project-1", name: "Test", settings, tracks: [] },
      [media("asset-a", 5)],
      shortBlueprint,
      [{ ...mappings[0]!, inPoint: 1, duration: 4 }]
    );
    const clip = draft.state.tracks.flatMap((track) => track.clips).find((item) => item.referenceEditBinding?.kind === "segment")!;
    expect(clip.speed).toBe(1);
    expect(draft.warnings[0]).toContain("speed changed");
  });

  it("persists safe blueprint transitions and a user-provided music bed", async () => {
    const withFade = blueprint({
      segments: [
        { ...blueprint().segments[0]!, transitionToNext: "fade", textOverlays: [] },
        blueprint().segments[1]!,
      ],
      audioAnalysis: {
        ...blueprint().audioAnalysis,
        bpm: 120,
        beatSource: "detected",
        beatConfidence: 0.8,
      },
    });
    const draft = await compileRecreationDraft(
      { id: "project-1", name: "Test", settings, tracks: [] },
      [media("asset-a"), media("asset-b"), music("music-a")],
      withFade,
      mappings,
      {
        policy: {
          soundtrack: "uploaded",
          sourceAudio: "mute",
          uploadedAudioAssetId: "music-a",
          soundtrackVolume: 0.85,
          sourceVolume: 1,
          duckLevel: 0.25,
        },
        soundtrackAssetId: "music-a",
      }
    );
    expect(draft.state.transitions).toHaveLength(1);
    expect(draft.state.transitions?.[0]).toMatchObject({ type: "crossfade" });
    expect(draft.manifest.musicTrackId).toBeTruthy();
    expect(draft.manifest.entries.some((entry) => entry.binding.kind === "music-bed")).toBe(true);
    const report = validateRecreationConformance(
      {
        tracks: draft.state.tracks,
        transitions: draft.state.transitions,
        sequences: draft.state.sequences,
        mediaAssets: draft.state.mediaAssets,
        settings: draft.settings,
        audioMixer: draft.state.audioMixer,
      },
      withFade,
      draft.manifest
    );
    expect(report.ok).toBe(true);
  });

  it("fails conformance when a generated segment is removed", async () => {
    const draft = await compileRecreationDraft(
      { id: "project-1", name: "Test", settings, tracks: [] },
      [media("asset-a"), media("asset-b")],
      blueprint(),
      mappings
    );
    const missingId = draft.manifest.entries.find((entry) => entry.binding.kind === "segment")!.clipId;
    for (const track of draft.state.tracks) {
      track.clips = track.clips.filter((clip) => clip.id !== missingId);
    }
    const report = validateRecreationConformance(
      {
        tracks: draft.state.tracks,
        transitions: draft.state.transitions,
        sequences: draft.state.sequences,
        mediaAssets: draft.state.mediaAssets,
        settings: draft.settings,
        audioMixer: draft.state.audioMixer,
      },
      blueprint(),
      draft.manifest
    );
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "missing_generated_clip")).toBe(true);
  });

  it("binds reference audio, mutes source footage, and rejects policy drift", async () => {
    const draft = await compileRecreationDraft(
      { id: "project-1", name: "Test", settings, tracks: [] },
      [media("asset-a"), media("asset-b"), music("reference-audio")],
      blueprint(),
      mappings,
      {
        policy: {
          soundtrack: "reference",
          sourceAudio: "mute",
          referenceAudioAuthorized: true,
          soundtrackVolume: 0.85,
          sourceVolume: 1,
          duckLevel: 0.25,
        },
        soundtrackAssetId: "reference-audio",
      }
    );
    const segments = draft.state.tracks.flatMap((track) => track.clips)
      .filter((clip) => clip.referenceEditBinding?.kind === "segment");
    expect(segments.every((clip) => clip.muted && clip.volume === 0)).toBe(true);
    expect(draft.manifest.soundtrackAssetId).toBe("reference-audio");

    segments[0]!.muted = false;
    const report = validateRecreationConformance(
      {
        tracks: draft.state.tracks,
        transitions: draft.state.transitions,
        sequences: draft.state.sequences,
        mediaAssets: draft.state.mediaAssets,
        settings: draft.settings,
        audioMixer: draft.state.audioMixer,
      },
      blueprint(),
      draft.manifest
    );
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "AUDIO_POLICY_SOURCE_MUTE_CHANGED")).toBe(true);
  });

  it("configures source dialogue to sidechain-duck the soundtrack", async () => {
    const draft = await compileRecreationDraft(
      { id: "project-1", name: "Test", settings, tracks: [] },
      [media("asset-a"), media("asset-b"), music("reference-audio")],
      blueprint(),
      mappings,
      {
        policy: {
          soundtrack: "reference",
          sourceAudio: "duck",
          referenceAudioAuthorized: true,
          soundtrackVolume: 0.85,
          sourceVolume: 0.9,
          duckLevel: 0.2,
        },
        soundtrackAssetId: "reference-audio",
      }
    );
    expect(draft.state.audioMixer.trackRoles?.[draft.manifest.videoTrackId]).toBe("voice");
    expect(draft.state.audioMixer.trackRoles?.[draft.manifest.musicTrackId!]).toBe("music");
    expect(draft.state.audioMixer.duck).toMatchObject({ enabled: true, mode: "sidechain", level: 0.2 });
  });

  it("renders exclusive word states as separate clips over full-frame title cards", async () => {
    const wordBlueprint = blueprint();
    wordBlueprint.segments[0]!.textOverlays = ["ballu", "tumahri", "jail", "se", "pharar"].map(
      (text, index) => ({
        text,
        style: "bold" as const,
        position: "center" as const,
        animation: "none",
        sequenceMode: "exclusive" as const,
        sequenceGroupId: "escape-line",
        backgroundMode: "full-frame" as const,
        appearance: {
          fontFamilyClass: "display" as const,
          fontFamilyHint: "Bebas Neue",
          fontWidth: "condensed" as const,
          color: "#FFFFFF",
          backgroundColor: "#000000",
          backgroundOpacity: 1,
          textAlign: "center" as const,
        },
        timing: {
          startRatio: index / 5,
          endRatio: (index + 1) / 5,
        },
      })
    );
    const draft = await compileRecreationDraft(
      { id: "project-1", name: "Test", settings, tracks: [] },
      [media("asset-a"), media("asset-b")],
      wordBlueprint,
      mappings
    );
    const textClips = draft.state.tracks.find((track) => track.name === "Reference Text")!.clips;
    const cards = draft.state.tracks.find((track) => track.name === "Reference Title Cards")!.clips;
    expect(textClips.map((clip) => clip.textParams?.text)).toEqual(["ballu", "tumahri", "jail", "se", "pharar"]);
    expect(cards).toHaveLength(5);
    expect(textClips.every((clip) => clip.textParams?.fontId === "google:Bebas Neue")).toBe(true);
    for (let index = 0; index < textClips.length - 1; index++) {
      expect(textClips[index]!.startTime + textClips[index]!.duration)
        .toBeCloseTo(textClips[index + 1]!.startTime, 5);
    }
  });

  it("compiles measured media-filled text and four independently animated panels", async () => {
    const complex = blueprint({
      totalDuration: 4,
      segments: [{
        ...blueprint().segments[0]!,
        duration: 4,
        visualDescription: "MOUNTAIN matte reveal followed by a staggered four-panel collage",
        textOverlays: [{
          text: "MOUNTAIN",
          style: "kinetic",
          position: "center",
          animation: "custom character reveal",
          fillMode: "media-matte",
          appearance: { fontFamilyClass: "display", fontWeight: 900, fontSizeRatio: 0.12, color: "#FFFFFF" },
          timing: { startRatio: 0, endRatio: 1 },
          animationSpec: {
            unit: "char",
            channels: [{
              property: "opacity",
              from: 0,
              to: 1,
              offsetRatio: 0.04,
              durationRatio: 0.08,
              staggerRatio: 0.045,
              easing: "linear",
            }],
            confidence: 0.96,
          },
        }],
        composition: {
          replaceBase: true,
          backgroundColor: "#000000",
          confidence: 0.96,
          layers: [
            {
              id: "mountain-fill",
              role: "matte-fill",
              contentDescription: "mountain footage moving inside the word",
              zIndex: 0,
              timing: { startRatio: 0, endRatio: 1 },
              viewport: { x: 0, y: 0, width: 1, height: 1 },
              fit: "cover",
              matteTextOverlayIndex: 0,
            },
            ...[
              { id: "top-left", viewport: { x: 0, y: 0, width: 0.5, height: 0.5 }, delay: 0.45 },
              { id: "top-right", viewport: { x: 0.5, y: 0, width: 0.5, height: 0.5 }, delay: 0.5 },
              { id: "bottom-left", viewport: { x: 0, y: 0.5, width: 0.5, height: 0.5 }, delay: 0.55 },
              { id: "bottom-right", viewport: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, delay: 0.6 },
            ].map((panel, index) => ({
              id: panel.id,
              role: "panel" as const,
              contentDescription: `${panel.id} landscape shot`,
              zIndex: index + 1,
              timing: { startRatio: panel.delay, endRatio: 1 },
              viewport: panel.viewport,
              fit: "cover" as const,
              motion: {
                keyframes: [
                  { timeRatio: 0, viewport: { ...panel.viewport, width: 0.01 }, opacity: 0, easing: "ease-out" as const },
                  { timeRatio: 0.22, viewport: panel.viewport, opacity: 1, easing: "ease-out" as const },
                ],
                confidence: 0.92,
              },
            })),
          ],
        },
      }],
    });
    const layerIds = complex.segments[0]!.composition!.layers.map((layer) => layer.id);
    const layerMappings: AssetMapping[] = layerIds.map((layerId, index) => ({
      segmentIndex: 0,
      layerId,
      role: complex.segments[0]!.composition!.layers[index]!.role,
      assetId: index % 2 === 0 ? "asset-a" : "asset-b",
      assetName: index % 2 === 0 ? "asset-a.mp4" : "asset-b.mp4",
      inPoint: index,
      duration: 4,
      confidence: 0.9,
    }));
    const draft = await compileRecreationDraft(
      { id: "project-1", name: "Complex", settings, tracks: [] },
      [media("asset-a"), media("asset-b")],
      complex,
      layerMappings
    );

    const layers = draft.state.tracks.flatMap((track) => track.clips)
      .filter((clip) => clip.referenceEditBinding?.kind === "composition-layer");
    expect(layers).toHaveLength(5);
    expect(draft.manifest.entries.filter((entry) => entry.binding.kind === "segment")).toHaveLength(0);
    const text = draft.state.tracks.flatMap((track) => track.clips)
      .find((clip) => clip.referenceEditBinding?.kind === "text-overlay")!;
    expect(text.textParams?.split).toBe("char");
    expect(text.textParams?.animators).toEqual([expect.objectContaining({
      property: "opacity",
      from: 0,
      to: 1,
      staggerSec: 0.18,
    })]);
    expect(text.keyframes.some((keyframe) => keyframe.property.startsWith("transform."))).toBe(false);
    const matte = layers.find((clip) => clip.referenceEditBinding?.layerId === "mountain-fill")!;
    expect(matte.trackMatte).toEqual({ sourceClipId: text.id, type: "alpha" });
    const panel = layers.find((clip) => clip.referenceEditBinding?.layerId === "top-left")!;
    expect(panel.mediaLayout).toMatchObject({
      fit: "cover",
      viewport: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
    expect(panel.keyframes.some((keyframe) => keyframe.property === "mediaLayout.viewport.width")).toBe(true);
    expect(panel.mediaLayout?.fit).not.toBe("fill");
    const trackOrderFor = (clipId: string) => draft.state.tracks.find((track) =>
      track.clips.some((clip) => clip.id === clipId)
    )!.order;
    expect(trackOrderFor(panel.id)).toBeGreaterThan(trackOrderFor(text.id));
    expect(trackOrderFor(text.id)).toBe(trackOrderFor(matte.id));
  });

  it("preserves phase lifetimes without stretching authored text motion and resolves impact anchors", async () => {
    const advanced = blueprint({
      totalDuration: 4,
      audioAnalysis: {
        ...blueprint().audioAnalysis,
        impacts: [
          { id: "letter-0", time: 0.2, strength: 0.8, isDownbeat: false, kind: "onset" },
          { id: "letter-1", time: 0.45, strength: 0.9, isDownbeat: false, kind: "onset" },
          { id: "letter-2", time: 0.7, strength: 1, isDownbeat: false, kind: "onset" },
          { id: "title-hit", time: 2.5, strength: 1, isDownbeat: false, kind: "onset" },
        ],
      },
      segments: [{
        ...blueprint().segments[0]!,
        duration: 4,
        textOverlays: [{
          text: "MOUNT",
          style: "kinetic",
          position: "center",
          animation: "measured",
          timing: { startRatio: 0, endRatio: 0.25 },
          appearance: { fontFamilyClass: "display", fontWeight: 900, fontSizeRatio: 0.12, color: "#FFFFFF" },
          animationSpec: {
            unit: "char",
            channels: [{
              property: "opacity",
              from: 0,
              to: 1,
              offsetRatio: 0,
              durationRatio: 0.01,
              staggerRatio: 0,
              unitSyncEventIds: ["letter-0", "letter-1", "letter-2"],
              keyframes: [
                { timeRatio: 0, value: 0 },
                { timeRatio: 0.01, value: 1, easing: "hold" },
              ],
              easing: "hold",
            }],
            motion: { keyframes: [
              { timeRatio: 0, scaleX: 1, scaleY: 1 },
              { timeRatio: 1, syncEventId: "title-hit", scaleX: 1.5, scaleY: 1.5, easing: "hold" },
            ] },
          },
        }],
        composition: {
          replaceBase: true,
          backgroundColor: "#000000",
          layers: [{
            id: "matte-fill",
            role: "matte-fill",
            contentDescription: "moving mountain fill",
            zIndex: 0,
            timing: { startRatio: 0, endRatio: 0.25 },
            viewport: { x: 0, y: 0, width: 1, height: 1 },
            fit: "cover",
            matteTextOverlayIndex: 0,
          }],
          phases: [
            { id: "reveal", label: "character reveal", startRatio: 0, endRatio: 0.5, activeLayerIds: ["matte-fill"], activeTextOverlayIndices: [0] },
            { id: "impact", label: "title persists over next layout", startRatio: 0.5, endRatio: 1, syncEventId: "title-hit", activeLayerIds: ["matte-fill"], activeTextOverlayIndices: [0] },
          ],
        },
      }],
    });
    const draft = await compileRecreationDraft(
      { id: "project-1", name: "Advanced", settings, tracks: [] },
      [media("asset-a")],
      advanced,
      [{ segmentIndex: 0, layerId: "matte-fill", role: "matte-fill", assetId: "asset-a", assetName: "asset-a.mp4", inPoint: 0, duration: 4, confidence: 1 }]
    );
    const clips = draft.state.tracks.flatMap((track) => track.clips);
    const text = clips.find((clip) => clip.referenceEditBinding?.kind === "text-overlay")!;
    const matte = clips.find((clip) => clip.referenceEditBinding?.layerId === "matte-fill")!;
    expect(text.duration).toBe(4);
    expect(matte.duration).toBe(4);
    expect(text.textParams?.animators?.[0]?.unitStartTimes).toEqual([0.2, 0.45, 0.7]);
    expect(text.textParams?.animators?.[0]?.valueKeyframes?.[1]?.timeSec).toBeCloseTo(0.01);
    const titleScale = text.keyframes.find((keyframe) => keyframe.property === "transform.scaleX" && keyframe.value === 1.5);
    expect(titleScale).toMatchObject({ time: 2.5, easing: "hold" });
    expect(matte.keyframes.filter((keyframe) => keyframe.property === "opacity" && keyframe.value === 0)).toHaveLength(0);
  });

  it("keeps exclusive word captions at authored times inside a broad composition phase", async () => {
    const exclusive = blueprint({
      totalDuration: 4,
      segments: [{
        ...blueprint().segments[0]!,
        duration: 4,
        textOverlays: [
          {
            text: "first", style: "bold", position: "center", animation: "static",
            timing: { startRatio: 0.1, endRatio: 0.2 }, sequenceMode: "exclusive", sequenceGroupId: "captions",
            appearance: { fontSizeRatio: 0.08 }, zIndex: 10,
          },
          {
            text: "second", style: "bold", position: "center", animation: "static",
            timing: { startRatio: 0.25, endRatio: 0.35 }, sequenceMode: "exclusive", sequenceGroupId: "captions",
            appearance: { fontSizeRatio: 0.08 }, zIndex: 10,
          },
        ],
        composition: {
          replaceBase: false,
          layers: [],
          phases: [{
            id: "broad", label: "caption scene", startRatio: 0, endRatio: 1,
            activeLayerIds: [], activeTextOverlayIndices: [0, 1],
          }],
        },
      }],
    });
    const draft = await compileRecreationDraft(
      { id: "project-1", name: "Exclusive captions", settings, tracks: [] },
      [media("asset-a")],
      exclusive,
      [{ segmentIndex: 0, assetId: "asset-a", assetName: "asset-a.mp4", inPoint: 0, duration: 4, confidence: 1 }]
    );
    const text = draft.state.tracks.flatMap((track) => track.clips)
      .filter((clip) => clip.referenceEditBinding?.kind === "text-overlay")
      .sort((left, right) => left.startTime - right.startTime);
    expect(text).toHaveLength(2);
    expect(text[0]!.startTime).toBeCloseTo(0.4);
    expect(text[0]!.duration).toBeCloseTo(0.4);
    expect(text[1]!.startTime).toBeCloseTo(1);
    expect(text[1]!.duration).toBeCloseTo(0.4);

    text[1]!.startTime = text[0]!.startTime;
    const report = validateRecreationConformance(draft.state, exclusive, draft.manifest);
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", code: "timeline_overlap_without_transition" }),
    ]));
  });
});
