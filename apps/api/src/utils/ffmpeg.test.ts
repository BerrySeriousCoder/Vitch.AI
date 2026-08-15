import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("./logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { execFile } from "child_process";
import {
  ANALYSIS_PROXY_TARGET_BYTES,
  analysisProxyVideoBitrateKbps,
  generateAnalysisVideoProxy,
  probe,
  generateThumbnail,
  generateEditorialProxy,
  extractAudio,
  renderVideo,
  buildRenderFilterGraph,
  resolveVideoEncodingProfile,
} from "./ffmpeg.js";

const mockedExecFile = vi.mocked(execFile);

function lastFfmpegArgs(): string[] {
  const calls = mockedExecFile.mock.calls.filter((c) => c[0] === "ffmpeg");
  const last = calls[calls.length - 1];
  return (last?.[1] as string[]) || [];
}

function mockExecSuccess(stdout: string) {
  mockedExecFile.mockImplementation((_cmd, _args, optionsOrCb: any, maybeCb?: any) => {
    const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
    cb(null, { stdout, stderr: "" });
    return {} as any;
  });
}

function mockExecFail(message: string) {
  mockedExecFile.mockImplementation((_cmd, _args, optionsOrCb: any, maybeCb?: any) => {
    const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
    cb(new Error(message), { stdout: "", stderr: message });
    return {} as any;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("probe", () => {
  it("parses ffprobe json into ProbeResult", async () => {
    mockExecSuccess(
      JSON.stringify({
        format: { duration: "12.5", bit_rate: "5000000" },
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1920,
            height: 1080,
            r_frame_rate: "30/1",
            avg_frame_rate: "30000/1001",
            sample_aspect_ratio: "1:1",
            display_aspect_ratio: "16:9",
            pix_fmt: "yuv420p10le",
            bits_per_raw_sample: "10",
            color_primaries: "bt2020",
            color_transfer: "smpte2084",
            color_space: "bt2020nc",
            color_range: "tv",
            side_data_list: [{ rotation: -90 }],
          },
          {
            codec_type: "audio",
            codec_name: "aac",
            sample_rate: "48000",
            channels: 2,
          },
        ],
      })
    );

    const result = await probe("/tmp/video.mp4");
    expect(result.duration).toBe(12.5);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.fps).toBeCloseTo(29.97, 2);
    expect(result.rotation).toBe(270);
    expect(result.displayWidth).toBe(1080);
    expect(result.displayHeight).toBe(1920);
    expect(result.isVariableFrameRate).toBe(false);
    expect(result.isHdr).toBe(true);
    expect(result.bitDepth).toBe(10);
    expect(result.videoCodec).toBe("h264");
    expect(result.audioCodec).toBe("aac");
    expect(result.sampleRate).toBe(48000);
    expect(result.channels).toBe(2);
  });

  it("returns zero duration on failure", async () => {
    mockExecFail("ffprobe missing");
    const result = await probe("/tmp/missing.mp4");
    expect(result.duration).toBe(0);
  });
});

describe("generateEditorialProxy", () => {
  it("uses a portrait-safe long-edge scale and high quality seekable profile", async () => {
    mockExecSuccess("");
    await expect(generateEditorialProxy("/in.mov", "/out.mp4")).resolves.toBe(true);
    const args = lastFfmpegArgs();
    expect(args.join(" ")).toContain("gte(iw,ih)");
    expect(args).toContain("22");
    expect(args).toContain("-keyint_min");
    expect(args).toContain("128k");
  });
});

describe("generateAnalysisVideoProxy", () => {
  it("uses a conservative bounded bitrate across short and long references", () => {
    expect(analysisProxyVideoBitrateKbps(16.4)).toBe(2500);
    const longVideoKbps = analysisProxyVideoBitrateKbps(300);
    expect(longVideoKbps).toBeGreaterThanOrEqual(96);
    expect((longVideoKbps + 48) * 1000 * 300 / 8).toBeLessThan(ANALYSIS_PROXY_TARGET_BYTES);
  });

  it("retains low-bitrate audio and temporal frames in the inline proxy", async () => {
    mockExecSuccess("");
    await expect(generateAnalysisVideoProxy("/in.mov", "/analysis.mp4", 16.4)).resolves.toBe(true);
    const args = lastFfmpegArgs();
    expect(args.join(" ")).toContain("fps=24");
    expect(args).toContain("2500k");
    expect(args).toContain("48k");
    expect(args).toContain("+faststart");
  });
});

describe("generateThumbnail", () => {
  it("returns true on success", async () => {
    mockExecSuccess("");
    await expect(generateThumbnail("/in.mp4", "/out.jpg", 1)).resolves.toBe(true);
  });

  it("returns false on failure", async () => {
    mockExecFail("ffmpeg failed");
    await expect(generateThumbnail("/in.mp4", "/out.jpg")).resolves.toBe(false);
  });
});

describe("extractAudio", () => {
  it("returns true on success", async () => {
    mockExecSuccess("");
    await expect(extractAudio("/in.mp4", "/out.wav")).resolves.toBe(true);
  });

  it("returns false on failure", async () => {
    mockExecFail("no audio");
    await expect(extractAudio("/in.mp4", "/out.wav")).resolves.toBe(false);
  });
});

describe("renderVideo", () => {
  it("loops still images and synthesizes silent audio (no [0:a])", async () => {
    mockExecSuccess("");

    const ok = await renderVideo({
      inputFiles: [
        {
          path: "/tmp/still.png",
          startTime: 0,
          duration: 10,
          mediaType: "image",
        },
      ],
      outputPath: "/tmp/out.mp4",
      width: 1920,
      height: 1080,
      fps: 30,
    });

    expect(ok).toBe(true);
    const args = lastFfmpegArgs();
    expect(args).toContain("-loop");
    expect(args).toContain("1");
    expect(args.join(" ")).toContain("anullsrc");
    expect(args.join(" ")).not.toMatch(/\[0:a\]/);
    expect(args).toContain("yuv420p");
    expect(args).toContain("-crf");
    expect(args).toContain("bt709");
  });

  it("uses real audio trim when source has audio", async () => {
    mockedExecFile.mockImplementation((cmd, args, optionsOrCb: any, maybeCb?: any) => {
      const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
      if (cmd === "ffprobe") {
        cb(null, {
          stdout: JSON.stringify({
            format: { duration: "5" },
            streams: [
              { codec_type: "video", codec_name: "h264", width: 1280, height: 720, r_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
            ],
          }),
          stderr: "",
        });
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
      return {} as any;
    });

    const ok = await renderVideo({
      inputFiles: [{ path: "/tmp/clip.mp4", startTime: 0, duration: 5, mediaType: "video" }],
      outputPath: "/tmp/out.mp4",
      width: 1920,
      height: 1080,
      fps: 30,
    });

    expect(ok).toBe(true);
    const filter = lastFfmpegArgs().join(" ");
    expect(filter).toContain("[0:a]atrim=");
    // The timeline mixer always starts from a duration-bounded silent bed so
    // gaps and late-starting clips still produce a valid continuous stream.
    expect(filter).toContain("anullsrc");
    expect(filter).toContain("[basea][ain0]amix=inputs=2");
  });
});

describe("professional export profiles", () => {
  it("creates a tagged HEVC Main10 HDR10 profile with mastering metadata", () => {
    const profile = resolveVideoEncodingProfile({
      videoCodec: "h265",
      colorSpace: "rec2100-pq",
      qualityPreset: "ultra",
      hdrMetadata: {
        maxLuminance: 1000,
        minLuminance: 0.0001,
        maxCll: 1200,
        maxFall: 500,
      },
    });
    const args = profile.args.join(" ");
    expect(profile.pixelFormat).toBe("yuv420p10le");
    expect(args).toContain("main10");
    expect(args).toContain("bt2020");
    expect(args).toContain("smpte2084");
    expect(args).toContain("master-display=");
    expect(args).toContain("max-cll=1200,500");
    expect(args).toContain("hvc1");
  });

  it("creates 10-bit 4:4:4 ProRes and DNxHR master profiles", () => {
    const prores = resolveVideoEncodingProfile({ videoCodec: "prores-4444", colorSpace: "rec709" });
    const dnx = resolveVideoEncodingProfile({ videoCodec: "dnxhr-444", colorSpace: "rec2100-hlg" });
    expect(prores.extension).toBe("mov");
    expect(prores.pixelFormat).toBe("yuv444p10le");
    expect(prores.audioCodec).toBe("pcm-s24le");
    expect(prores.args.join(" ")).toContain("prores_ks");
    expect(dnx.pixelFormat).toBe("yuv444p10le");
    expect(dnx.args.join(" ")).toContain("dnxhr_444");
    expect(dnx.args.join(" ")).toContain("arib-std-b67");
  });

  it("signals HLG without enabling the PQ-only x265 HDR optimization", () => {
    const hlg = resolveVideoEncodingProfile({ videoCodec: "h265", colorSpace: "rec2100-hlg" });
    expect(hlg.args.join(" ")).toContain("transfer=18");
    expect(hlg.args.join(" ")).not.toContain("hdr-opt=1");
  });

  it("rejects an HDR label on an H.264 8-bit file", () => {
    expect(() => resolveVideoEncodingProfile({ videoCodec: "h264", colorSpace: "rec2100-pq" }))
      .toThrow(/H\.264 cannot encode/);
  });

  it("keeps HDR composition high-depth and performs an explicit SDR-to-PQ transform", () => {
    const graph = buildRenderFilterGraph({
      inputFiles: [{ path: "/tmp/sdr.mp4", startTime: 0, duration: 1, mediaType: "video" }],
      width: 1920,
      height: 1080,
      fps: 30,
      inputHasAudio: [false],
      inputIsHdr: [false],
      outputColorSpace: "rec2100-pq",
      outputBitDepth: 10,
    });
    expect(graph.filterComplex).toContain("format=gbrap16le");
    expect(graph.filterComplex).toContain("color_trc=bt709");
    expect(graph.filterComplex).toContain("t=linear");
    expect(graph.filterComplex).toContain("t=smpte2084");
    expect(graph.filterComplex).toContain("format=yuv444p10le[outv]");
  });
});

describe("audio pan export", () => {
  it("emits an equal-power stereo expression for static pan", () => {
    const graph = buildRenderFilterGraph({
      inputFiles: [{ path: "/tmp/audio.wav", startTime: 0, timelineStart: 0, duration: 2, mediaType: "audio", panExpr: "0.500000" }],
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 2,
      inputHasAudio: [true],
    });
    expect(graph.filterComplex).toContain("aeval=exprs=");
    expect(graph.filterComplex).toContain("1-(0.500000)");
    expect(graph.filterComplex).toContain("1+(0.500000)");
  });
});
