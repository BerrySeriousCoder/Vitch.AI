import { execFile } from "child_process";
import { promisify } from "util";
import { resolveLocalMediaPath } from "./audio-understanding.service.js";

const exec = promisify(execFile);
const SAMPLE_RATE = 8000;
const ENVELOPE_HZ = 100;
const MAX_ANALYSIS_SECONDS = 90;
const MAX_OFFSET_SECONDS = 30;

export interface AudioSyncInput { id: string; assetUrl: string; }
export interface AudioSyncResult {
  referenceId: string;
  offsetsById: Record<string, number>;
  confidenceById: Record<string, number>;
  analysedSeconds: number;
  method?: "audio-correlation" | "clap" | "timecode";
}

export type MulticamSyncStrategy = "auto" | "audio" | "clap" | "timecode";

async function audioEnvelope(assetUrl: string): Promise<Float32Array> {
  const file = resolveLocalMediaPath(assetUrl);
  if (!file) throw new Error("Audio synchronization currently requires locally stored media");
  const { stdout } = await exec("ffmpeg", [
    "-v", "error", "-t", String(MAX_ANALYSIS_SECONDS), "-i", file, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE),
    "-f", "f32le", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  const samples = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
  const hop = SAMPLE_RATE / ENVELOPE_HZ;
  const count = Math.floor(samples.length / hop);
  if (count < ENVELOPE_HZ * 2) throw new Error("Not enough usable audio to synchronize this angle");
  const output = new Float32Array(count);
  for (let bucket = 0; bucket < count; bucket++) {
    let sum = 0;
    for (let index = 0; index < hop; index++) sum += Math.abs(samples[bucket * hop + index] || 0);
    output[bucket] = sum / hop;
  }
  // Normalize energy and remove slow loudness drift; correlation then follows
  // transients/speech cadence instead of camera gain differences.
  let mean = 0;
  for (const value of output) mean += value;
  mean /= output.length;
  let variance = 0;
  for (const value of output) variance += (value - mean) ** 2;
  const deviation = Math.sqrt(variance / output.length) || 1;
  for (let index = 0; index < output.length; index++) output[index] = (output[index]! - mean) / deviation;
  return output;
}

async function readTimecode(assetUrl: string): Promise<{ seconds: number; fps: number } | null> {
  const file = resolveLocalMediaPath(assetUrl);
  if (!file) return null;
  try {
    const { stdout } = await exec("ffprobe", ["-v", "error", "-print_format", "json", "-show_entries", "format_tags=timecode:stream_tags=timecode:stream=r_frame_rate", file]);
    const parsed = JSON.parse(stdout) as { format?: { tags?: { timecode?: string } }; streams?: Array<{ tags?: { timecode?: string }; r_frame_rate?: string }> };
    const stream = parsed.streams?.find((item) => item.tags?.timecode) || parsed.streams?.[0];
    const code = stream?.tags?.timecode || parsed.format?.tags?.timecode;
    if (!code) return null;
    const parts = code.split(/[:;]/).map(Number);
    if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
    const [hh, mm, ss, ff] = parts as [number, number, number, number];
    const [num, den] = String(stream?.r_frame_rate || "30/1").split("/").map(Number);
    const fps = num && den ? num / den : 30;
    return { seconds: hh * 3600 + mm * 60 + ss + ff / fps, fps };
  } catch { return null; }
}

function clapOnset(envelope: Float32Array): { time: number; confidence: number } {
  let bestIndex = 1, best = -Infinity, second = -Infinity;
  for (let index = 1; index < envelope.length; index++) {
    const rise = envelope[index]! - envelope[index - 1]!;
    if (rise > best) { second = best; best = rise; bestIndex = index; }
    else if (rise > second) second = rise;
  }
  return { time: bestIndex / ENVELOPE_HZ, confidence: Math.max(0, Math.min(1, (best - Math.max(0, second)) / Math.max(0.001, Math.abs(best)))) };
}

async function visualClapMotion(assetUrl: string, audioTime: number): Promise<{ time: number; confidence: number }> {
  const file = resolveLocalMediaPath(assetUrl);
  if (!file) throw new Error("Visual clap confirmation requires locally stored media");
  const start = Math.max(0, audioTime - 1.5);
  const fps = 12, width = 96, height = 54, frameSize = width * height;
  const { stdout } = await exec("ffmpeg", ["-v", "error", "-ss", String(start), "-t", "3", "-i", file, "-an", "-vf", `fps=${fps},scale=${width}:${height}:flags=area`, "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  const count = Math.floor(bytes.length / frameSize);
  if (count < 3) return { time: audioTime, confidence: 0 };
  let bestIndex = 1, best = -Infinity, second = -Infinity;
  for (let index = 1; index < count; index++) {
    let difference = 0;
    const previous = (index - 1) * frameSize, current = index * frameSize;
    for (let pixel = 0; pixel < frameSize; pixel += 2) difference += Math.abs(bytes[current + pixel]! - bytes[previous + pixel]!);
    if (difference > best) { second = best; best = difference; bestIndex = index; } else if (difference > second) second = difference;
  }
  const confidence = Math.max(0, Math.min(1, (best - Math.max(0, second)) / Math.max(1, best)));
  return { time: start + bestIndex / fps, confidence };
}

function correlate(reference: Float32Array, candidate: Float32Array): { offsetSamples: number; confidence: number } {
  const maxOffset = Math.min(MAX_OFFSET_SECONDS * ENVELOPE_HZ, Math.floor(Math.min(reference.length, candidate.length) * 0.45));
  const scoreAt = (offset: number): number | null => {
    const startReference = Math.max(0, -offset);
    const startCandidate = Math.max(0, offset);
    const count = Math.min(reference.length - startReference, candidate.length - startCandidate, ENVELOPE_HZ * MAX_ANALYSIS_SECONDS);
    if (count < ENVELOPE_HZ * 2) return null;
    let sum = 0;
    for (let index = 0; index < count; index++) sum += reference[startReference + index]! * candidate[startCandidate + index]!;
    return sum / count;
  };
  let bestOffset = 0, best = -Infinity;
  for (let offset = -maxOffset; offset <= maxOffset; offset++) {
    const score = scoreAt(offset);
    if (score != null && score > best) { best = score; bestOffset = offset; }
  }
  // Ignore the immediate neighborhood of the winning peak. Adjacent envelope
  // offsets naturally correlate too and are not competing alignment choices.
  let runnerUp = -Infinity;
  for (let offset = -maxOffset; offset <= maxOffset; offset++) {
    if (Math.abs(offset - bestOffset) <= 5) continue;
    const score = scoreAt(offset);
    if (score != null && score > runnerUp) runnerUp = score;
  }
  const separation = (best - Math.max(0, runnerUp)) / Math.max(0.05, Math.abs(best));
  return { offsetSamples: bestOffset, confidence: Math.max(0, Math.min(1, separation)) };
}

/** Aligns local camera recordings by their normalized audio-energy envelopes. */
export async function synchronizeMulticamAudio(inputs: AudioSyncInput[], referenceId?: string): Promise<AudioSyncResult> {
  if (inputs.length < 2) throw new Error("At least two media files are required for multicam audio synchronization");
  const reference = inputs.find((input) => input.id === referenceId) || inputs[0]!;
  const envelopes = await Promise.all(inputs.map(async (input) => ({ id: input.id, envelope: await audioEnvelope(input.assetUrl) })));
  const referenceEnvelope = envelopes.find((item) => item.id === reference.id)!.envelope;
  const offsetsById: Record<string, number> = { [reference.id]: 0 };
  const confidenceById: Record<string, number> = { [reference.id]: 1 };
  for (const item of envelopes) {
    if (item.id === reference.id) continue;
    const match = correlate(referenceEnvelope, item.envelope);
    offsetsById[item.id] = match.offsetSamples / ENVELOPE_HZ;
    confidenceById[item.id] = match.confidence;
  }
  return { referenceId: reference.id, offsetsById, confidenceById, analysedSeconds: Math.min(MAX_ANALYSIS_SECONDS, referenceEnvelope.length / ENVELOPE_HZ), method: "audio-correlation" };
}

export async function synchronizeMulticam(inputs: AudioSyncInput[], referenceId?: string, strategy: MulticamSyncStrategy = "auto"): Promise<AudioSyncResult> {
  if (inputs.length < 2) throw new Error("At least two media files are required for multicam synchronization");
  const reference = inputs.find((input) => input.id === referenceId) || inputs[0]!;
  if (strategy === "auto" || strategy === "timecode") {
    const timecodes = await Promise.all(inputs.map(async (input) => ({ id: input.id, value: await readTimecode(input.assetUrl) })));
    const ref = timecodes.find((item) => item.id === reference.id)?.value;
    if (ref && timecodes.every((item) => item.value)) {
      const offsetsById: Record<string, number> = {};
      const confidenceById: Record<string, number> = {};
      for (const item of timecodes) { offsetsById[item.id] = item.value!.seconds - ref.seconds; confidenceById[item.id] = 1; }
      return { referenceId: reference.id, offsetsById, confidenceById, analysedSeconds: 0, method: "timecode" };
    }
    if (strategy === "timecode") throw new Error("Every angle needs readable embedded SMPTE timecode for timecode synchronization");
  }
  const envelopes = await Promise.all(inputs.map(async (input) => ({ id: input.id, envelope: await audioEnvelope(input.assetUrl) })));
  if (strategy === "clap") {
    const ref = clapOnset(envelopes.find((item) => item.id === reference.id)!.envelope);
    const offsetsById: Record<string, number> = { [reference.id]: 0 }, confidenceById: Record<string, number> = { [reference.id]: 1 };
    const visual = await Promise.all(inputs.map(async (input) => {
      const onset = clapOnset(envelopes.find((item) => item.id === input.id)!.envelope);
      return { id: input.id, audio: onset, visual: await visualClapMotion(input.assetUrl, onset.time) };
    }));
    const referenceVisual = visual.find((item) => item.id === reference.id)!;
    for (const item of visual) if (item.id !== reference.id) {
      // Visual timing refines the coarse audio onset; only trust it when the
      // frame-motion peak is distinctive, otherwise retain audio alignment.
      const useVisual = item.visual.confidence >= 0.12 && referenceVisual.visual.confidence >= 0.12;
      offsetsById[item.id] = useVisual ? item.visual.time - referenceVisual.visual.time : item.audio.time - ref.time;
      confidenceById[item.id] = Math.min(ref.confidence, item.audio.confidence) * (useVisual ? (0.5 + 0.5 * Math.min(item.visual.confidence, referenceVisual.visual.confidence)) : 0.5);
    }
    return { referenceId: reference.id, offsetsById, confidenceById, analysedSeconds: Math.min(MAX_ANALYSIS_SECONDS, envelopes[0]!.envelope.length / ENVELOPE_HZ), method: "clap" };
  }
  return synchronizeMulticamAudio(inputs, reference.id);
}
