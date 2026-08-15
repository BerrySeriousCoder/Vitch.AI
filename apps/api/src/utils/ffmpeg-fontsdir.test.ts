import { describe, expect, it } from "vitest";
import {
  buildAudioMixFilterGraph,
  buildRenderFilterGraph,
  generateAssSubtitles,
  type AssSubtitleClip,
  type RenderInputFile,
} from "./ffmpeg.js";

describe("ASS fontsdir + fontId", () => {
  it("resolves fontId via family map in ASS styles", () => {
    const clips: AssSubtitleClip[] = [
      {
        startTime: 0,
        duration: 2,
        textParams: {
          text: "Hello",
          fontId: "font-1",
          fontFamily: "Fallback",
          fontSize: 40,
        },
      },
    ];
    const map = new Map([["font-1", "TempoCustom"]]);
    const ass = generateAssSubtitles(clips, 1920, 1080, map);
    expect(ass).toContain("TempoCustom");
    expect(ass).not.toMatch(/Style: Clip0,Fallback,/);
  });

  it("includes fontsdir in subtitles filter", () => {
    const files: RenderInputFile[] = [
      {
        path: "/tmp/v.mp4",
        startTime: 0,
        duration: 1,
        mediaType: "video",
      },
    ];
    const graph = buildRenderFilterGraph({
      inputFiles: files,
      width: 640,
      height: 360,
      fps: 24,
      duration: 1,
      subtitlePath: "/tmp/timeline.ass",
      fontsDir: "/tmp/fonts",
      inputHasAudio: [false],
    });
    expect(graph.filterComplex).toMatch(/subtitles=filename=.*fontsdir=/);
  });
});

describe("buildAudioMixFilterGraph", () => {
  it("mixes audio without video filter chains", () => {
    const files: RenderInputFile[] = [
      {
        path: "/tmp/v.mp4",
        startTime: 0,
        timelineStart: 1,
        duration: 2,
        mediaType: "video",
        volume: 0.5,
      },
    ];
    const graph = buildAudioMixFilterGraph({
      inputFiles: files,
      duration: 4,
      masterVolume: 1,
      inputHasAudio: [true],
    });
    expect(graph.filterComplex).toContain("amix=");
    expect(graph.filterComplex).toContain("adelay=");
    expect(graph.filterComplex).not.toContain("overlay=");
    expect(graph.filterComplex).not.toContain("color=c=");
    expect(graph.audioOutputLabel).toBe("outa");
  });

  it("keeps dynamic volume and equal-power pan envelopes in the export graph", () => {
    const graph = buildAudioMixFilterGraph({
      inputFiles: [{
        path: "/tmp/automation.wav",
        startTime: 0,
        timelineStart: 0,
        duration: 2,
        mediaType: "audio",
        volumeExpr: "if(between(t,0,2),1-t/2,0.5)",
        panExpr: "if(between(t,0,2),-1+t,1)",
      }],
      duration: 2,
      inputHasAudio: [true],
    });
    expect(graph.filterComplex).toContain("volume='if(between(t,0,2),1-t/2,0.5)':eval=frame");
    expect(graph.filterComplex).toContain("aeval=exprs='");
    expect(graph.filterComplex).toContain("aformat=sample_rates=44100:channel_layouts=stereo");
  });
});
