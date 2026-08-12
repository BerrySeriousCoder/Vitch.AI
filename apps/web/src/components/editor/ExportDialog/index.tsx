"use client";

import { useEffect, useState, useMemo } from "react";
import { toast } from "sonner";
import { useUIStore } from "@/stores/ui.store";
import { useProjectStore } from "@/stores/project.store";
import { useRenderStore } from "@/stores/render.store";
import { resolveMediaUrl } from "@/lib/media-url";
import type { ExportColorSpace, QualityPreset, VideoCodec } from "@tempo/types";

const QUALITY_PRESETS = [
  { value: "draft", name: "Draft", h264Crf: 26, h265Crf: 28, speed: "fast", bitrate: "4000k", audioBitrate: "128k" },
  { value: "standard", name: "Standard", h264Crf: 20, h265Crf: 22, speed: "balanced", bitrate: "8000k", audioBitrate: "192k" },
  { value: "high", name: "High", h264Crf: 17, h265Crf: 19, speed: "recommended", bitrate: "16000k", audioBitrate: "256k" },
  { value: "ultra", name: "Ultra", h264Crf: 14, h265Crf: 16, speed: "near-master", bitrate: "30000k", audioBitrate: "320k" },
];

const CODECS: Array<{ value: VideoCodec; label: string; detail: string }> = [
  { value: "h264", label: "H.264", detail: "SDR delivery" },
  { value: "h265", label: "HEVC Main10", detail: "SDR / HDR" },
  { value: "prores-422-hq", label: "ProRes 422 HQ", detail: "10-bit master" },
  { value: "prores-4444", label: "ProRes 4444", detail: "10-bit 4:4:4 master" },
  { value: "dnxhr-hqx", label: "DNxHR HQX", detail: "10-bit master" },
  { value: "dnxhr-444", label: "DNxHR 444", detail: "10-bit 4:4:4 master" },
];

const COLOR_SPACES: Array<{ value: ExportColorSpace; label: string; detail: string }> = [
  { value: "rec709", label: "Rec.709 SDR", detail: "Universal web and social delivery" },
  { value: "rec2100-pq", label: "Rec.2100 PQ · HDR10", detail: "BT.2020, PQ, static HDR10 metadata" },
  { value: "rec2100-hlg", label: "Rec.2100 HLG", detail: "BT.2020, broadcast-compatible HLG" },
];

