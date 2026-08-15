import { beforeEach, describe, expect, it } from "vitest";
import { useTimelineStore } from "./timeline.store";
import { getTimelineTemporalApi } from "./history.store";

beforeEach(() => {
  useTimelineStore.getState().reset();
  getTimelineTemporalApi().getState().clear?.();
});

function addMediaClip(speed = 1, sourceOffset = 1) {
  const trackId = useTimelineStore.getState().addTrack("Video 1", "video");
  const clipId = useTimelineStore.getState().addClip(trackId, {
    sourceMediaId: "media-1",
    startTime: 2,
    duration: 4,
    sourceOffset,
    speed,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    blendMode: "normal",
    effects: [],
    keyframes: [],
    mask: null,
    muted: false,
    volume: 1,
  });
  return { trackId, clipId };
}

function addCaptionClip(sourceClipId: string, sourceStart: number, sourceEnd: number) {
  const textTrackId = useTimelineStore.getState().tracks.find((t) => t.type === "text")?.id
    || useTimelineStore.getState().addTrack("Captions", "text");
  return useTimelineStore.getState().addClip(textTrackId, {
    sourceMediaId: null,
    startTime: 0,
    duration: sourceEnd - sourceStart,
    sourceOffset: 0,
    speed: 1,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    blendMode: "normal",
    effects: [],
    keyframes: [],
    mask: null,
    muted: false,
    volume: 1,
    captionBinding: {
      sourceClipId,
      sourceMediaId: "media-1",
      transcriptRevision: "revision-1",
      sourceStart,
      sourceEnd,
      wordIds: [],
      generatedTiming: true,
    },
  });
}

function getClip(clipId: string) {
  return useTimelineStore.getState().tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
}

