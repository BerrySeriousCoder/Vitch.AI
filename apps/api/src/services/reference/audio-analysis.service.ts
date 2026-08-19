import { execFile } from "child_process";
import { promisify } from "util";
import { GoogleGenAI } from "@google/genai";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import type { AudioAnalysis, AudioImpactEvent, BeatInfo } from "@tempo/types";

const exec = promisify(execFile);

const PCM_EXEC_OPTS = {
  encoding: "buffer" as const,
  maxBuffer: 80 * 1024 * 1024,
};

type RhythmDetectionResult = {
  bpm: number;
  beats: BeatInfo[];
  impacts: AudioImpactEvent[];
  beatConfidence: number;
  beatSource: "detected" | "unavailable";
  warning?: string;
};

const AUDIO_SAMPLE_RATE = 22_050;

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function fftMagnitudes(samples: Float32Array, offset: number, size: number): Float64Array {
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let index = 0; index < size; index++) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (size - 1));
    real[index] = (samples[offset + index] || 0) * window;
  }
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j]!, real[i]!];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const phaseReal = Math.cos(angle);
    const phaseImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let wr = 1;
      let wi = 0;
      for (let index = 0; index < length / 2; index++) {
        const even = start + index;
        const odd = even + length / 2;
        const tr = wr * real[odd]! - wi * imaginary[odd]!;
        const ti = wr * imaginary[odd]! + wi * real[odd]!;
        real[odd] = real[even]! - tr;
        imaginary[odd] = imaginary[even]! - ti;
        real[even] = real[even]! + tr;
        imaginary[even] = imaginary[even]! + ti;
        const nextWr = wr * phaseReal - wi * phaseImaginary;
        wi = wr * phaseImaginary + wi * phaseReal;
        wr = nextWr;
      }
    }
  }
  const magnitudes = new Float64Array(size / 2);
  for (let index = 1; index < magnitudes.length; index++) {
    magnitudes[index] = Math.hypot(real[index]!, imaginary[index]!);
  }
  return magnitudes;
}

/**
 * Multi-band spectral-flux onset detector. It retains irregular edit impacts
 * even when a periodic beat grid cannot be proven.
 */
export function detectSpectralOnsetsFromPcm(
  samples: Float32Array,
  sampleRate = AUDIO_SAMPLE_RATE
): Array<{ time: number; strength: number; confidence: number }> {
  const frameSize = 1024;
  const hopSize = 256;
  if (samples.length < frameSize * 2) return [];
  const novelty: number[] = [];
  let previous = new Float64Array(frameSize / 2);
  for (let offset = 0; offset + frameSize <= samples.length; offset += hopSize) {
    const magnitudes = fftMagnitudes(samples, offset, frameSize);
    let low = 0;
    let mid = 0;
    let high = 0;
    for (let bin = 1; bin < magnitudes.length; bin++) {
      const positive = Math.max(0, magnitudes[bin]! - previous[bin]!);
      const hz = bin * sampleRate / frameSize;
      if (hz < 180) low += positive * 1.1;
      else if (hz < 2_500) mid += positive;
      else if (hz < 8_000) high += positive * 0.75;
    }
    novelty.push(Math.log1p(low) + Math.log1p(mid) + Math.log1p(high));
    previous.set(magnitudes);
  }
  const baseline = median(novelty);
  const deviation = median(novelty.map((value) => Math.abs(value - baseline)));
  const minGapFrames = Math.max(1, Math.round(0.11 * sampleRate / hopSize));
  const candidates: Array<{ index: number; value: number; threshold: number }> = [];
  const radius = Math.max(2, Math.round(0.35 * sampleRate / hopSize));
  for (let index = 1; index < novelty.length - 1; index++) {
    const window = novelty.slice(Math.max(0, index - radius), Math.min(novelty.length, index + radius + 1));
    const localMedian = median(window);
    const localMad = median(window.map((value) => Math.abs(value - localMedian)));
    const threshold = localMedian + Math.max(0.08, localMad * 2.5, deviation * 0.75);
    const value = novelty[index]!;
    if (value >= threshold && value >= novelty[index - 1]! && value >= novelty[index + 1]!) {
      candidates.push({ index, value, threshold });
    }
  }
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    const previousCandidate = selected[selected.length - 1];
    if (!previousCandidate || candidate.index - previousCandidate.index >= minGapFrames) {
      selected.push(candidate);
    } else if (candidate.value > previousCandidate.value) {
      selected[selected.length - 1] = candidate;
    }
  }
  const peak = Math.max(...selected.map((candidate) => candidate.value - candidate.threshold), 0.000001);
  return selected.map((candidate) => {
    const excess = candidate.value - candidate.threshold;
    return {
      time: candidate.index * hopSize / sampleRate,
      strength: Math.max(0.05, Math.min(1, excess / peak)),
      confidence: Math.max(0.05, Math.min(1, excess / Math.max(0.000001, candidate.threshold))),
    };
  });
}

