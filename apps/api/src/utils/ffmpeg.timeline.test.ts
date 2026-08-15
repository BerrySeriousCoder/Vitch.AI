import { describe, expect, it } from "vitest";
import {
  buildRenderFilterGraph,
  escapeAssText,
  escapeFfmpegFilterValue,
  generateAssSubtitles,
} from "./ffmpeg.js";

describe("buildRenderFilterGraph", () => {
  it("maps source offset, timeline start, duration, speed, volume, and audio mixing", () => {
    const graph = buildRenderFilterGraph({
      inputFiles: [
        {
          path: "/tmp/source.mp4",
          startTime: 3,
          timelineStart: 10,
          duration: 4,
          speed: 2,
          volume: 0.35,
          mediaType: "video",
        },
      ],
      inputHasAudio: [true],
      width: 1920,
      height: 1080,
      fps: 30,
      masterVolume: 0.8,
    });

    expect(graph.duration).toBe(14);
    expect(graph.filterComplex).toContain(
      "[0:v]trim=start=3:end=11,setpts=(PTS-STARTPTS)/2+10/TB"
    );
    expect(graph.filterComplex).toContain("enable='between(t,10,14)'");
    expect(graph.filterComplex).toContain(
      "[0:a]atrim=start=3:end=11,asetpts=PTS-STARTPTS,atempo=2"
    );
    expect(graph.filterComplex).toContain("volume=0.35");
    expect(graph.filterComplex).toContain("adelay=10000:all=1");
    expect(graph.filterComplex).toContain("amix=inputs=2");
    expect(graph.filterComplex).toContain("volume=0.8[outa]");
    expect(graph.filterComplex).not.toContain("concat=");
  });

  it("chains atempo filters for playback rates outside one filter's portable range", () => {
    const graph = buildRenderFilterGraph({
      inputFiles: [
        {
          path: "/tmp/audio.wav",
          startTime: 1,
          timelineStart: 0.5,
          duration: 2,
          speed: 4,
          mediaType: "audio",
        },
      ],
      inputHasAudio: [true],
      width: 1280,
      height: 720,
      fps: 24,
    });

    expect(graph.filterComplex).toContain("atrim=start=1:end=9");
    expect(graph.filterComplex).toContain("atempo=2,atempo=2");
    expect(graph.filterComplex).toContain("adelay=500:all=1");
  });

  it("tone-maps tagged HDR inputs before Rec.709 composition and uses Lanczos scaling", () => {
    const graph = buildRenderFilterGraph({
      inputFiles: [{ path: "/tmp/hdr.mov", startTime: 0, duration: 2, mediaType: "video" }],
      inputHasAudio: [false],
      inputIsHdr: [true],
      width: 1080,
      height: 1920,
      fps: 30,
    });
    expect(graph.filterComplex).toContain("zscale=t=linear:npl=100");
    expect(graph.filterComplex).toContain("tonemap=mobius");
    expect(graph.filterComplex).toContain("force_original_aspect_ratio=decrease:flags=lanczos");
  });

  it("applies subtitles after the composed visual output", () => {
    const subtitlePath = "/tmp/render:folder/caption's.ass";
    const graph = buildRenderFilterGraph({
      inputFiles: [],
      width: 640,
      height: 360,
      fps: 25,
      duration: 2,
      subtitlePath,
    });

    expect(graph.filterComplex).toContain(
      `[basev]subtitles=filename=${escapeFfmpegFilterValue(subtitlePath)},format=yuv420p[outv]`
    );
  });
});

describe("generateAssSubtitles", () => {
  it("uses absolute clip timing and relative karaoke word timing", () => {
    const ass = generateAssSubtitles(
      [
        {
          startTime: 10.25,
          duration: 2,
          layer: 3,
          transform: { x: 4, y: 20 },
          textParams: {
            text: "Hello world",
            fontFamily: "Inter, sans-serif",
            fontSize: 48,
            fontWeight: "800",
            color: "#ffffff",
            karaokeActiveColor: "#ffe566",
            karaokeInactiveColor: "#ffffff",
            karaokeWords: [
              { text: "Hello", start: 0.25, end: 0.75 },
              { text: "world", start: 1, end: 1.5 },
            ],
          },
        },
      ],
      1920,
      1080
    );

    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("Style: Default,");
    expect(ass).toContain("Style: Karaoke,");
    expect(ass).toContain("Dialogue: 3,0:00:10.25,0:00:12.25,Clip0");
    expect(ass).toContain("{\\k25}\\h{\\k50}Hello{\\k25}\\h{\\k50} world");
    expect(ass).toContain("{\\pos(964,560)\\frz0}");
  });

  it("escapes line breaks and ASS override characters in ordinary captions", () => {
    const text = "Line {\\b1} one\nLine two";
    const ass = generateAssSubtitles(
      [
        {
          startTime: 0.5,
          duration: 1.25,
          textParams: { text, textAlign: "center" },
        },
      ],
      640,
      360
    );

    expect(escapeAssText(text)).toBe("Line \\{\\\\b1\\} one\\NLine two");
    expect(ass).toContain("Dialogue: 0,0:00:00.50,0:00:01.75,Clip0");
    expect(ass).toContain("Line \\{\\\\b1\\} one\\NLine two");
  });
});
