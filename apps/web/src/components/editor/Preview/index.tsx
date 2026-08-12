"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { getPlaybackClockTime, usePlaybackStore } from "@/stores/playback.store";
import { useProjectStore } from "@/stores/project.store";
import { useTimelineStore } from "@/stores/timeline.store";
import { useMediaStore } from "@/stores/media.store";
import { useSequenceStore } from "@/stores/sequence.store";
import { useAudioMeterStore } from "@/stores/audio-meter.store";
import { useUIStore } from "@/stores/ui.store";
import {
  createCompositor,
  type TempoCompositor,
} from "@/engine/compositor";
import { AudioEngine } from "@/engine/audio-engine";
import { resolveMediaUrl } from "@/lib/media-url";
import { onFontReady } from "@/lib/fonts";
import { onLutReady } from "@/lib/luts";
import { previewRenderDimensions } from "@/engine/preview-resolution";
import { listDeliveryProfiles, reflowTracksForComposition, resolveDeliveryProfile } from "@tempo/editor-core";
import type { NormalizedRect } from "@tempo/types";
import { ScopesPanel } from "./ScopesPanel";
import { TrackingOverlay } from "@/components/editor/TrackingWorkspace/TrackingOverlay";
import { MotionPathOverlay } from "@/components/editor/MotionGraphWorkspace/MotionPathOverlay";

const DELIVERY_PROFILES = listDeliveryProfiles();

