import { describe, expect, it } from "vitest";
import type { Clip, Track } from "@tempo/types";
import { audioToolExecutors } from "./audio.tool.js";

function state() {
  const clip: Clip = { id: "c1", trackId: "voice", sourceMediaId: "m1", startTime: 3, duration: 4, sourceOffset: 0, speed: 1, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 }, opacity: 1, blendMode: "normal", effects: [], keyframes: [], mask: null, muted: false, volume: 1 };
  const tracks: Track[] = [{ id: "voice", name: "Voice", type: "audio", order: 0, locked: false, visible: true, solo: false, clips: [clip] }];
  return { tracks, audioMixer: { masterVolume: 1, trackVolumes: {}, trackMutes: {} } };
}

describe("audio post tools", () => {
  it("applies a voice cleanup preset and master delivery target", () => {
    const project = state();
    const voice = audioToolExecutors.apply_voice_post_preset!({ trackId: "voice", preset: "podcast" }, project);
    expect(voice.state.audioMixer.trackPost?.voice?.compressor.enabled).toBe(true);
    const master = audioToolExecutors.set_mastering!({ loudnessEnabled: true, targetLufs: -14, ceilingDb: -1 }, voice.state);
    expect(master.state.audioMixer.mastering).toMatchObject({ loudnessEnabled: true, targetLufs: -14, ceilingDb: -1 });
  });

  it("writes bounded clip-local and track-wide automation", () => {
    const project = state();
    const clipResult = audioToolExecutors.set_clip_audio_automation!({ clipId: "c1", property: "volume", points: [{ time: -2, value: -1 }, { time: 8, value: 3 }] }, project);
    expect(clipResult.state.tracks[0]!.clips[0]!.audioAutomation?.volume).toMatchObject([{ time: 0, value: 0 }, { time: 4, value: 2 }]);
    const trackResult = audioToolExecutors.set_track_audio_automation!({ trackId: "voice", property: "pan", points: [{ time: 2, value: -2 }, { time: 5, value: 0.4 }] }, clipResult.state);
    expect(trackResult.state.audioMixer.trackAutomation?.voice?.pan).toMatchObject([{ time: 2, value: -1 }, { time: 5, value: 0.4 }]);
  });
});
