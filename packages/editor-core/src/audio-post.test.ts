import { describe, expect, it } from "vitest";
import { ffmpegAudioPostFilters, ffmpegMasteringFilters, normalizeTrackAudioPost } from "./audio-post";

describe("audio post", () => {
  it("bounds cleanup and dynamics settings", () => {
    const post = normalizeTrackAudioPost({ compressor: { enabled: true, thresholdDb: -100, ratio: 99, attackMs: -1, releaseMs: 99999, makeupDb: 99 } } as any);
    expect(post.compressor).toMatchObject({ enabled: true, thresholdDb: -60, ratio: 20, attackMs: 0, releaseMs: 5000, makeupDb: 24 });
  });
  it("builds deterministic FFmpeg cleanup and master filters", () => {
    const chain = ffmpegAudioPostFilters({ denoise: { enabled: true, amount: 12 }, deEsser: { enabled: true, intensity: 0.3, frequency: 0.5 }, compressor: { enabled: true, thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 120, makeupDb: 2 }, limiter: { enabled: true, ceilingDb: -1 } });
    expect(chain.join(",")).toContain("afftdn");
    expect(chain.join(",")).toContain("acompressor");
    expect(ffmpegMasteringFilters({ loudnessEnabled: true, targetLufs: -14, limiterEnabled: true, ceilingDb: -1 }).join(",")).toContain("loudnorm");
  });
});
