import type { AudioMixer, Clip, Track } from "@tempo/types";
import {
  getTrackRole,
  isClipReversed,
  musicDuckBreakpoints,
  normalizeDuckSettings,
  normalizeSpeedRamp,
  normalizeTrackEq,
  normalizeTrackAudioPost,
  normalizeMastering,
  resolveAudioAutomationBreakpoints,
  sourceTimeAt,
  speedMagnitude,
  voiceActivityWindows,
  isNestClip,
} from "@tempo/editor-core";

interface ActiveSource {
  clipId: string;
  trackId: string;
  sourceNode: AudioBufferSourceNode;
  gainNode: GainNode;
  pannerNode: StereoPannerNode | null;
  /** Static clip gain before live mixer scaling. */
  clipVolume: number;
}

export interface PlayOptions {
  mixer?: AudioMixer;
}

export interface LoudnessReading {
  momentaryLufs: number | null;
  shortTermLufs: number | null;
  integratedLufs: number | null;
  peakDbfs: number | null;
  updatedAt: number | null;
}

/** Clamp fades so fadeIn + fadeOut never exceeds clip duration. */
function clampFades(clip: Clip): { fadeIn: number; fadeOut: number } {
  let fadeIn = Math.max(0, clip.fadeInSec ?? 0);
  let fadeOut = Math.max(0, clip.fadeOutSec ?? 0);
  const dur = Math.max(0, clip.duration);
  if (fadeIn + fadeOut > dur && dur > 0) {
    const scale = dur / (fadeIn + fadeOut);
    fadeIn *= scale;
    fadeOut *= scale;
  }
  return { fadeIn, fadeOut };
}

/**
 * Schedule gain envelope relative to Web Audio time `baseTime`
 * for a clip that begins playback at `offsetInClip` timeline-seconds into the clip.
 * Optional duckBreakpoints are clip-relative multipliers (music ducking).
 */
function applyFadeEnvelope(
  gainNode: GainNode,
  ctx: AudioContext,
  clip: Clip,
  offsetInClip: number,
  peakVolume: number,
  baseTime: number,
  duckBreakpoints?: Array<{ t: number; gain: number }>,
  volumeBreakpoints?: Array<{ t: number; value: number }>
) {
  const remaining = Math.max(0, clip.duration - offsetInClip);
  const { fadeIn, fadeOut } = clampFades(clip);
  const peak = Math.max(0, Math.min(1, peakVolume));

  gainNode.gain.cancelScheduledValues(baseTime);

  const duckGainAt = (clipT: number): number => {
    if (!duckBreakpoints || duckBreakpoints.length === 0) return 1;
    if (clipT <= duckBreakpoints[0]!.t) return duckBreakpoints[0]!.gain;
    for (let i = 0; i < duckBreakpoints.length - 1; i++) {
      const a = duckBreakpoints[i]!;
      const b = duckBreakpoints[i + 1]!;
      if (clipT >= a.t && clipT <= b.t) {
        const u = (clipT - a.t) / Math.max(1e-6, b.t - a.t);
        return a.gain + (b.gain - a.gain) * u;
      }
    }
    return duckBreakpoints[duckBreakpoints.length - 1]!.gain;
  };
  const automationGainAt = (clipT: number): number => {
    if (!volumeBreakpoints?.length) return 1;
    if (clipT <= volumeBreakpoints[0]!.t) return volumeBreakpoints[0]!.value;
    for (let i = 0; i < volumeBreakpoints.length - 1; i++) {
      const a = volumeBreakpoints[i]!;
      const b = volumeBreakpoints[i + 1]!;
      if (clipT <= b.t) return a.value + (b.value - a.value) * ((clipT - a.t) / Math.max(1e-6, b.t - a.t));
    }
    return volumeBreakpoints[volumeBreakpoints.length - 1]!.value;
  };

  const sampleGain = (clipT: number) => {
    let g = peak * duckGainAt(clipT) * automationGainAt(clipT);
    if (fadeIn > 0 && clipT < fadeIn) {
      const t = clipT / fadeIn;
      g *= clip.audioFadeCurve === "equal-power" ? Math.sin(t * Math.PI * 0.5) : t;
    }
    if (fadeOut > 0 && clipT > clip.duration - fadeOut) {
      const t = Math.max(0, (clip.duration - clipT) / fadeOut);
      g *= clip.audioFadeCurve === "equal-power" ? Math.sin(t * Math.PI * 0.5) : t;
    }
    return Math.max(0, Math.min(1, g));
  };

  gainNode.gain.setValueAtTime(sampleGain(offsetInClip), baseTime);

  const keyTimes = new Set<number>([offsetInClip, clip.duration]);
  if (fadeIn > 0) keyTimes.add(fadeIn);
  if (fadeOut > 0) keyTimes.add(clip.duration - fadeOut);
  for (const bp of duckBreakpoints || []) keyTimes.add(bp.t);
  for (const bp of volumeBreakpoints || []) keyTimes.add(bp.t);

  const times = [...keyTimes]
    .filter((t) => t > offsetInClip && t <= clip.duration)
    .sort((a, b) => a - b);

  for (const t of times) {
    const when = baseTime + (t - offsetInClip);
    if (when - baseTime > remaining + 1e-4) break;
    gainNode.gain.linearRampToValueAtTime(sampleGain(t), when);
  }

  if (remaining > 0) {
    const endGain = sampleGain(Math.min(clip.duration, offsetInClip + remaining));
    gainNode.gain.linearRampToValueAtTime(endGain, baseTime + remaining);
  }
}