export function finalizeRhythmDetection(
  beats: BeatInfo[],
  impacts: AudioImpactEvent[],
  bpm: number,
  beatConfidence: number
): RhythmDetectionResult {
  if (beats.length < 4 || bpm <= 0 || beatConfidence < 0.15) {
    return {
      bpm: 0,
      beats: [],
      impacts,
      beatConfidence,
      beatSource: "unavailable",
      warning: "No reliable beat grid was detected; no synthetic metronome was generated",
    };
  }
  return {
    bpm,
    beats,
    impacts: impacts.map((impact) => ({ ...impact, kind: "beat" as const })),
    beatConfidence,
    beatSource: "detected",
  };
}

/**
 * Convert ffmpeg PCM stdout to Float32Array safely.
 * Node Buffers are views into a pooled ArrayBuffer; byteOffset must be
 * 4-aligned for Float32Array or construction throws RangeError.
 */
function pcmBufferToFloat32(stdout: Buffer): Float32Array {
  const byteLength = stdout.byteLength - (stdout.byteLength % 4);
  // ArrayBuffer.slice copies into a new buffer starting at offset 0 (always aligned)
  const ab = stdout.buffer.slice(
    stdout.byteOffset,
    stdout.byteOffset + byteLength
  );
  return new Float32Array(ab);
}

/**
 * Extract energy curve from audio via FFmpeg astats/RMS windowing on PCM.
 */
async function extractEnergyCurve(
  audioPath: string,
  duration: number,
  signal?: AbortSignal
): Promise<{ time: number; energy: number }[]> {
  try {
    const { stdout } = await exec(
      "ffmpeg",
      [
        "-i",
        audioPath,
        "-ac",
        "1",
        "-ar",
        "22050",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "pipe:1",
      ],
      { ...PCM_EXEC_OPTS, signal }
    );

    if (!Buffer.isBuffer(stdout) || stdout.byteLength < 4) {
      throw new Error("empty or non-buffer PCM stdout");
    }
    const samples = pcmBufferToFloat32(stdout);

    const sampleRate = 22050;
    const windowSec = 0.1;
    const windowSize = Math.floor(sampleRate * windowSec);
    const curve: { time: number; energy: number }[] = [];

    for (let i = 0; i + windowSize < samples.length; i += windowSize) {
      let sum = 0;
      for (let j = 0; j < windowSize; j++) {
        const s = samples[i + j] ?? 0;
        sum += s * s;
      }
      const rms = Math.sqrt(sum / windowSize);
      curve.push({
        time: Math.round((i / sampleRate) * 100) / 100,
        energy: Math.max(0, Math.min(1, rms * 4)),
      });
    }

    if (curve.length > 0) return curve;
  } catch (err: any) {
    logger.warn({ err: err.message }, "PCM energy extraction failed, using fallback");
  }

  return [];
}

/**
 * Beat-grid estimation from locally measured multi-band spectral onsets.
 */
