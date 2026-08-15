import { describe, expect, it } from "vitest";
import type { MediaAsset, Track } from "@tempo/types";
import { captionsToolExecutors } from "./captions.tool.js";
import { createProjectState } from "./index.js";

function audioAsset(partial?: Partial<MediaAsset>): MediaAsset {
  return {
    id: "a1",
    projectId: "p1",
    name: "song.mp3",
    type: "audio",
    url: "/uploads/media/song.mp3",
    thumbnailUrl: null,
    proxyUrl: null,
    waveformUrl: null,
    duration: 12,
    status: "ready",
    createdAt: new Date().toISOString(),
    metadata: {
      fileSize: 1000,
      mimeType: "audio/mpeg",
      analysisStatus: "ready",
      audioAnalysisStatus: "ready",
      audioRhythm: {
        bpm: 120,
        beats: [
          { time: 0, strength: 1, isDownbeat: true },
          { time: 0.5, strength: 0.6, isDownbeat: false },
          { time: 1, strength: 0.9, isDownbeat: true },
          { time: 1.5, strength: 0.5, isDownbeat: false },
          { time: 2, strength: 0.9, isDownbeat: true },
        ],
        energyCurve: [],
        analyzedAt: new Date().toISOString(),
        model: "tempo-onset-v1",
      },
      audioTranscript: {
        schemaVersion: 2,
        revision: "rev-1",
        pipeline: "lyrics",
        kind: "singing",
        language: "en",
        summary: "Pop chorus",
        words: [
          { id: "w0", start: 0.2, end: 0.6, text: "Hidden" },
          { id: "w1", start: 1.2, end: 1.6, text: "Hello" },
          { id: "w2", start: 1.7, end: 2.1, text: "world." },
          { id: "w3", start: 3.2, end: 3.6, text: "Sing" },
          { id: "w4", start: 3.7, end: 4.1, text: "along." },
        ],
        segments: [
          { id: "s0", start: 0.2, end: 2.1, text: "Hidden Hello world.", wordIds: ["w0", "w1", "w2"] },
          { id: "s1", start: 3.2, end: 4.1, text: "Sing along.", wordIds: ["w3", "w4"] },
        ],
        sourceDuration: 12,
        model: "whisper-1",
        analyzedAt: new Date().toISOString(),
      },
    },
    ...partial,
  };
}

function audioTrack(overrides: Partial<Track["clips"][number]> = {}): Track {
  return {
    id: "audio-track",
    name: "Music",
    type: "audio",
    order: 0,
    locked: false,
    visible: true,
    solo: false,
    clips: [
      {
        id: "source-clip",
        trackId: "audio-track",
        sourceMediaId: "a1",
        startTime: 10,
        duration: 2,
        sourceOffset: 1,
        speed: 2,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 },
        opacity: 1,
        blendMode: "normal",
        effects: [],
        keyframes: [],
        mask: null,
        muted: false,
        volume: 1,
        ...overrides,
      },
    ],
  };
}