export function ExportDialog() {
  const isOpen = useUIStore((s) => s.panels.exportDialog);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const projectId = useProjectStore((s) => s.id);
  const projectSettings = useProjectStore((s) => s.settings);
  const { jobs, activeJobId, isLoading, startRender, loadJobs } = useRenderStore();

  const [resolution, setResolution] = useState(0);
  const [fps, setFps] = useState(30);
  const [codec, setCodec] = useState<VideoCodec>("h264");
  const [colorSpace, setColorSpace] = useState<ExportColorSpace>("rec709");
  const [quality, setQuality] = useState(2);
  const [maxLuminance, setMaxLuminance] = useState(1000);
  const [maxCll, setMaxCll] = useState(1000);
  const [maxFall, setMaxFall] = useState(400);

  const activeJob = useMemo(() => {
    const actuallyRunning = jobs.find((job) =>
      ["processing", "encoding", "uploading"].includes(job.status)
    );
    const waiting = jobs.find((job) => job.status === "queued");
    return actuallyRunning || waiting || (activeJobId ? jobs.find((job) => job.id === activeJobId) : null);
  },
    [activeJobId, jobs]
  );
  const hasLiveRender = jobs.some((job) =>
    ["queued", "processing", "encoding", "uploading"].includes(job.status)
  );

  const resolutionPresets = useMemo(() => {
    const longEdge = Math.max(projectSettings.width, projectSettings.height);
    const atLongEdge = (target: number) => {
      const scale = target / longEdge;
      const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
      return { width: even(projectSettings.width * scale), height: even(projectSettings.height * scale) };
    };
    const candidates = [
      { label: `Current project (${projectSettings.width}×${projectSettings.height})`, width: projectSettings.width, height: projectSettings.height },
      { label: "UHD long edge (3840)", ...atLongEdge(3840) },
      { label: "Full HD long edge (1920)", ...atLongEdge(1920) },
      { label: "HD long edge (1280)", ...atLongEdge(1280) },
    ];
    return candidates.filter((candidate, index) =>
      candidates.findIndex((other) => other.width === candidate.width && other.height === candidate.height) === index
    );
  }, [projectSettings.height, projectSettings.width]);

  /* Reset delivery defaults when the dialog opens for a different project. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!isOpen) return;
    setResolution(0);
    setFps(projectSettings.fps || 30);
  }, [isOpen, projectSettings.fps, projectSettings.height, projectSettings.width]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!isOpen || !projectId) return;
    void loadJobs(projectId);
  }, [isOpen, loadJobs, projectId]);

  if (!isOpen) return null;

  const preset = resolutionPresets[resolution] || resolutionPresets[0]!;
  const qualityPreset = QUALITY_PRESETS[quality]!;
  const isMaster = codec.startsWith("prores-") || codec.startsWith("dnxhr-");
  const isHdr = colorSpace !== "rec709";

  function chooseCodec(next: VideoCodec) {
    setCodec(next);
    if (next === "h264") setColorSpace("rec709");
  }

  async function handleExport() {
    if (!projectId) return;
    toast.info("Export started...");
    await startRender(projectId, {
      format: isMaster ? "mov" : "mp4",
      videoCodec: codec,
      audioCodec: isMaster ? "pcm-s24le" : "aac",
      width: preset.width,
      height: preset.height,
      fps,
      videoBitrate: qualityPreset.bitrate,
      audioBitrate: qualityPreset.audioBitrate,
      qualityPreset: qualityPreset.value as QualityPreset,
      colorSpace,
      bitDepth: codec === "h264" ? 8 : 10,
      ...(colorSpace === "rec2100-pq"
        ? {
            hdrMetadata: {
              maxLuminance,
              minLuminance: 0.0001,
              maxCll,
              maxFall,
            },
          }
        : {}),
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[500px] max-h-[92vh] overflow-y-auto bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--border-default)]">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Export Video</h2>
          <button
            onClick={() => togglePanel("exportDialog")}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Resolution */}
          <div>
            <label className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider block mb-1.5">
              Resolution
            </label>
            <select
              value={resolution}
              onChange={(e) => setResolution(Number(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-md text-xs text-[var(--text-primary)] focus:outline-none focus:border-zinc-500"
            >
              {resolutionPresets.map((p, i) => (
                <option key={i} value={i}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* FPS */}
          <div>
            <label className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider block mb-1.5">
              Frame Rate
            </label>
            <div className="flex gap-1.5">
              {[24, 30, 60].map((f) => (
                <button
                  key={f}
                  onClick={() => setFps(f)}
                  className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
                    fps === f
                      ? "bg-zinc-700 text-white"
                      : "bg-[var(--bg-primary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-[var(--border-default)]"
                  }`}
                >
                  {f} fps
                </button>
              ))}
            </div>
          </div>

          {/* Codec */}
          <div>
            <label className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider block mb-1.5">
              Codec
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {CODECS.map(({ value, label, detail }) => (
                <button
                  key={value}
                  onClick={() => chooseCodec(value)}
                  className={`px-2.5 py-2 rounded text-left transition-colors ${
                    codec === value
                      ? "bg-zinc-700 text-white"
                      : "bg-[var(--bg-primary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-[var(--border-default)]"
                  }`}
                >
                  <span className="block text-xs font-medium">{label}</span>
                  <span className="block mt-0.5 text-[9px] opacity-70">{detail}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Color delivery */}
          <div>
            <label className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider block mb-1.5">
              Color Delivery
            </label>
            <select
              value={colorSpace}
              onChange={(e) => {
                const next = e.target.value as ExportColorSpace;
                setColorSpace(next);
                if (next !== "rec709" && codec === "h264") setCodec("h265");
              }}
              className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-md text-xs text-[var(--text-primary)] focus:outline-none focus:border-zinc-500"
            >
              {COLOR_SPACES.map((profile) => (
                <option key={profile.value} value={profile.value}>
                  {profile.label} — {profile.detail}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--text-muted)]">
              {isHdr
                ? "HDR exports use a real 10-bit signal and BT.2020 metadata. Verify on an HDR-capable display."
                : codec === "h264" ? "8-bit 4:2:0 Rec.709 delivery." : "10-bit Rec.709 reduces gradients and banding."}
            </p>
          </div>

          {colorSpace === "rec2100-pq" && (
            <div className="grid grid-cols-3 gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] p-3">
              {[
                ["Master peak", maxLuminance, setMaxLuminance],
                ["MaxCLL", maxCll, setMaxCll],
                ["MaxFALL", maxFall, setMaxFall],
              ].map(([label, value, setter]) => (
                <label key={String(label)} className="text-[10px] text-[var(--text-muted)]">
                  {String(label)} · nits
                  <input
                    type="number"
                    min={50}
                    max={10000}
                    value={Number(value)}
                    onChange={(e) => (setter as (value: number) => void)(Number(e.target.value))}
                    className="mt-1 w-full rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs text-[var(--text-primary)]"
                  />
                </label>
              ))}
            </div>
          )}

          {/* Quality */}
          <div>
            <label className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider block mb-1.5">
              Quality
            </label>
            <select
              value={quality}
              onChange={(e) => setQuality(Number(e.target.value))}
              disabled={isMaster}
              className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-md text-xs text-[var(--text-primary)] focus:outline-none focus:border-zinc-500"
            >
              {QUALITY_PRESETS.map((p, i) => (
                <option key={i} value={i}>
                  {isMaster
                    ? `${p.name} · master codec controls quality`
                    : `${p.name} · CRF ${codec === "h264" ? p.h264Crf : p.h265Crf} · ${p.speed}`}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--text-muted)]">
              {isMaster
                ? "Mezzanine masters use edit-friendly 10-bit intraframe encoding and 24-bit PCM audio."
                : "Constant-quality software encoding uses original media. File size adapts to scene complexity."}
            </p>
          </div>

          {/* Progress */}
          {activeJob && activeJob.status !== "completed" && activeJob.status !== "failed" && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px]">
                <span className="text-[var(--text-muted)]">
                  {activeJob.status === "queued" ? "Starting renderer…" : `${activeJob.status}...`}
                </span>
                <span className="text-[var(--text-primary)] font-mono">{activeJob.progress}%</span>
              </div>
              <div className="h-2 bg-[var(--bg-primary)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all duration-300 rounded-full"
                  style={{ width: `${activeJob.progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Completed */}
          {activeJob?.status === "completed" && activeJob.outputUrl && (
            <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/20 rounded-md">
              <svg className="w-4 h-4 text-green-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
              <span className="text-xs text-green-300">Export complete!</span>
              <a
                href={resolveMediaUrl(activeJob.outputUrl) || undefined}
                download
                className="ml-auto px-2.5 py-1 bg-green-600 hover:bg-green-500 text-white rounded text-xs font-medium"
              >
                Download
              </a>
            </div>
          )}

          {/* Failed */}
          {activeJob?.status === "failed" && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-md">
              <p className="text-xs text-red-300">Export failed: {activeJob.error || "Unknown error"}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-[var(--border-default)]">
          <button
            onClick={() => togglePanel("exportDialog")}
            className="px-3.5 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-md hover:bg-[var(--bg-tertiary)]"
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            disabled={isLoading || hasLiveRender}
            className="px-4 py-1.5 bg-zinc-100 hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-950 rounded-md text-xs font-medium transition-colors"
          >
            {isLoading ? "Starting..." : hasLiveRender ? "Export in progress" : "Start Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
