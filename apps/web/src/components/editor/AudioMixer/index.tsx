"use client";

import { useTimelineStore } from "@/stores/timeline.store";
import { useProjectStore } from "@/stores/project.store";
import { usePlaybackStore } from "@/stores/playback.store";
import { useSelectionStore } from "@/stores/selection.store";
import type { TrackAudioRole } from "@tempo/types";
import { audioAutomationValueAt, normalizeAudioAutomationPoints, normalizeDuckSettings, normalizeMastering, normalizeTrackAudioPost } from "@tempo/editor-core";
import { useAudioMeterStore } from "@/stores/audio-meter.store";

let copiedClipAutomation: { volume: Array<{ time: number; value: number; interpolation?: "linear" | "hold" }>; pan: Array<{ time: number; value: number; interpolation?: "linear" | "hold" }> } | null = null;

export function AudioMixer() {
  const tracks = useTimelineStore((s) => s.tracks);
  const audioMixer = useProjectStore((s) => s.audioMixer);
  const setAudioMixer = useProjectStore((s) => s.setAudioMixer);
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds);
  const updateClipProperty = useTimelineStore((s) => s.updateClipProperty);

  const audioTracks = tracks.filter(
    (t) => t.type === "audio" || t.type === "video"
  );

  const duck = normalizeDuckSettings(audioMixer.duck);
  const mastering = normalizeMastering(audioMixer.mastering);
  const meter = useAudioMeterStore();
  const format = (value: number | null) => value == null || !Number.isFinite(value) ? "—" : value.toFixed(1);

  function setTrackVolume(trackId: string, volume: number) {
    setAudioMixer({
      ...audioMixer,
      trackVolumes: { ...audioMixer.trackVolumes, [trackId]: volume },
    });
  }

  function setTrackPan(trackId: string, pan: number) {
    setAudioMixer({ ...audioMixer, trackPans: { ...(audioMixer.trackPans || {}), [trackId]: pan } });
  }

  function addTrackAutomationPoint(trackId: string, property: "volume" | "pan") {
    const current = audioMixer.trackAutomation?.[trackId]?.[property] || [];
    const fallback = property === "volume" ? 1 : 0;
    const value = audioAutomationValueAt(current, property, currentTime, fallback);
    const next = normalizeAudioAutomationPoints(
      [...current.filter((point) => Math.abs(point.time - currentTime) > 0.001), { id: crypto.randomUUID(), time: currentTime, value, interpolation: "linear" }],
      property
    );
    setAudioMixer({
      ...audioMixer,
      trackAutomation: {
        ...(audioMixer.trackAutomation || {}),
        [trackId]: { ...(audioMixer.trackAutomation?.[trackId] || {}), [property]: next },
      },
    });
  }

  const selectedClip = tracks.flatMap((track) => track.clips).find((clip) => selectedClipIds.has(clip.id));

  function addSelectedClipAutomationPoint(property: "volume" | "pan") {
    if (!selectedClip) return;
    const localTime = Math.max(0, Math.min(selectedClip.duration, currentTime - selectedClip.startTime));
    const current = selectedClip.audioAutomation?.[property] || [];
    const fallback = property === "volume" ? 1 : 0;
    const value = audioAutomationValueAt(current, property, localTime, fallback);
    const next = normalizeAudioAutomationPoints(
      [...current.filter((point) => Math.abs(point.time - localTime) > 0.001), { id: crypto.randomUUID(), time: localTime, value, interpolation: "linear" }],
      property,
      selectedClip.duration
    );
    updateClipProperty(selectedClip.id, "audioAutomation", { ...(selectedClip.audioAutomation || {}), [property]: next });
  }

  function copySelectedClipAutomation() {
    if (!selectedClip) return;
    copiedClipAutomation = {
      volume: (selectedClip.audioAutomation?.volume || []).map(({ time, value, interpolation }) => ({ time, value, interpolation })),
      pan: (selectedClip.audioAutomation?.pan || []).map(({ time, value, interpolation }) => ({ time, value, interpolation })),
    };
  }

  function pasteSelectedClipAutomation() {
    if (!selectedClip || !copiedClipAutomation) return;
    updateClipProperty(selectedClip.id, "audioAutomation", {
      volume: normalizeAudioAutomationPoints(copiedClipAutomation.volume.map((point) => ({ ...point, id: crypto.randomUUID() })), "volume", selectedClip.duration),
      pan: normalizeAudioAutomationPoints(copiedClipAutomation.pan.map((point) => ({ ...point, id: crypto.randomUUID() })), "pan", selectedClip.duration),
    });
  }

  function toggleTrackMute(trackId: string) {
    const current = audioMixer.trackMutes[trackId] ?? false;
    setAudioMixer({
      ...audioMixer,
      trackMutes: { ...audioMixer.trackMutes, [trackId]: !current },
    });
  }

  function setTrackRole(trackId: string, role: TrackAudioRole) {
    setAudioMixer({
      ...audioMixer,
      trackRoles: { ...(audioMixer.trackRoles || {}), [trackId]: role },
    });
  }

  function setMasterVolume(volume: number) {
    setAudioMixer({ ...audioMixer, masterVolume: volume });
  }

  function patchDuck(partial: Partial<typeof duck>) {
    setAudioMixer({
      ...audioMixer,
      duck: normalizeDuckSettings({ ...duck, ...partial }),
    });
  }

  function patchMastering(partial: Partial<typeof mastering>) {
    setAudioMixer({ ...audioMixer, mastering: normalizeMastering({ ...mastering, ...partial }) });
  }

  function toggleVoicePost(trackId: string) {
    const current = normalizeTrackAudioPost(audioMixer.trackPost?.[trackId]);
    const enabled = !(current.denoise.enabled || current.deEsser.enabled || current.compressor.enabled || current.limiter.enabled);
    const post = enabled
      ? normalizeTrackAudioPost({ denoise: { enabled: true, amount: 10 }, deEsser: { enabled: true, intensity: 0.35, frequency: 0.55 }, compressor: { enabled: true, thresholdDb: -20, ratio: 3, attackMs: 12, releaseMs: 140, makeupDb: 3 }, limiter: { enabled: true, ceilingDb: -1 } })
      : normalizeTrackAudioPost({});
    setAudioMixer({ ...audioMixer, trackPost: { ...(audioMixer.trackPost || {}), [trackId]: post } });
  }

  return (
    <div className="h-full flex flex-col bg-[var(--bg-secondary)] border-t border-[var(--border-default)]">
      <div className="h-8 flex items-center justify-between px-3 border-b border-[var(--border-default)] flex-shrink-0 gap-2">
        <span className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
          Audio Mixer
        </span>
        <label className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={duck.enabled}
            onChange={(e) => patchDuck({ enabled: e.target.checked })}
          />
          Duck
        </label>
        <label className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
          <input type="checkbox" checked={mastering.loudnessEnabled} onChange={(e) => patchMastering({ loudnessEnabled: e.target.checked })} />
          LUFS
        </label>
      </div>

      {duck.enabled && (
        <div className="px-3 py-1.5 border-b border-[var(--border-default)] flex items-center gap-3 flex-shrink-0 flex-wrap">
          <label className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
            Mode
            <select
              value={duck.mode || "rule"}
              onChange={(e) =>
                patchDuck({
                  mode: e.target.value === "sidechain" ? "sidechain" : "rule",
                })
              }
              className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[10px] px-1"
            >
              <option value="rule">Rule</option>
              <option value="sidechain">Sidechain</option>
            </select>
          </label>
          <label className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
            Level
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={duck.level}
              onChange={(e) => patchDuck({ level: parseFloat(e.target.value) })}
              className="w-20 accent-zinc-200"
            />
            <span className="font-mono w-7">{Math.round(duck.level * 100)}</span>
          </label>
        </div>
      )}

      <div className="px-3 py-1 border-b border-[var(--border-default)] flex items-center gap-2 flex-wrap text-[9px] font-mono text-[var(--text-muted)]">
        <span>M {format(meter.momentaryLufs)}</span>
        <span>S {format(meter.shortTermLufs)}</span>
        <span className={meter.integratedLufs != null && Math.abs(meter.integratedLufs - mastering.targetLufs) <= 1 ? "text-emerald-300" : "text-amber-300"}>I {format(meter.integratedLufs)} / {mastering.targetLufs}</span>
        <span className={meter.peakDbfs != null && meter.peakDbfs > mastering.ceilingDb + 0.2 ? "text-red-300" : ""}>Pk {format(meter.peakDbfs)} dBFS</span>
        <span className="text-[8px] text-[var(--text-muted)]">live estimate · export verifies LUFS</span>
      </div>

      <div className="px-3 py-1.5 border-b border-[var(--border-default)] flex items-center gap-1.5 text-[9px] text-[var(--text-muted)]">
        <span className="font-mono">AUTO {currentTime.toFixed(2)}s</span>
        <button disabled={!selectedClip} onClick={() => addSelectedClipAutomationPoint("volume")} className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] disabled:opacity-40 hover:text-white" title="Add clip volume point at playhead">Clip +V</button>
        <button disabled={!selectedClip} onClick={() => addSelectedClipAutomationPoint("pan")} className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] disabled:opacity-40 hover:text-white" title="Add clip pan point at playhead">Clip +P</button>
        <button disabled={!selectedClip} onClick={copySelectedClipAutomation} className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] disabled:opacity-40 hover:text-white">Copy</button>
        <button disabled={!selectedClip || !copiedClipAutomation} onClick={pasteSelectedClipAutomation} className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] disabled:opacity-40 hover:text-white">Paste</button>
      </div>

      <div className="flex-1 overflow-x-auto p-2">
        <div className="flex gap-3 items-end h-full min-h-[120px]">
          {audioTracks.map((track) => {
            const volume = audioMixer.trackVolumes[track.id] ?? 1;
            const muted = audioMixer.trackMutes[track.id] ?? false;
            const pan = audioMixer.trackPans?.[track.id] ?? 0;
            const role = (audioMixer.trackRoles?.[track.id] || "other") as TrackAudioRole;

            return (
              <div
                key={track.id}
                className="flex flex-col items-center gap-1.5 min-w-[48px]"
              >
                <span className="text-[9px] font-mono text-[var(--text-muted)]">
                  {muted ? "M" : `${Math.round(volume * 100)}`}
                </span>

                <div className="relative h-20 w-5 flex items-center justify-center">
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={muted ? 0 : volume}
                    onChange={(e) =>
                      setTrackVolume(track.id, parseFloat(e.target.value))
                    }
                    className="h-20 accent-zinc-100"
                    style={{
                      writingMode: "vertical-lr",
                      direction: "rtl",
                      width: "16px",
                      WebkitAppearance: "slider-vertical",
                    }}
                  />
                </div>

                <button
                  onClick={() => toggleTrackMute(track.id)}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
                    muted
                      ? "bg-red-600 text-white"
                      : "bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  M
                </button>

                <select
                  value={role}
                  onChange={(e) =>
                    setTrackRole(track.id, e.target.value as TrackAudioRole)
                  }
                  className="w-[48px] text-[8px] bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[var(--text-muted)]"
                  title="Audio role"
                >
                  <option value="other">—</option>
                  <option value="music">mus</option>
                  <option value="voice">vox</option>
                </select>

                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.01}
                  value={pan}
                  onChange={(e) => setTrackPan(track.id, Number(e.target.value))}
                  className="w-11 accent-cyan-300"
                  title={`Static pan ${Math.round(pan * 100)}`}
                />
                <div className="flex gap-0.5">
                  <button onClick={() => addTrackAutomationPoint(track.id, "volume")} className="px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[8px] hover:text-white" title="Add track volume automation point at playhead">+V</button>
                  <button onClick={() => addTrackAutomationPoint(track.id, "pan")} className="px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[8px] hover:text-white" title="Add track pan automation point at playhead">+P</button>
                </div>

                <button onClick={() => toggleVoicePost(track.id)} className={`px-1 py-0.5 rounded text-[8px] ${Object.values(normalizeTrackAudioPost(audioMixer.trackPost?.[track.id])).some((value) => value.enabled) ? "bg-cyan-900 text-cyan-100" : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"}`} title="Toggle clean dialogue chain">FX</button>

                <span className="text-[9px] text-[var(--text-muted)] truncate max-w-[48px] text-center">
                  {track.name}
                </span>
              </div>
            );
          })}

          {audioTracks.length > 0 && (
            <div className="w-px h-24 bg-[var(--border-default)] self-center mx-1" />
          )}

          <div className="flex flex-col items-center gap-1.5 min-w-[48px]">
            <span className="text-[9px] font-mono text-[var(--text-muted)]">
              {Math.round(audioMixer.masterVolume * 100)}
            </span>

            <div className="relative h-20 w-5 flex items-center justify-center">
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={audioMixer.masterVolume}
                onChange={(e) => setMasterVolume(parseFloat(e.target.value))}
                className="h-20 accent-amber-400"
                style={{
                  writingMode: "vertical-lr",
                  direction: "rtl",
                  width: "16px",
                  WebkitAppearance: "slider-vertical",
                }}
              />
            </div>

            <span className="text-[9px] font-bold text-amber-400">MST</span>
            <input type="number" min={-30} max={-5} step={1} value={mastering.targetLufs} onChange={(e) => patchMastering({ targetLufs: Number(e.target.value) })} className="w-11 px-0.5 py-0.5 font-mono bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[8px] text-[var(--text-primary)]" title="Export LUFS target" />
          </div>

          {audioTracks.length === 0 && (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-[11px] text-[var(--text-muted)]">No audio tracks</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