describe("caption timeline tools", () => {
  it("lists exact source and timeline ranges", async () => {
    const state = createProjectState([audioTrack()], undefined, { mediaAssets: [audioAsset()] });
    const { result } = await captionsToolExecutors.list_caption_sources!({}, state);
    const parsed = JSON.parse(result);
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0].sourceClipId).toBe("source-clip");
    expect(parsed.sources[0].sourceRange).toEqual([1, 5]);
    expect(parsed.sources[0].timelineRange).toEqual([10, 12]);
  });

  it("maps word transcript through sourceOffset and speed", async () => {
    const state = createProjectState([audioTrack()], undefined, { mediaAssets: [audioAsset()] });
    const { result } = await captionsToolExecutors.get_clip_transcript!(
      { sourceClipId: "source-clip", granularity: "word" },
      state
    );
    const parsed = JSON.parse(result);
    expect(parsed.total).toBe(4);
    expect(parsed.items[0].text).toBe("Hello");
    expect(parsed.items[0].timeline).toEqual([10.1, 10.3]);
    expect(parsed.items[3].timeline).toEqual([11.35, 11.55]);
  });

  it("creates clip-bound karaoke captions with provenance", async () => {
    const state = createProjectState([audioTrack()], undefined, { mediaAssets: [audioAsset()] });
    const { result, state: next } = await captionsToolExecutors.create_captions_for_clip!(
      { sourceClipId: "source-clip", style: "karaoke" },
      state
    );
    const parsed = JSON.parse(result);
    expect(parsed.created).toBe(2);
    expect(parsed.coverageComplete).toBe(true);

    const captions = next.tracks.find((track) => track.type === "text")!.clips;
    expect(captions[0]!.startTime).toBeCloseTo(10.1, 8);
    expect(captions[0]!.duration).toBeCloseTo(0.45, 8);
    expect(captions[0]!.textParams?.text).toBe("Hello world.");
    expect(captions[0]!.textParams?.karaokeWords).toHaveLength(2);
    expect(captions[0]!.captionBinding).toMatchObject({
      sourceClipId: "source-clip",
      sourceMediaId: "a1",
      transcriptRevision: "rev-1",
      wordIds: ["w1", "w2"],
    });
  });

  it("applies a reusable animated caption look without changing timing", async () => {
    const state = createProjectState([audioTrack()], undefined, { mediaAssets: [audioAsset()] });
    await captionsToolExecutors.create_captions_for_clip!({ sourceClipId: "source-clip", style: "minimal" }, state);
    const before = state.tracks.find((track) => track.type === "text")!.clips.map((clip) => [clip.startTime, clip.duration]);
    const { result } = await captionsToolExecutors.apply_caption_preset!({ presetId: "social-pop", sourceClipId: "source-clip" }, state);
    expect(JSON.parse(result)).toMatchObject({ ok: true, presetId: "social-pop", updated: 2 });
    const captions = state.tracks.find((track) => track.type === "text")!.clips;
    expect(captions[0]!.textParams).toMatchObject({ captionPresetId: "social-pop", split: "word" });
    expect(captions.map((clip) => [clip.startTime, clip.duration])).toEqual(before);
  });

  it("validates generated captions against their source", async () => {
    const state = createProjectState([audioTrack()], undefined, { mediaAssets: [audioAsset()] });
    await captionsToolExecutors.create_captions_for_clip!(
      { sourceClipId: "source-clip" },
      state
    );
    const { result } = await captionsToolExecutors.validate_caption_sync!(
      { sourceClipId: "source-clip" },
      state
    );
    expect(JSON.parse(result)).toMatchObject({ ok: true, checked: 2, valid: 2, issueCount: 0 });
  });

  it("detects a timing mismatch", async () => {
    const state = createProjectState([audioTrack()], undefined, { mediaAssets: [audioAsset()] });
    await captionsToolExecutors.create_captions_for_clip!(
      { sourceClipId: "source-clip" },
      state
    );
    const caption = state.tracks.find((track) => track.type === "text")!.clips[0]!;
    caption.startTime += 0.2;
    const { result } = await captionsToolExecutors.validate_caption_sync!(
      { sourceClipId: "source-clip" },
      state
    );
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues[0].code).toBe("timing_mismatch");
  });

  it("refuses instrumental media", async () => {
    const instrumental = audioAsset({
      metadata: {
        fileSize: 1,
        mimeType: "audio/mpeg",
        audioAnalysisStatus: "ready",
        audioTranscript: {
          kind: "music_instrumental",
          summary: "drums only",
          segments: [],
          model: "test",
          analyzedAt: new Date().toISOString(),
        },
      },
    });
    const state = createProjectState([audioTrack()], undefined, { mediaAssets: [instrumental] });
    const { result } = await captionsToolExecutors.create_captions_for_clip!(
      { sourceClipId: "source-clip" },
      state
    );
    expect(result).toMatch(/Error: No captionable/);
  });

  it("rejects ambiguous deprecated mediaId timing", async () => {
    const duplicateTrack = audioTrack();
    duplicateTrack.clips.push({ ...duplicateTrack.clips[0]!, id: "source-clip-2", startTime: 20 });
    const state = createProjectState([duplicateTrack], undefined, { mediaAssets: [audioAsset()] });
    const { result } = await captionsToolExecutors.create_captions_from_transcript!(
      { mediaId: "a1", timeOffset: 3 },
      state
    );
    expect(result).toMatch(/ambiguous and unsafe/);
  });

  it("returns source transcript facts with word precision", async () => {
    const state = createProjectState([audioTrack()], undefined, { mediaAssets: [audioAsset()] });
    const { result, state: next } = await captionsToolExecutors.get_audio_timeline!(
      { mediaId: "a1" },
      state
    );
    const parsed = JSON.parse(result);
    expect(parsed.transcript.schemaVersion).toBe(2);
    expect(parsed.transcript.wordCount).toBe(5);
    expect(next.beatTimes?.length).toBeGreaterThan(0);
  });

  it("distinguishes a missing transcript from a real no-match", async () => {
    const missing = audioAsset({
      metadata: { fileSize: 1, mimeType: "audio/mpeg" },
    });
    const state = createProjectState([], undefined, { mediaAssets: [missing] });
    const { result } = await captionsToolExecutors.search_transcript!(
      { mediaId: "a1", query: "ballu" },
      state
    );
    expect(result).toMatch(/Error: .*no transcript metadata/);
  });
});