function applyPanEnvelope(
  panner: StereoPannerNode | null,
  offsetInClip: number,
  duration: number,
  baseTime: number,
  points: Array<{ t: number; value: number }>
) {
  if (!panner) return;
  const valueAt = (t: number) => {
    if (!points.length || t <= points[0]!.t) return points[0]?.value ?? 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      if (t <= b.t) return a.value + (b.value - a.value) * ((t - a.t) / Math.max(1e-6, b.t - a.t));
    }
    return points[points.length - 1]!.value;
  };
  panner.pan.cancelScheduledValues(baseTime);
  panner.pan.setValueAtTime(Math.max(-1, Math.min(1, valueAt(offsetInClip))), baseTime);
  for (const point of points) {
    if (point.t > offsetInClip && point.t <= duration) {
      panner.pan.linearRampToValueAtTime(Math.max(-1, Math.min(1, point.value)), baseTime + point.t - offsetInClip);
    }
  }
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;
  private loudnessShelf: BiquadFilterNode | null = null;
  private loudnessHighPass: BiquadFilterNode | null = null;
  private loudnessAnalyser: AnalyserNode | null = null;
  private loudnessSink: GainNode | null = null;
  private loudnessRaf: number | null = null;
  private loudnessWindows: Array<{ time: number; energy: number; duration: number }> = [];
  private loudnessPeakDbfs: number | null = null;
  private loudnessIntegratedEnergy = 0;
  private loudnessIntegratedDuration = 0;
  private loudnessListeners = new Set<(reading: LoudnessReading) => void>();
  private bufferCache = new Map<string, AudioBuffer>();
  private activeSources: ActiveSource[] = [];
  private _isPlaying = false;
  private lastMixer: AudioMixer | null = null;
  private sidechainRaf: number | null = null;
  private sidechainAnalyser: AnalyserNode | null = null;
  private sidechainDuckGain: GainNode | null = null;
  private sidechainLevel = 0.25;
  private sidechainAttackSec = 0.12;
  private sidechainReleaseSec = 0.25;

  get isPlaying() {
    return this._isPlaying;
  }

  private getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterLimiter = this.ctx.createDynamicsCompressor();
      this.masterLimiter.threshold.value = -1;
      this.masterLimiter.knee.value = 0;
      this.masterLimiter.ratio.value = 20;
      this.masterLimiter.attack.value = 0.003;
      this.masterLimiter.release.value = 0.08;
      this.masterGain.connect(this.masterLimiter);
      this.masterLimiter.connect(this.ctx.destination);
      // EBU R128 K-weighting approximation: a high shelf followed by a
      // high-pass filter feeds an analyser side-chain (never the speakers).
      this.loudnessShelf = this.ctx.createBiquadFilter();
      this.loudnessShelf.type = "highshelf";
      this.loudnessShelf.frequency.value = 1500;
      this.loudnessShelf.gain.value = 4;
      this.loudnessHighPass = this.ctx.createBiquadFilter();
      this.loudnessHighPass.type = "highpass";
      this.loudnessHighPass.frequency.value = 38;
      this.loudnessHighPass.Q.value = 0.5;
      this.loudnessAnalyser = this.ctx.createAnalyser();
      this.loudnessAnalyser.fftSize = 2048;
      this.loudnessAnalyser.smoothingTimeConstant = 0;
      this.masterLimiter.connect(this.loudnessShelf);
      this.loudnessShelf.connect(this.loudnessHighPass);
      this.loudnessHighPass.connect(this.loudnessAnalyser);
      this.loudnessSink = this.ctx.createGain();
      this.loudnessSink.gain.value = 0;
      this.loudnessAnalyser.connect(this.loudnessSink);
      this.loudnessSink.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private getMasterGain(): GainNode {
    this.getContext();
    return this.masterGain!;
  }

  async loadBuffer(url: string): Promise<AudioBuffer | null> {
    if (this.bufferCache.has(url)) return this.bufferCache.get(url)!;

    try {
      const ctx = this.getContext();
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      this.bufferCache.set(url, audioBuffer);
      return audioBuffer;
    } catch {
      return null;
    }
  }

  setMasterVolume(volume: number) {
    const gain = this.getMasterGain();
    gain.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), this.getContext().currentTime);
  }

  /**
   * Update master + per-clip gains in place (no stop/restart).
   * Used for live mixer fader moves.
   */
  applyLiveMixer(tracks: Track[], mixer: AudioMixer) {
    this.lastMixer = mixer;
    this.setMasterVolume(mixer.masterVolume ?? 1);
    const mastering = normalizeMastering(mixer.mastering);
    if (this.masterLimiter) {
      this.masterLimiter.threshold.value = mastering.limiterEnabled ? mastering.ceilingDb : 0;
      this.masterLimiter.ratio.value = mastering.limiterEnabled ? 20 : 1;
    }
    const anySolo = tracks.some((t) => t.solo);
    const trackById = new Map(tracks.map((t) => [t.id, t]));

    for (const source of this.activeSources) {
      const track = trackById.get(source.trackId);
      let gain = source.clipVolume;
      if (!track || !track.visible) {
        gain = 0;
      } else if (anySolo && !track.solo) {
        gain = 0;
      } else if (mixer.trackMutes?.[track.id]) {
        gain = 0;
      } else {
        gain *= mixer.trackVolumes?.[track.id] ?? 1;
      }
      try {
        source.gainNode.gain.cancelScheduledValues(this.getContext().currentTime);
        source.gainNode.gain.setValueAtTime(
          Math.max(0, Math.min(2, gain)),
          this.getContext().currentTime
        );
      } catch {
        // ignore disconnected nodes
      }
    }
  }

  private stopAll() {
    this.stopLoudnessMeter();
    this.stopSidechainFollow();
    for (const source of this.activeSources) {
      try {
        source.sourceNode.stop();
        source.sourceNode.disconnect();
        source.gainNode.disconnect();
        source.pannerNode?.disconnect();
      } catch {}
    }
    this.activeSources = [];
  }

  subscribeLoudness(listener: (reading: LoudnessReading) => void): () => void {
    this.loudnessListeners.add(listener);
    return () => this.loudnessListeners.delete(listener);
  }

  private emitLoudness(reading: LoudnessReading) {
    for (const listener of this.loudnessListeners) listener(reading);
  }

  private stopLoudnessMeter() {
    if (this.loudnessRaf != null) cancelAnimationFrame(this.loudnessRaf);
    this.loudnessRaf = null;
    this.loudnessWindows = [];
    this.loudnessPeakDbfs = null;
    this.loudnessIntegratedEnergy = 0;
    this.loudnessIntegratedDuration = 0;
    this.emitLoudness({ momentaryLufs: null, shortTermLufs: null, integratedLufs: null, peakDbfs: null, updatedAt: null });
  }

  private startLoudnessMeter() {
    this.stopLoudnessMeter();
    if (!this.ctx || !this.loudnessAnalyser) return;
    const analyser = this.loudnessAnalyser;
    const samples = new Float32Array(analyser.fftSize);
    let previousTime = performance.now();
    const lufsFrom = (items: Array<{ energy: number; duration: number }>) => {
      const duration = items.reduce((sum, item) => sum + item.duration, 0);
      if (duration < 0.08) return null;
      const energy = items.reduce((sum, item) => sum + item.energy * item.duration, 0) / duration;
      return -0.691 + 10 * Math.log10(Math.max(energy, 1e-12));
    };
    const tick = () => {
      if (!this._isPlaying || !this.ctx || !this.loudnessAnalyser) { this.loudnessRaf = null; return; }
      analyser.getFloatTimeDomainData(samples);
      let energy = 0; let peak = 0;
      for (const sample of samples) { energy += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
      energy /= samples.length;
      const now = performance.now();
      const duration = Math.max(0.005, Math.min(0.1, (now - previousTime) / 1000));
      previousTime = now;
      this.loudnessWindows.push({ time: now, energy, duration });
      this.loudnessIntegratedEnergy += energy * duration;
      this.loudnessIntegratedDuration += duration;
      const integrated = this.loudnessIntegratedDuration < 0.08 ? null : -0.691 + 10 * Math.log10(Math.max(this.loudnessIntegratedEnergy / this.loudnessIntegratedDuration, 1e-12));
      const retainAfter = now - 3000;
      this.loudnessWindows = this.loudnessWindows.filter((item) => item.time >= retainAfter);
      const momentary = lufsFrom(this.loudnessWindows.filter((item) => item.time >= now - 400));
      const shortTerm = lufsFrom(this.loudnessWindows);
      const peakDbfs = 20 * Math.log10(Math.max(peak, 1e-12));
      this.loudnessPeakDbfs = this.loudnessPeakDbfs == null ? peakDbfs : Math.max(this.loudnessPeakDbfs, peakDbfs);
      this.emitLoudness({ momentaryLufs: momentary, shortTermLufs: shortTerm, integratedLufs: integrated, peakDbfs: this.loudnessPeakDbfs, updatedAt: Date.now() });
      this.loudnessRaf = requestAnimationFrame(tick);
    };
    this.loudnessRaf = requestAnimationFrame(tick);
  }

  private stopSidechainFollow() {
    if (this.sidechainRaf != null) {
      cancelAnimationFrame(this.sidechainRaf);
      this.sidechainRaf = null;
    }
    this.sidechainAnalyser = null;
    this.sidechainDuckGain = null;
  }

  private startSidechainFollow() {
    if (this.sidechainRaf != null) {
      cancelAnimationFrame(this.sidechainRaf);
      this.sidechainRaf = null;
    }
    const analyser = this.sidechainAnalyser;
    const duckGain = this.sidechainDuckGain;
    if (!analyser || !duckGain || !this.ctx) return;

    const data = new Uint8Array(analyser.fftSize);
    let current = 1;
    const tick = () => {
      if (!this._isPlaying || !this.sidechainAnalyser || !this.sidechainDuckGain) {
        this.sidechainRaf = null;
        return;
      }
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const speaking = rms > 0.04;
      const target = speaking ? this.sidechainLevel : 1;
      const dt = 1 / 60;
      const tau = speaking
        ? Math.max(0.001, this.sidechainAttackSec)
        : Math.max(0.001, this.sidechainReleaseSec);
      const alpha = 1 - Math.exp(-dt / tau);
      current += (target - current) * alpha;
      const now = this.ctx!.currentTime;
      duckGain.gain.setTargetAtTime(current, now, tau / 3);
      this.sidechainRaf = requestAnimationFrame(tick);
    };
    this.sidechainRaf = requestAnimationFrame(tick);
  }

  play(
    currentTime: number,
    tracks: Track[],
    mediaUrls: Map<string, string>,
    options?: PlayOptions
  ) {
    this.stopAll();
    this._isPlaying = true;

    const ctx = this.getContext();
    if (ctx.state === "suspended") ctx.resume();

    const mixer = options?.mixer;
    this.lastMixer = mixer ?? this.lastMixer;
    if (mixer) {
      this.setMasterVolume(mixer.masterVolume ?? 1);
      const mastering = normalizeMastering(mixer.mastering);
      if (this.masterLimiter) {
        this.masterLimiter.threshold.value = mastering.limiterEnabled ? mastering.ceilingDb : 0;
        this.masterLimiter.ratio.value = mastering.limiterEnabled ? 20 : 1;
      }
    }
    this.startLoudnessMeter();

    const anySolo = tracks.some((t) => t.solo);
    const now = ctx.currentTime;
    const duck = normalizeDuckSettings(mixer?.duck);
    const useSidechain = duck.enabled && duck.mode === "sidechain";
    const voiceWindows =
      duck.enabled && mixer && !useSidechain
        ? voiceActivityWindows(tracks, mixer, { honorSolo: true })
        : [];

    let voiceBus: GainNode | null = null;
    let musicDuckGain: GainNode | null = null;
    if (useSidechain) {
      voiceBus = ctx.createGain();
      musicDuckGain = ctx.createGain();
      musicDuckGain.gain.value = 1;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.5;
      voiceBus.connect(analyser);
      this.sidechainAnalyser = analyser;
      this.sidechainDuckGain = musicDuckGain;
      this.sidechainLevel = duck.level;
      this.sidechainAttackSec = duck.attackSec;
      this.sidechainReleaseSec = duck.releaseSec;
      musicDuckGain.connect(this.getMasterGain());
      this.startSidechainFollow();
    }

    for (const track of tracks) {
      if (!track.visible) continue;
      if (track.type !== "video" && track.type !== "audio") continue;
      if (anySolo && !track.solo) continue;
      if (mixer?.trackMutes?.[track.id]) continue;

      const trackVol = mixer?.trackVolumes?.[track.id] ?? 1;
      const role = mixer ? getTrackRole(mixer, track.id) : "other";
      const isMusic = role === "music";
      const isVoice = role === "voice";

      for (const clip of track.clips) {
        const clipEnd = clip.startTime + clip.duration;
        // Schedule current + future clips; skip clips already finished
        if (currentTime >= clipEnd) continue;
        if (clip.muted) continue;
        // Nest clips are video-only on main in v1
        if (isNestClip(clip)) continue;

        const url = clip.sourceMediaId ? mediaUrls.get(clip.sourceMediaId) : null;
        if (!url) continue;

        const buffer = this.bufferCache.get(url);
        if (!buffer) continue;

        // v1: mute reverse + ramped audio (variable-rate / reverse BufferSource is unreliable)
        if (isClipReversed(clip)) continue;
        if (normalizeSpeedRamp(clip.speedRamp, clip.duration)) continue;

        const startsInFuture = clip.startTime > currentTime;
        const delay = startsInFuture ? clip.startTime - currentTime : 0;
        let when = now + delay;
        let offsetInClip = startsInFuture ? 0 : currentTime - clip.startTime;
        if (clip.duration - offsetInClip <= 0) continue;

        // If currently in a hold freeze, start audio when motion resumes
        let mapped = sourceTimeAt(clip, offsetInClip);
        if (mapped.frozen) {
          let tMotion = offsetInClip;
          let resumed: ReturnType<typeof sourceTimeAt> | null = null;
          while (tMotion < clip.duration - 1e-3) {
            tMotion = Math.min(clip.duration, tMotion + 0.05);
            const m = sourceTimeAt(clip, tMotion);
            if (!m.frozen) {
              resumed = m;
              when += tMotion - offsetInClip;
              offsetInClip = tMotion;
              break;
            }
          }
          if (!resumed) continue;
          mapped = resumed;
        }

        const endMapped = sourceTimeAt(clip, clip.duration);
        const sourceStartOffset = mapped.sourceTime;
        const remainingDuration = Math.max(
          0.01,
          Math.abs(endMapped.sourceTime - mapped.sourceTime)
        );
        if (remainingDuration <= 0) continue;

        const sourceNode = ctx.createBufferSource();
        sourceNode.buffer = buffer;

        const rate = Math.max(0.05, mapped.rate || speedMagnitude(clip));
        if (Math.abs(rate - 1) > 0.001) {
          sourceNode.playbackRate.setValueAtTime(rate, now);
        }

        // Keep the live fader separate from the scheduled automation/fade gain so
        // moving a mixer fader never erases envelope events already in flight.
        const envelopeGain = ctx.createGain();
        const gainNode = ctx.createGain();
        const pannerNode = typeof ctx.createStereoPanner === "function" ? ctx.createStereoPanner() : null;
        const clipVolume = clip.volume ?? 1;
        const audioWhen = when;

        const duckBp =
          isMusic && duck.enabled && !useSidechain
            ? musicDuckBreakpoints(clip.startTime, clip.duration, voiceWindows, duck)
            : undefined;
        applyFadeEnvelope(
          envelopeGain,
          ctx,
          clip,
          offsetInClip,
          1,
          audioWhen,
          duckBp,
          resolveAudioAutomationBreakpoints(clip, mixer, track.id, "volume")
        );
        gainNode.gain.setValueAtTime(Math.max(0, Math.min(2, clipVolume * trackVol)), audioWhen);
        applyPanEnvelope(
          pannerNode,
          offsetInClip,
          clip.duration,
          audioWhen,
          resolveAudioAutomationBreakpoints(clip, mixer, track.id, "pan")
        );

        sourceNode.connect(envelopeGain);
        envelopeGain.connect(gainNode);
        const eq = normalizeTrackEq(mixer?.trackEq?.[track.id]);
        const post = normalizeTrackAudioPost(mixer?.trackPost?.[track.id]);
        let last: AudioNode = pannerNode || gainNode;
        if (pannerNode) gainNode.connect(pannerNode);
        if (
          Math.abs(eq.lowGainDb) > 0.05 ||
          Math.abs(eq.midGainDb) > 0.05 ||
          Math.abs(eq.highGainDb) > 0.05
        ) {
          const low = ctx.createBiquadFilter();
          low.type = "lowshelf";
          low.frequency.value = 100;
          low.gain.value = eq.lowGainDb;
          const mid = ctx.createBiquadFilter();
          mid.type = "peaking";
          mid.frequency.value = 1000;
          mid.Q.value = 1;
          mid.gain.value = eq.midGainDb;
          const high = ctx.createBiquadFilter();
          high.type = "highshelf";
          high.frequency.value = 8000;
          high.gain.value = eq.highGainDb;
          last.connect(low);
          low.connect(mid);
          mid.connect(high);
          last = high;
        }
        if (post.denoise.enabled) {
          const highPass = ctx.createBiquadFilter(); highPass.type = "highpass"; highPass.frequency.value = 75;
          const lowPass = ctx.createBiquadFilter(); lowPass.type = "lowpass"; lowPass.frequency.value = Math.max(8000, 18000 - post.denoise.amount * 180);
          last.connect(highPass); highPass.connect(lowPass); last = lowPass;
        }
        if (post.deEsser.enabled) {
          const deEsser = ctx.createBiquadFilter(); deEsser.type = "peaking"; deEsser.frequency.value = 4000 + post.deEsser.frequency * 5000; deEsser.Q.value = 2.5; deEsser.gain.value = -post.deEsser.intensity * 14;
          last.connect(deEsser); last = deEsser;
        }
        if (post.compressor.enabled) {
          const compressor = ctx.createDynamicsCompressor(); compressor.threshold.value = post.compressor.thresholdDb; compressor.knee.value = 6; compressor.ratio.value = post.compressor.ratio; compressor.attack.value = post.compressor.attackMs / 1000; compressor.release.value = post.compressor.releaseMs / 1000;
          const makeup = ctx.createGain(); makeup.gain.value = Math.pow(10, post.compressor.makeupDb / 20);
          last.connect(compressor); compressor.connect(makeup); last = makeup;
        }
        if (post.limiter.enabled) {
          const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = post.limiter.ceilingDb; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.05;
          last.connect(limiter); last = limiter;
        }
        if (useSidechain && isMusic && musicDuckGain) {
          last.connect(musicDuckGain);
        } else {
          last.connect(this.getMasterGain());
        }
        if (useSidechain && isVoice && voiceBus) {
          last.connect(voiceBus);
        }

        try {
          sourceNode.start(audioWhen, sourceStartOffset, remainingDuration);
        } catch {
          continue;
        }

        this.activeSources.push({
          clipId: clip.id,
          trackId: track.id,
          sourceNode,
          gainNode,
          pannerNode,
          clipVolume,
        });
      }
    }
  }

  pause() {
    this._isPlaying = false;
    this.stopAll();
  }

  seek(
    time: number,
    tracks: Track[],
    mediaUrls: Map<string, string>,
    options?: PlayOptions
  ) {
    if (this._isPlaying) {
      this.play(time, tracks, mediaUrls, options ?? { mixer: this.lastMixer ?? undefined });
    }
  }

  setClipVolume(clipId: string, volume: number) {
    const source = this.activeSources.find((s) => s.clipId === clipId);
    if (source) {
      source.clipVolume = Math.max(0, Math.min(2, volume));
      const trackVolume = this.lastMixer?.trackVolumes?.[source.trackId] ?? 1;
      source.gainNode.gain.setValueAtTime(source.clipVolume * trackVolume, this.getContext().currentTime);
    }
  }

  async preloadClips(tracks: Track[], mediaUrls: Map<string, string>) {
    const urls = new Set<string>();
    for (const track of tracks) {
      if (track.type !== "video" && track.type !== "audio") continue;
      for (const clip of track.clips) {
        if (clip.sourceMediaId) {
          const url = mediaUrls.get(clip.sourceMediaId);
          if (url) urls.add(url);
        }
      }
    }
    await Promise.allSettled([...urls].map((url) => this.loadBuffer(url)));
  }

  dispose() {
    this.stopAll();
    this.bufferCache.clear();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      this.masterGain = null;
      this.masterLimiter = null;
      this.loudnessShelf = null;
      this.loudnessHighPass = null;
      this.loudnessAnalyser = null;
      this.loudnessSink = null;
    }
  }
}