describe("timeline.store", () => {
  it("moves a linked group together and removes transitions tied to the old cut", () => {
    const { trackId, clipId } = addMediaClip();
    const original = getClip(clipId);
    const audioTrackId = useTimelineStore.getState().addTrack("Audio 1", "audio");
    const { id: _id, trackId: _trackId, ...clipData } = original;
    const audioClipId = useTimelineStore.getState().addClip(audioTrackId, { ...clipData });
    const nextClipId = useTimelineStore.getState().addClip(trackId, {
      ...clipData,
      startTime: 6,
      sourceOffset: 5,
    });
    expect(useTimelineStore.getState().linkClips([clipId, audioClipId])).toEqual({ ok: true });
    useTimelineStore.getState().setTransitions([{
      id: "tx-1",
      trackId,
      clipAId: clipId,
      clipBId: nextClipId,
      type: "crossfade",
      duration: 0.25,
      params: {},
    }]);

    useTimelineStore.getState().moveClip(clipId, trackId, 3);

    expect(getClip(clipId).startTime).toBe(3);
    expect(getClip(audioClipId).startTime).toBe(3);
    expect(useTimelineStore.getState().transitions).toEqual([]);
  });

  it("adds and removes tracks", () => {
    const id = useTimelineStore.getState().addTrack("Video 1", "video");
    expect(useTimelineStore.getState().tracks).toHaveLength(1);
    expect(useTimelineStore.getState().tracks[0]!.id).toBe(id);

    useTimelineStore.getState().removeTrack(id);
    expect(useTimelineStore.getState().tracks).toHaveLength(0);
  });

  it("adds a clip to a track", () => {
    const trackId = useTimelineStore.getState().addTrack("Video 1", "video");
    const clipId = useTimelineStore.getState().addClip(trackId, {
      sourceMediaId: "media-1",
      startTime: 0,
      duration: 5,
      sourceOffset: 0,
      speed: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: false,
      volume: 1,
    });

    const track = useTimelineStore.getState().tracks[0]!;
    expect(track.clips).toHaveLength(1);
    expect(track.clips[0]!.id).toBe(clipId);
  });

  it("source insert ripples and overwrite preserves source handles", () => {
    const { trackId, clipId } = addMediaClip(1, 1);
    const inserted = useTimelineStore.getState().sourceEdit(trackId, {
      sourceMediaId: "source-2", startTime: 3, duration: 1, sourceOffset: 0, speed: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, blendMode: "normal", effects: [], keyframes: [], mask: null, muted: false, volume: 1,
    }, "insert");
    expect(inserted.ok).toBe(true);
    const clipsAfterInsert = useTimelineStore.getState().tracks[0]!.clips;
    expect(clipsAfterInsert.find((clip) => clip.id === clipId)?.duration).toBe(1);
    expect(clipsAfterInsert.some((clip) => clip.startTime === 4 && clip.sourceOffset === 2)).toBe(true);
    const overwritten = useTimelineStore.getState().sourceEdit(trackId, {
      sourceMediaId: "source-3", startTime: 2.25, duration: 0.5, sourceOffset: 0, speed: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 }, opacity: 1, blendMode: "normal", effects: [], keyframes: [], mask: null, muted: false, volume: 1,
    }, "overwrite");
    expect(overwritten.ok).toBe(true);
    expect(useTimelineStore.getState().tracks[0]!.clips.some((clip) => clip.id === (overwritten as { clipId: string }).clipId)).toBe(true);
  });

  it("moves, trims, and splits clips", () => {
    const trackId = useTimelineStore.getState().addTrack("Video 1", "video");
    const clipId = useTimelineStore.getState().addClip(trackId, {
      sourceMediaId: null,
      startTime: 0,
      duration: 4,
      sourceOffset: 0,
      speed: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: false,
      volume: 1,
    });

    useTimelineStore.getState().moveClip(clipId, trackId, 2);
    expect(useTimelineStore.getState().tracks[0]!.clips[0]!.startTime).toBe(2);

    useTimelineStore.getState().trimClip(clipId, 2.5, 3);
    expect(useTimelineStore.getState().tracks[0]!.clips[0]!.duration).toBe(3);
    expect(useTimelineStore.getState().tracks[0]!.clips[0]!.sourceOffset).toBe(0);

    const secondId = useTimelineStore.getState().splitClip(clipId, 3.5);
    expect(secondId).toBeTruthy();
    expect(useTimelineStore.getState().tracks[0]!.clips).toHaveLength(2);
  });

  it("advances source offset when trimming left at speed 1", () => {
    const { clipId } = addMediaClip();

    useTimelineStore.getState().trimClip(clipId, 3, 3);

    const clip = useTimelineStore.getState().tracks[0]!.clips[0]!;
    expect(clip.startTime).toBe(3);
    expect(clip.sourceOffset).toBe(2);
  });

  it("advances source offset when trimming left at speed 2", () => {
    const { clipId } = addMediaClip(2);

    useTimelineStore.getState().trimClip(clipId, 3, 3);

    expect(useTimelineStore.getState().tracks[0]!.clips[0]!.sourceOffset).toBe(3);
  });

  it("does not change source offset when trimming right", () => {
    const { clipId } = addMediaClip();

    useTimelineStore.getState().trimClip(clipId, 2, 2);

    expect(useTimelineStore.getState().tracks[0]!.clips[0]!.sourceOffset).toBe(1);
  });

  it("does not allow trim-left to make source offset negative", () => {
    const { clipId } = addMediaClip(2);

    useTimelineStore.getState().trimClip(clipId, 1, 5);

    expect(useTimelineStore.getState().tracks[0]!.clips[0]!.sourceOffset).toBe(0);
  });

  describe("caption bindings", () => {
    it("synchronizes captions when the source clip moves", () => {
      const { trackId, clipId } = addMediaClip();
      const captionId = addCaptionClip(clipId, 2, 3);

      useTimelineStore.getState().moveClip(clipId, trackId, 5);

      const caption = getClip(captionId);
      expect(caption.startTime).toBe(6);
      expect(caption.duration).toBe(1);
      expect(caption.captionBinding?.stale).toBe(false);
    });

    it("synchronizes captions when the source clip is trimmed", () => {
      const { clipId } = addMediaClip();
      const captionId = addCaptionClip(clipId, 2.5, 3.5);

      useTimelineStore.getState().trimClip(clipId, 3, 3);

      const caption = getClip(captionId);
      expect(caption.startTime).toBe(3.5);
      expect(caption.duration).toBe(1);
      expect(caption.captionBinding?.stale).toBe(false);
    });

    it("synchronizes captions when the source clip speed changes", () => {
      const { clipId } = addMediaClip();
      const captionId = addCaptionClip(clipId, 3, 5);

      useTimelineStore.getState().updateClipProperty(clipId, "speed", 2);

      const caption = getClip(captionId);
      expect(caption.startTime).toBe(3);
      expect(caption.duration).toBe(1);
      expect(caption.captionBinding?.stale).toBe(false);
    });

    it("rebinds second-range captions and marks crossing captions stale after split", () => {
      const { clipId } = addMediaClip();
      const firstCaptionId = addCaptionClip(clipId, 1.5, 2.5);
      const secondCaptionId = addCaptionClip(clipId, 3.5, 4.5);
      const crossingCaptionId = addCaptionClip(clipId, 2.5, 3.5);

      const secondClipId = useTimelineStore.getState().splitClip(clipId, 4)!;

      expect(getClip(firstCaptionId).captionBinding?.sourceClipId).toBe(clipId);
      const secondCaption = getClip(secondCaptionId);
      expect(secondCaption.captionBinding?.sourceClipId).toBe(secondClipId);
      expect(secondCaption.startTime).toBe(4.5);
      expect(secondCaption.captionBinding?.stale).toBe(false);
      expect(getClip(crossingCaptionId).captionBinding?.stale).toBe(true);
    });

    it("marks captions stale when their source clip is removed", () => {
      const { clipId } = addMediaClip();
      const captionId = addCaptionClip(clipId, 2, 3);

      useTimelineStore.getState().removeClip(clipId);

      expect(getClip(captionId).captionBinding?.stale).toBe(true);
    });
  });

  it("updates clip properties and nested transform", () => {
    const trackId = useTimelineStore.getState().addTrack("Video 1", "video");
    const clipId = useTimelineStore.getState().addClip(trackId, {
      sourceMediaId: null,
      startTime: 0,
      duration: 2,
      sourceOffset: 0,
      speed: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: false,
      volume: 1,
    });

    useTimelineStore.getState().updateClipProperty(clipId, "opacity", 0.5);
    useTimelineStore.getState().updateClipProperty(clipId, "transform.x", 100);

    const clip = useTimelineStore.getState().tracks[0]!.clips[0]!;
    expect(clip.opacity).toBe(0.5);
    expect(clip.transform.x).toBe(100);
  });

  it("adds and removes keyframes", () => {
    const trackId = useTimelineStore.getState().addTrack("Video 1", "video");
    const clipId = useTimelineStore.getState().addClip(trackId, {
      sourceMediaId: null,
      startTime: 0,
      duration: 2,
      sourceOffset: 0,
      speed: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: false,
      volume: 1,
    });

    useTimelineStore.getState().addKeyframe(clipId, "opacity", 0, 0, "ease-out");
    useTimelineStore.getState().addKeyframe(clipId, "opacity", 1, 1, "ease-out");

    let clip = useTimelineStore.getState().tracks[0]!.clips[0]!;
    expect(clip.keyframes).toHaveLength(2);

    const kfId = clip.keyframes[0]!.id;
    useTimelineStore.getState().removeKeyframe(clipId, kfId);
    clip = useTimelineStore.getState().tracks[0]!.clips[0]!;
    expect(clip.keyframes).toHaveLength(1);
  });

  it("adds effects and updates params", () => {
    const trackId = useTimelineStore.getState().addTrack("Video 1", "video");
    const clipId = useTimelineStore.getState().addClip(trackId, {
      sourceMediaId: null,
      startTime: 0,
      duration: 2,
      sourceOffset: 0,
      speed: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: false,
      volume: 1,
    });

    const effectId = useTimelineStore.getState().addEffect(clipId, {
      type: "brightness",
      name: "Brightness",
      enabled: true,
      params: { amount: 1 },
      keyframes: [],
    });

    useTimelineStore.getState().updateEffectParam(clipId, effectId, "amount", 1.2);
    const clip = useTimelineStore.getState().tracks[0]!.clips[0]!;
    expect(clip.effects[0]!.params.amount).toBe(1.2);

    useTimelineStore.getState().removeEffect(clipId, effectId);
    expect(useTimelineStore.getState().tracks[0]!.clips[0]!.effects).toHaveLength(0);
  });

  it("updates text and shape params", () => {
    const textTrack = useTimelineStore.getState().addTrack("Text", "text");
    const textClip = useTimelineStore.getState().addClip(textTrack, {
      sourceMediaId: null,
      startTime: 0,
      duration: 2,
      sourceOffset: 0,
      speed: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: false,
      volume: 1,
      textParams: {
        text: "Hello",
        fontFamily: "Inter, sans-serif",
        fontSize: 48,
        fontWeight: "600",
        color: "#ffffff",
        textAlign: "center",
        lineHeight: 1.3,
      },
    });

    useTimelineStore.getState().updateClipTextParams(textClip, { text: "World", fontSize: 64 });
    expect(useTimelineStore.getState().tracks[0]!.clips[0]!.textParams?.text).toBe("World");
    expect(useTimelineStore.getState().tracks[0]!.clips[0]!.textParams?.fontSize).toBe(64);

    const shapeTrack = useTimelineStore.getState().addTrack("Shape", "shape");
    const shapeClip = useTimelineStore.getState().addClip(shapeTrack, {
      sourceMediaId: null,
      startTime: 0,
      duration: 2,
      sourceOffset: 0,
      speed: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: false,
      volume: 1,
      shapeParams: {
        shape: "rect",
        fill: "#3b82f6",
        stroke: "transparent",
        strokeWidth: 0,
        width: 200,
        height: 200,
      },
    });

    useTimelineStore.getState().updateClipShapeParams(shapeClip, { shape: "ellipse", width: 300 });
    const shape = useTimelineStore.getState().tracks.find((t) => t.id === shapeTrack)!.clips[0]!;
    expect(shape.shapeParams?.shape).toBe("ellipse");
    expect(shape.shapeParams?.width).toBe(300);
  });
});