async function detectBeats(
  audioPath: string,
  duration: number,
  signal?: AbortSignal
): Promise<RhythmDetectionResult> {
  let bpm = 0;
  const beats: BeatInfo[] = [];
  const impacts: AudioImpactEvent[] = [];
  let beatConfidence = 0;

  try {
    const { stdout } = await exec(
      "ffmpeg",
      [
        "-i",
        audioPath,
        "-ac",
        "1",
        "-ar",
        "22050",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "pipe:1",
      ],
      { ...PCM_EXEC_OPTS, signal }
    );

    if (!Buffer.isBuffer(stdout) || stdout.byteLength < 4) {
      throw new Error("empty or non-buffer PCM stdout");
    }
    const samples = pcmBufferToFloat32(stdout);

    for (const onset of detectSpectralOnsetsFromPcm(samples, AUDIO_SAMPLE_RATE)) {
      if (onset.time >= duration) continue;
      const time = Math.round(onset.time * 1_000) / 1_000;
      beats.push({ time, strength: onset.strength, isDownbeat: false });
      impacts.push({
        id: `impact-${impacts.length}`,
        time,
        strength: onset.strength,
        isDownbeat: false,
        kind: "onset",
        confidence: onset.confidence,
      });
    }

    // Estimate tempo from measured onset intervals. Do not label every fourth
    // onset as a downbeat: without bar/phase analysis that would be fabricated.
    if (beats.length >= 4) {
      const intervals: number[] = [];
      for (let i = 1; i < Math.min(beats.length, 64); i++) {
        const dt = beats[i]!.time - beats[i - 1]!.time;
        if (dt > 0.2 && dt < 1.5) intervals.push(dt);
      }
      if (intervals.length > 0) {
        intervals.sort((a, b) => a - b);
        const medianInterval = intervals[Math.floor(intervals.length / 2)]!;
        bpm = Math.max(60, Math.min(200, Math.round(60 / medianInterval)));
        const meanDeviation = intervals.reduce(
          (sum, interval) => sum + Math.abs(interval - medianInterval),
          0
        ) / intervals.length;
        const regularity = Math.max(0, 1 - meanDeviation / Math.max(0.001, medianInterval));
        beatConfidence = Math.max(0, Math.min(1, regularity * Math.min(1, intervals.length / 12)));
      }
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "PCM beat detection failed");
  }

  return finalizeRhythmDetection(beats, impacts, bpm, beatConfidence);
}

async function classifyMoodAndGenre(
  bpm: number,
  energyCurve: { time: number; energy: number }[],
  duration: number
): Promise<{ mood: string; genre: string }> {
  const avgEnergy =
    energyCurve.reduce((a, b) => a + b.energy, 0) / (energyCurve.length || 1);
  if (!env.GEMINI_API_KEY) {
    return {
      mood: energyCurve.length === 0 ? "unknown" : avgEnergy > 0.7 ? "energetic" : avgEnergy > 0.4 ? "moderate" : "calm",
      genre: "unknown",
    };
  }
  const prompt = `Based on the following audio characteristics, classify the mood and genre in 1-2 words each:
- BPM: ${bpm}
- Duration: ${duration}s
- Average energy level: ${(avgEnergy * 100).toFixed(0)}%
- Energy pattern: ${avgEnergy > 0.7 ? "high sustained" : avgEnergy > 0.4 ? "moderate, building" : "calm, ambient"}

Reply in JSON format: {"mood": "...", "genre": "..."}`;

  try {
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const result = await ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const match = text.match(/\{[^}]+\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        mood: parsed.mood || "energetic",
        genre: parsed.genre || "electronic",
      };
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "Mood classification failed");
  }

  return {
    mood: energyCurve.length === 0 ? "unknown" : avgEnergy > 0.7 ? "energetic" : avgEnergy > 0.4 ? "moderate" : "calm",
    genre: "unknown",
  };
}

/**
 * Full audio analysis pipeline: BPM, beats, energy curve, mood, genre.
 */
export async function analyzeAudio(
  audioPath: string,
  duration: number,
  options: { signal?: AbortSignal } = {}
): Promise<AudioAnalysis> {
  logger.info({ audioPath }, "Analyzing audio");

  const [rhythm, energyCurve] = await Promise.all([
    detectBeats(audioPath, duration, options.signal),
    extractEnergyCurve(audioPath, duration, options.signal),
  ]);
  if (options.signal?.aborted) throw new DOMException("Audio analysis cancelled", "AbortError");
  const { bpm, beats, impacts, beatConfidence, beatSource, warning } = rhythm;

  const { mood, genre } = await classifyMoodAndGenre(bpm, energyCurve, duration);

  logger.info({ bpm, beats: beats.length, impacts: impacts.length, mood, genre }, "Audio analysis complete");

  const warnings = [warning, energyCurve.length === 0 ? "Audio energy analysis was unavailable; no synthetic energy curve was generated" : undefined]
    .filter((item): item is string => Boolean(item));
  return {
    bpm,
    beats,
    impacts,
    energyCurve,
    mood,
    genre,
    beatConfidence,
    beatSource,
    ...(warnings.length ? { warnings } : {}),
  };
}