function guideStyle(rect: NormalizedRect) {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

function renderPreviewFrame(
  compositor: TempoCompositor | null,
  time: number,
  playing: boolean
) {
  if (!compositor) return;
  const tracks = useTimelineStore.getState().tracks;
  const transitions = useTimelineStore.getState().transitions;
  const sequences = useSequenceStore.getState().sequences;
  const { cameras, lights, settings } = useProjectStore.getState();
  return compositor.renderFrame(time, tracks, playing, transitions, sequences, {
    cameras,
    lights,
    deliveryProfile: resolveDeliveryProfile(settings),
  });
}

export function Preview() {
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const togglePlay = usePlaybackStore((s) => s.togglePlay);
  const seek = usePlaybackStore((s) => s.seek);
  const duration = usePlaybackStore((s) => s.duration);
  const settings = useProjectStore((s) => s.settings);
  const updateSettings = useProjectStore((s) => s.updateSettings);
  const audioMixer = useProjectStore((s) => s.audioMixer);
  const tracks = useTimelineStore((s) => s.tracks);
  const transitions = useTimelineStore((s) => s.transitions);
  const sequences = useSequenceStore((s) => s.sequences);
  const cameras = useProjectStore((s) => s.cameras);
  const lights = useProjectStore((s) => s.lights);
  const editStack = useSequenceStore((s) => s.editStack);
  const mediaAssets = useMediaStore((s) => s.assets);
  const previewQuality = useUIStore((s) => s.previewQuality);
  const setPreviewQuality = useUIStore((s) => s.setPreviewQuality);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositorRef = useRef<TempoCompositor | null>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const rafRef = useRef<number>(0);
  const prevIsPlaying = useRef(false);
  const lastAudioSyncTime = useRef(0);
  const lastTrackAudioKey = useRef("");
  const [gpuError, setGpuError] = useState<string | null>(null);
  const [gpuReady, setGpuReady] = useState(false);
  const [gpuBackend, setGpuBackend] = useState("");
  const [showScopes, setShowScopes] = useState(false);
  const [showGuides, setShowGuides] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<"idle" | "warming" | "ready">("idle");
  const [scopeSourceCanvas, setScopeSourceCanvas] = useState<HTMLCanvasElement | null>(null);

  const mediaUrlMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const asset of mediaAssets) {
      const useProxy = previewQuality === "proxy" || (previewQuality === "auto" && Boolean(asset.proxyUrl));
      const url = resolveMediaUrl(useProxy ? asset.proxyUrl : asset.url);
      if (url) map.set(asset.id, url);
    }
    return map;
  }, [mediaAssets, previewQuality]);

  const trackAudioKey = useMemo(() => {
    const roles = audioMixer.trackRoles || {};
    const duck = audioMixer.duck;
    const duckKey = duck
      ? `${duck.enabled}:${duck.level}:${duck.attackSec}:${duck.releaseSec}`
      : "off";
    const roleKey = Object.keys(roles)
      .sort()
      .map((id) => `${id}:${roles[id]}`)
      .join(",");
    const trackKey = tracks
      .map(
        (t) =>
          `${t.id}:${t.visible}:${t.solo}:${t.clips.length}:${t.clips
            .map(
              (c) =>
                `${c.id}:${c.sourceMediaId ?? ""}:${c.startTime}:${c.duration}:${c.sourceOffset}:${c.speed}:${Boolean(c.reversed)}:${JSON.stringify(c.speedRamp || null)}:${JSON.stringify(c.hold || null)}:${JSON.stringify(c.multicam || null)}:${c.muted}:${c.volume}:${c.pan ?? 0}:${c.fadeInSec ?? 0}:${c.fadeOutSec ?? 0}:${JSON.stringify(c.audioAutomation || {})}`
            )
            .join(",")}`
      )
      .join("|");
    return `${trackKey}#roles=${roleKey}#duck=${duckKey}#trackPans=${JSON.stringify(audioMixer.trackPans || {})}#automation=${JSON.stringify(audioMixer.trackAutomation || {})}`;
  }, [tracks, audioMixer.trackRoles, audioMixer.duck, audioMixer.trackPans, audioMixer.trackAutomation]);

  const audioGraphKey = useMemo(
    () => JSON.stringify({ eq: audioMixer.trackEq || {}, post: audioMixer.trackPost || {}, mastering: audioMixer.mastering || {} }),
    [audioMixer.trackEq, audioMixer.trackPost, audioMixer.mastering]
  );

  useEffect(() => {
    let cancelled = false;
    let unsubscribeDeviceLost: () => void = () => {};
    const canvas = canvasRef.current;
    if (!canvas) return;

    setGpuReady(false);
    setGpuError(null);
    setGpuBackend("");
    compositorRef.current?.dispose();
    compositorRef.current = null;

    void (async () => {
      const monitor = canvas.parentElement?.getBoundingClientRect();
      const previewSize = previewRenderDimensions(
        settings.width,
        settings.height,
        monitor?.width || 0,
        monitor?.height || 0,
        window.devicePixelRatio || 1,
        previewQuality
      );
      const result = await createCompositor(
        canvas,
        settings.width,
        settings.height,
        previewSize.width,
        previewSize.height
      );
      if (cancelled) {
        if (result.ok) result.compositor.dispose();
        return;
      }
      if (!result.ok) {
        setGpuError(result.reason);
        setGpuReady(false);
        return;
      }
      compositorRef.current = result.compositor;
      unsubscribeDeviceLost = result.compositor.onDeviceLost((detail) => {
        if (cancelled) return;
        usePlaybackStore.getState().pause();
        setGpuReady(false);
        setGpuError(
          `The GPU device crashed and the preview was stopped.\n\n${detail}\n\n` +
          "Close this Chrome window and reopen Tempo with: pnpm browser:gpu"
        );
      });
      const backend = result.compositor.backendInfo;
      setGpuBackend(
        [backend.vendor, backend.architecture]
          .filter((value) => value && value !== "unknown")
          .join(" ")
          .toUpperCase()
      );
      setGpuReady(true);
      setGpuError(null);
    })();

    audioRef.current = new AudioEngine();
    const unsubscribeLoudness = audioRef.current.subscribeLoudness((reading) => {
      useAudioMeterStore.getState().setMeter(reading);
    });
    return () => {
      cancelled = true;
      unsubscribeDeviceLost();
      compositorRef.current?.dispose();
      compositorRef.current = null;
      audioRef.current?.dispose();
      audioRef.current = null;
      unsubscribeLoudness();
      useAudioMeterStore.getState().resetMeter();
      setGpuReady(false);
    };
  }, [settings.width, settings.height, previewQuality]);

  useEffect(() => {
    setScopeSourceCanvas(gpuReady ? canvasRef.current : null);
  }, [gpuReady]);

  useEffect(() => {
    let maxEnd = 0;
    for (const track of tracks) {
      for (const clip of track.clips) {
        maxEnd = Math.max(maxEnd, clip.startTime + clip.duration);
      }
    }
    const next = Math.max(maxEnd, settings.duration || 0);
    if (next > 0 && next !== duration) {
      usePlaybackStore.getState().setDuration(next);
    }
  }, [tracks, settings.duration, duration]);

  useEffect(() => {
    audioRef.current?.preloadClips(tracks, mediaUrlMap);
  }, [tracks, mediaUrlMap]);

  useEffect(() => {
    if (!gpuReady) return;
    compositorRef.current?.invalidate();
    if (!usePlaybackStore.getState().isPlaying) {
      void renderPreviewFrame(
        compositorRef.current,
        usePlaybackStore.getState().currentTime,
        false
      );
    }
  }, [mediaAssets, previewQuality, gpuReady, cameras, lights]);

  // Idle look-ahead only: predecoding never steals the active playback decoder.
  useEffect(() => {
    if (isPlaying || !gpuReady || !compositorRef.current) return;
    const timer = window.setTimeout(() => {
      setCacheStatus("warming");
      void compositorRef.current?.prewarmFrames(currentTime, tracks, 2)
        .then(() => setCacheStatus("ready"))
        .catch(() => setCacheStatus("idle"));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [currentTime, tracks, isPlaying, gpuReady, previewQuality]);

  useEffect(() => {
    if (!gpuReady) return;
    return onFontReady(() => {
      compositorRef.current?.invalidate();
      if (!usePlaybackStore.getState().isPlaying) {
        void renderPreviewFrame(
          compositorRef.current,
          usePlaybackStore.getState().currentTime,
          false
        );
      }
    });
  }, [gpuReady]);

  useEffect(() => {
    if (!gpuReady) return;
    return onLutReady(() => {
      compositorRef.current?.clearLutTextureCache();
      compositorRef.current?.invalidate();
      if (!usePlaybackStore.getState().isPlaying) {
        void renderPreviewFrame(
          compositorRef.current,
          usePlaybackStore.getState().currentTime,
          false
        );
      }
    });
  }, [gpuReady]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying && !prevIsPlaying.current) {
      audio.play(currentTime, tracks, mediaUrlMap, { mixer: audioMixer });
      lastAudioSyncTime.current = currentTime;
      lastTrackAudioKey.current = trackAudioKey;
    } else if (!isPlaying && prevIsPlaying.current) {
      audio.pause();
      compositorRef.current?.pauseMedia();
    }
    prevIsPlaying.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !isPlaying) {
      lastAudioSyncTime.current = currentTime;
      return;
    }
    const delta = Math.abs(currentTime - lastAudioSyncTime.current);
    lastAudioSyncTime.current = currentTime;
    if (delta > 0.25) {
      audio.seek(currentTime, tracks, mediaUrlMap, { mixer: audioMixer });
    }
  }, [currentTime, isPlaying]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !isPlaying) return;
    // Flat gain rewrite cancels duck envelopes — reschedule when ducking is on
    // or roles/duck settings changed (also covered by trackAudioKey).
    if (audioMixer.duck?.enabled) {
      audio.play(
        usePlaybackStore.getState().currentTime,
        useTimelineStore.getState().tracks,
        mediaUrlMap,
        { mixer: audioMixer }
      );
      return;
    }
    audio.applyLiveMixer(useTimelineStore.getState().tracks, audioMixer);
  }, [audioMixer, isPlaying, mediaUrlMap]);

  // Track cleanup/dynamics nodes are created per source, so rebuild only when
  // their post chain changes (not on ordinary fader movement).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !isPlaying) return;
    audio.play(usePlaybackStore.getState().currentTime, tracks, mediaUrlMap, { mixer: audioMixer });
  }, [audioGraphKey]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !isPlaying) {
      lastTrackAudioKey.current = trackAudioKey;
      return;
    }
    if (trackAudioKey === lastTrackAudioKey.current) return;
    lastTrackAudioKey.current = trackAudioKey;
    audio.play(
      usePlaybackStore.getState().currentTime,
      useTimelineStore.getState().tracks,
      mediaUrlMap,
      { mixer: useProjectStore.getState().audioMixer }
    );
  }, [trackAudioKey, isPlaying, mediaUrlMap]);

  useEffect(() => {
    if (!isPlaying || !gpuReady) return;

    let active = true;
    let rendering = false;
    let lastSubmittedAt = 0;
    const minimumFrameInterval = 1000 / Math.min(60, Math.max(1, settings.fps || 30));
    const loop = (now: number) => {
      if (!active) return;
      if (!rendering && now - lastSubmittedAt >= minimumFrameInterval) {
        rendering = true;
        lastSubmittedAt = now;
        const t = getPlaybackClockTime();
        Promise.resolve(renderPreviewFrame(compositorRef.current, t, true))
          .catch(() => undefined)
          .finally(() => {
            rendering = false;
          });
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      active = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, gpuReady, settings.fps]);

  useEffect(() => {
    if (isPlaying || !gpuReady) return;

    let cancelled = false;
    compositorRef.current?.invalidate();

    const renderWithRetry = async () => {
      const maxRetries = 15;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (cancelled) return;
        const result = await renderPreviewFrame(
          compositorRef.current,
          usePlaybackStore.getState().currentTime,
          false
        );
        if (!result?.pending || cancelled) return;
        const delay = attempt < 3 ? 100 : attempt < 8 ? 200 : 400;
        await new Promise((r) => setTimeout(r, delay));
      }
    };

    void renderWithRetry();

    return () => {
      cancelled = true;
    };
  }, [isPlaying, currentTime, tracks, transitions, sequences, gpuReady]);

  function formatTime(seconds: number) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const f = Math.floor((seconds % 1) * settings.fps);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}:${f
      .toString()
      .padStart(2, "0")}`;
  }

  const frameDuration = 1 / (settings.fps || 30);
  const deliveryProfile = useMemo(() => resolveDeliveryProfile(settings), [settings]);
  const ctxLabel =
    editStack.length > 1
      ? `Sequence: ${useSequenceStore.getState().activeSequenceName() || "…"}`
      : "Main";

  return (
    <div className="h-full flex flex-col bg-[var(--bg-primary)]">
      <div className="flex-1 flex items-center justify-center p-4 overflow-hidden">
        <div
          className="relative bg-zinc-950 border border-[var(--border-default)] rounded-[var(--radius-md)] overflow-hidden shadow-sm"
          style={{
            aspectRatio: `${settings.width} / ${settings.height}`,
            maxHeight: "100%",
            maxWidth: "100%",
          }}
        >
          <canvas
            ref={canvasRef}
            className="w-full h-full"
            style={{ display: gpuError ? "none" : "block" }}
          />

          <TrackingOverlay />
          <MotionPathOverlay />

          {showGuides && !gpuError ? (
            <div className="pointer-events-none absolute inset-0 z-[18] overflow-hidden" aria-label="Delivery safe-area guides">
              {deliveryProfile.uiOcclusionZones.map((zone) => (
                <div
                  key={zone.id}
                  className="absolute border border-red-400/35 bg-red-500/10"
                  style={guideStyle(zone.rect)}
                  title={zone.label}
                />
              ))}
              <div className="absolute border border-dashed border-emerald-400/70" style={guideStyle(deliveryProfile.actionSafe)}>
                <span className="absolute left-0 top-0 bg-emerald-950/80 px-1 text-[8px] text-emerald-300">ACTION</span>
              </div>
              <div className="absolute border border-dashed border-amber-300/80" style={guideStyle(deliveryProfile.titleSafe)}>
                <span className="absolute left-0 top-0 bg-amber-950/80 px-1 text-[8px] text-amber-200">TITLE</span>
              </div>
              <div className="absolute border border-dotted border-cyan-300/80" style={guideStyle(deliveryProfile.captionSafe)}>
                <span className="absolute bottom-0 left-0 bg-cyan-950/80 px-1 text-[8px] text-cyan-200">CAPTION</span>
              </div>
            </div>
          ) : null}

          {gpuError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center bg-zinc-950">
              <p className="text-sm font-medium text-zinc-100">WebGPU required</p>
              <p className="text-xs text-zinc-400 max-w-sm leading-relaxed whitespace-pre-line">
                {gpuError}
              </p>
            </div>
          )}

          {!gpuError && (
            <>
              <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-zinc-900/80 border border-zinc-800 text-[10px] text-zinc-300 font-mono">
                {ctxLabel}
              </div>
              <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-zinc-900/80 border border-zinc-800 text-[10px] text-zinc-400 font-mono">
                {settings.width}x{settings.height} · {previewQuality === "original" ? "Original" : previewQuality === "proxy" ? "Proxy" : "Auto"} · WebGPU{gpuBackend ? ` · ${gpuBackend}` : ""}
              </div>
              {showScopes && <ScopesPanel sourceCanvas={scopeSourceCanvas} frameKey={currentTime} />}
            </>
          )}
        </div>
      </div>

      <div className="h-10 bg-[var(--bg-secondary)] border-t border-[var(--border-default)] flex items-center justify-between px-4 flex-shrink-0">
        <span className="font-mono text-xs text-[var(--text-muted)] w-24">
          {formatTime(currentTime)}
        </span>

        <div className="flex items-center gap-1">
          <select
            value={deliveryProfile.id === "custom" ? "custom" : deliveryProfile.id}
            onChange={(event) => {
              const profile = DELIVERY_PROFILES.find((candidate) => candidate.id === event.target.value);
              if (!profile) return;
              if (profile.width !== settings.width || profile.height !== settings.height) {
                useTimelineStore.getState().setTracks(reflowTracksForComposition(
                  useTimelineStore.getState().tracks,
                  { width: settings.width, height: settings.height },
                  { width: profile.width, height: profile.height }
                ));
              }
              updateSettings({ width: profile.width, height: profile.height, fps: profile.fps, deliveryProfile: profile });
            }}
            className="h-6 max-w-28 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1 text-[9px] text-[var(--text-muted)]"
            title="Delivery format and composition size"
          >
            {deliveryProfile.id === "custom" ? <option value="custom">Custom {settings.width}×{settings.height}</option> : null}
            {DELIVERY_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
          </select>
          <select value={previewQuality} onChange={(event) => setPreviewQuality(event.target.value as "auto" | "proxy" | "original")} className="h-6 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1 text-[9px] text-[var(--text-muted)]" title="Preview media quality; exports always use originals">
            <option value="auto">Auto</option>
            <option value="proxy">Proxy</option>
            <option value="original">Full</option>
          </select>
          <button onClick={() => { compositorRef.current?.clearMediaCache(); setCacheStatus("idle"); }} className="px-1.5 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]" title="Clear decoded preview cache">
            Cache {isPlaying ? "" : cacheStatus === "warming" ? "…" : cacheStatus === "ready" ? "✓" : ""}
          </button>
          <button
            onClick={() => setShowGuides((visible) => !visible)}
            className={`px-1.5 py-1 rounded text-[10px] transition-colors ${showGuides ? "bg-zinc-700 text-zinc-100" : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"}`}
            title="Toggle action, title, caption, and platform UI safety guides"
            disabled={!!gpuError}
          >
            Guides
          </button>
          <button
            onClick={() => setShowScopes((visible) => !visible)}
            className={`px-1.5 py-1 rounded text-[10px] transition-colors ${showScopes ? "bg-zinc-700 text-zinc-100" : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"}`}
            title="Toggle color scopes"
            disabled={!!gpuError}
          >
            Scopes
          </button>
          <button
            onClick={() => seek(0)}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Skip to start (Home)"
            disabled={!!gpuError}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.75 19.5l-7.5-7.5 7.5-7.5m-6 15L5.25 12l7.5-7.5" />
            </svg>
          </button>

          <button
            onClick={() => seek(currentTime - frameDuration)}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Previous frame (Left Arrow)"
            disabled={!!gpuError}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 16.811c0 .864-.933 1.406-1.683.977l-7.108-4.062a1.125 1.125 0 0 1 0-1.953l7.108-4.062A1.125 1.125 0 0 1 21 8.688v8.123ZM11.25 16.811c0 .864-.933 1.406-1.683.977l-7.108-4.062a1.125 1.125 0 0 1 0-1.953l7.108-4.062a1.125 1.125 0 0 1 1.683.977v8.123Z" />
            </svg>
          </button>

          <button
            onClick={togglePlay}
            className="p-1.5 rounded bg-zinc-100 hover:bg-zinc-200 text-zinc-950 transition-colors disabled:opacity-40"
            title="Play/Pause (Space)"
            disabled={!!gpuError}
          >
            {isPlaying ? (
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path fillRule="evenodd" d="M6.75 5.25a.75.75 0 0 1 .75-.75H9a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H7.5a.75.75 0 0 1-.75-.75V5.25Zm7.5 0A.75.75 0 0 1 15 4.5h1.5a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H15a.75.75 0 0 1-.75-.75V5.25Z" clipRule="evenodd" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path fillRule="evenodd" d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653Z" clipRule="evenodd" />
              </svg>
            )}
          </button>

          <button
            onClick={() => seek(currentTime + frameDuration)}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Next frame (Right Arrow)"
            disabled={!!gpuError}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.689c0-.864.933-1.406 1.683-.977l7.108 4.062a1.125 1.125 0 0 1 0 1.953l-7.108 4.062A1.125 1.125 0 0 1 3 16.811V8.69ZM12.75 8.689c0-.864.933-1.406 1.683-.977l7.108 4.062a1.125 1.125 0 0 1 0 1.953l-7.108 4.062a1.125 1.125 0 0 1-1.683-.977V8.69Z" />
            </svg>
          </button>

          <button
            onClick={() => seek(duration)}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Skip to end (End)"
            disabled={!!gpuError}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 4.5l7.5 7.5-7.5 7.5m6-15l7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        </div>

        <span className="font-mono text-xs text-[var(--text-muted)] w-24 text-right">
          {formatTime(duration || settings.duration)}
        </span>
      </div>
    </div>
  );
}
