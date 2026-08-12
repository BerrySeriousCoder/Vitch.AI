"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useMediaStore } from "@/stores/media.store";
import { useProjectStore } from "@/stores/project.store";
import { useFontsStore } from "@/stores/fonts.store";
import { useLutsStore } from "@/stores/luts.store";
import { useSequenceStore } from "@/stores/sequence.store";
import { sequenceContentEnd } from "@tempo/editor-core";
import { getAssetPreviewUrl } from "@/lib/media-url";
import { SourceMonitor } from "./SourceMonitor";
import { apiFetch, apiUpload } from "@/lib/api-client";
import type { MediaAnalysis, MediaAsset, MediaAudioRhythm, MediaAudioTranscript } from "@tempo/types";

const TYPE_ICONS: Record<string, string> = {
  video: "🎬",
  audio: "🎵",
  image: "🖼",
};

function AssetThumb({
  asset,
  className = "",
  iconClassName = "text-2xl",
}: {
  asset: MediaAsset;
  className?: string;
  iconClassName?: string;
}) {
  const previewUrl = getAssetPreviewUrl(asset);
  const [failed, setFailed] = useState(false);

  if (previewUrl && !failed) {
    return (
      <img
        src={previewUrl}
        alt={asset.name}
        className={`w-full h-full object-cover ${className}`}
        draggable={false}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span className={iconClassName} aria-hidden>
      {TYPE_ICONS[asset.type] || "📄"}
    </span>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function analysisStatus(asset: MediaAsset): string {
  return asset.metadata?.analysisStatus || "none";
}

function AnalysisBadge({ asset }: { asset: MediaAsset }) {
  if (asset.metadata?.referenceAudio) {
    return (
      <span className="px-1 py-0.5 rounded bg-violet-950/90 text-[8px] font-medium text-violet-200 border border-violet-700/60">
        Reference audio
      </span>
    );
  }
  const status = analysisStatus(asset);
  if (status === "ready") {
    return (
      <span className="px-1 py-0.5 rounded bg-emerald-950/80 text-[8px] font-medium text-emerald-300 border border-emerald-900/60">
        Analyzed
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="px-1 py-0.5 rounded bg-amber-950/70 text-[8px] font-medium text-amber-300 border border-amber-900/50 flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full border border-amber-300 border-t-transparent animate-spin" />
        Analyzing
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="px-1 py-0.5 rounded bg-red-950/70 text-[8px] font-medium text-red-300 border border-red-900/50">
        Failed
      </span>
    );
  }
  return null;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-zinc-700/80 bg-zinc-900/80 px-2 py-0.5 text-[10px] text-zinc-300">
      {children}
    </span>
  );
}

function MediaDetailPanel({
  asset,
  projectId,
  onClose,
}: {
  asset: MediaAsset;
  projectId: string;
  onClose: () => void;
}) {
  const reanalyzeAsset = useMediaStore((s) => s.reanalyzeAsset);
  const createProxy = useMediaStore((s) => s.createProxy);
  const clearProxy = useMediaStore((s) => s.clearProxy);
  const relinkAsset = useMediaStore((s) => s.relinkAsset);
  const analyzingIds = useMediaStore((s) => s.analyzingIds);
  const relinkInputRef = useRef<HTMLInputElement>(null);
  const analysis = asset.metadata?.analysis as MediaAnalysis | undefined;
  const status = analysisStatus(asset);
  const busy = analyzingIds.has(asset.id) || status === "pending";
  const dur = asset.duration ?? asset.metadata?.duration;
  const meta = asset.metadata;
  const rhythm = meta?.audioRhythm as MediaAudioRhythm | undefined;
  const transcript = meta?.audioTranscript as MediaAudioTranscript | undefined;
  const audioStatus = meta?.audioAnalysisStatus || "none";
  const showAudio = asset.type === "audio" || asset.type === "video";
  const audioBusy = busy || audioStatus === "pending";
  const proxyStatus = meta?.proxyStatus || (asset.proxyUrl ? "ready" : "none");

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-[var(--bg-secondary)]">
      <div className="h-9 flex items-center gap-2 px-3 border-b border-[var(--border-default)] flex-shrink-0">
        <button
          onClick={onClose}
          className="text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          ← Back
        </button>
        <span className="text-[11px] font-medium text-zinc-200 truncate flex-1">
          {asset.name}
        </span>
        <AnalysisBadge asset={asset} />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="relative bg-zinc-950 border-b border-zinc-800">
          {asset.type === "video" || asset.type === "audio" ? <SourceMonitor key={asset.id} asset={asset} /> : <div className="aspect-video"><AssetThumb asset={asset} /></div>}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 py-2">
            <p className="text-[10px] font-mono text-zinc-400">
              {asset.type.toUpperCase()}
              {dur != null ? ` · ${Number(dur).toFixed(1)}s` : ""}
              {meta?.width && meta?.height ? ` · ${meta.width}×${meta.height}` : ""}
              {meta?.fps ? ` · ${meta.fps}fps` : ""}
            </p>
          </div>
        </div>

        <div className="p-3 space-y-4">
          {asset.type === "video" && (
            <section className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-zinc-500">Editorial proxy</h4>
                  <p className="mt-0.5 text-[10px] text-zinc-400">
                    {proxyStatus === "ready" ? meta?.proxyProfile || "Ready for fast timeline playback" : proxyStatus === "processing" ? "Generating in background…" : proxyStatus === "error" ? meta?.proxyError || "Generation failed" : "No proxy yet"}
                  </p>
                </div>
                {proxyStatus === "ready" ? (
                  <button onClick={() => clearProxy(projectId, asset.id)} className="rounded px-1.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">Remove</button>
                ) : (
                  <button disabled={proxyStatus === "processing"} onClick={() => createProxy(projectId, asset.id)} className="rounded bg-cyan-950/60 px-1.5 py-1 text-[10px] text-cyan-200 disabled:opacity-50 hover:bg-cyan-900/60">{proxyStatus === "processing" ? "Working…" : "Create proxy"}</button>
                )}
              </div>
            </section>
          )}

          <section className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5 flex items-center justify-between gap-2">
            <div><h4 className="text-[10px] uppercase tracking-wider text-zinc-500">Source media</h4><p className="mt-0.5 text-[10px] text-zinc-400">Replace the file without changing timeline clip references.</p></div>
            <button onClick={() => relinkInputRef.current?.click()} className="rounded px-1.5 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800">Relink…</button>
            <input ref={relinkInputRef} type="file" className="hidden" accept={asset.type === "video" ? "video/*" : asset.type === "audio" ? "audio/*" : "image/*"} onChange={(event) => { const file = event.target.files?.[0]; if (file) void relinkAsset(projectId, asset.id, file); event.currentTarget.value = ""; }} />
          </section>

          {status === "pending" && (
            <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-3">
              <div className="flex items-center gap-2 text-[12px] text-amber-200">
                <span className="w-3 h-3 rounded-full border-2 border-amber-300 border-t-transparent animate-spin" />
                Reading this clip with vision…
              </div>
              <p className="mt-1 text-[10px] text-amber-200/60">
                Tags, shot type, mood, and best-use hints will appear here.
              </p>
            </div>
          )}

          {status === "error" && (
            <div className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-3 space-y-2">
              <p className="text-[12px] text-red-200">Analysis failed</p>
              <p className="text-[10px] text-red-200/60">{analysis?.error || "Unknown error"}</p>
              <button
                onClick={() => reanalyzeAsset(projectId, asset.id)}
                className="text-[11px] text-zinc-200 underline underline-offset-2"
              >
                Retry analysis
              </button>
            </div>
          )}

          {(status === "ready" || status === "skipped") && analysis && (
            <>
              <section>
                <h4 className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
                  Summary
                </h4>
                <p className="text-[13px] leading-relaxed text-zinc-200">
                  {analysis.summary}
                </p>
              </section>

              {asset.metadata?.shotIndex?.shots?.length ? (
                <section>
                  <h4 className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
                    Shot index
                  </h4>
                  <p className="text-[12px] text-zinc-300">
                    {asset.metadata.shotIndex.shots.length} scene
                    {asset.metadata.shotIndex.shots.length === 1 ? "" : "s"} indexed
                  </p>
                </section>
              ) : null}

              {(analysis.shotType || analysis.mood || analysis.setting || analysis.cameraMotion) && (
                <section className="flex flex-wrap gap-1.5">
                  {analysis.shotType && <Chip>Shot · {analysis.shotType}</Chip>}
                  {analysis.cameraMotion && <Chip>Motion · {analysis.cameraMotion}</Chip>}
                  {analysis.mood && <Chip>Mood · {analysis.mood}</Chip>}
                  {analysis.setting && <Chip>Setting · {analysis.setting}</Chip>}
                </section>
              )}

              {analysis.tags?.length > 0 && (
                <section>
                  <h4 className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
                    Tags
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {analysis.tags.map((tag) => (
                      <Chip key={tag}>{tag}</Chip>
                    ))}
                  </div>
                </section>
              )}

              {analysis.subjects?.length > 0 && (
                <section>
                  <h4 className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
                    Subjects
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {analysis.subjects.map((s) => (
                      <Chip key={s}>{s}</Chip>
                    ))}
                  </div>
                </section>
              )}

              {analysis.bestFor && analysis.bestFor.length > 0 && (
                <section>
                  <h4 className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
                    Best for
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {analysis.bestFor.map((b) => (
                      <span
                        key={b}
                        className="inline-flex rounded-md border border-sky-900/50 bg-sky-950/30 px-2 py-0.5 text-[10px] text-sky-200"
                      >
                        {b}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {analysis.colorPalette && analysis.colorPalette.length > 0 && (
                <section>
                  <h4 className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
                    Palette
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {analysis.colorPalette.map((c) => (
                      <div key={c} className="flex items-center gap-1.5">
                        <span
                          className="h-4 w-4 rounded-full border border-zinc-600"
                          style={{
                            background: c.startsWith("#") ? c : undefined,
                          }}
                          title={c}
                        />
                        <span className="text-[10px] font-mono text-zinc-400">{c}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {analysis.moments && analysis.moments.length > 0 && (
                <section>
                  <h4 className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
                    Moments
                  </h4>
                  <ul className="space-y-1.5">
                    {analysis.moments.map((m, i) => (
                      <li
                        key={`${m.t}-${i}`}
                        className="flex gap-2 text-[11px] text-zinc-300"
                      >
                        <span className="font-mono text-zinc-500 w-10 flex-shrink-0">
                          {formatTime(m.t)}
                        </span>
                        <span>{m.label}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {analysis.textInFrame && analysis.textInFrame.length > 0 && (
                <section>
                  <h4 className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
                    Text in frame
                  </h4>
                  <p className="text-[11px] text-zinc-400">{analysis.textInFrame.join(" · ")}</p>
                </section>
              )}
            </>
          )}

          {status === "none" && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-3 space-y-2">
              <p className="text-[12px] text-zinc-300">No vision analysis yet</p>
              <button
                onClick={() => reanalyzeAsset(projectId, asset.id)}
                disabled={busy}
                className="text-[11px] px-2.5 py-1 rounded bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-50"
              >
                Analyze with vision
              </button>
            </div>
          )}

          {showAudio && (
            <section className="pt-2 border-t border-zinc-800 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-[10px] uppercase tracking-wider text-zinc-500">
                  Audio
                </h4>
                <span className="text-[10px] font-mono text-zinc-500">
                  {audioStatus}
                </span>
              </div>

              {audioStatus === "pending" && (
                <div className="flex items-center gap-2 text-[12px] text-amber-200">
                  <span className="w-3 h-3 rounded-full border-2 border-amber-300 border-t-transparent animate-spin" />
                  Listening for beats + transcript…
                </div>
              )}

              {audioStatus === "error" && (
                <p className="text-[11px] text-red-200/80">
                  {transcript?.error || rhythm?.error || "Audio analysis failed"}
                </p>
              )}

              {rhythm && (
                <div className="flex flex-wrap gap-1.5">
                  <Chip>BPM · {rhythm.bpm}</Chip>
                  <Chip>Beats · {rhythm.beats?.length ?? 0}</Chip>
                  {rhythm.mood && <Chip>Mood · {rhythm.mood}</Chip>}
                  {rhythm.genre && <Chip>Genre · {rhythm.genre}</Chip>}
                </div>
              )}

              {transcript && (
                <div className="space-y-2">
                  <p className="text-[11px] text-zinc-400">
                    {transcript.kind}
                    {transcript.language ? ` · ${transcript.language}` : ""}
                    {` · ${transcript.segments?.length ?? 0} segments`}
                  </p>
                  {transcript.summary && (
                    <p className="text-[12px] text-zinc-300 leading-relaxed">
                      {transcript.summary}
                    </p>
                  )}
                  {transcript.segments && transcript.segments.length > 0 && (
                    <ul className="max-h-40 overflow-y-auto space-y-1.5 rounded-md border border-zinc-800 bg-zinc-950/40 px-2 py-2">
                      {transcript.segments.slice(0, 40).map((s, i) => (
                        <li
                          key={`${s.start}-${i}`}
                          className="flex gap-2 text-[11px] text-zinc-300"
                        >
                          <span className="font-mono text-zinc-500 w-16 flex-shrink-0">
                            {formatTime(s.start)}
                          </span>
                          <span className="min-w-0 break-words">{s.text}</span>
                        </li>
                      ))}
                      {transcript.segments.length > 40 && (
                        <li className="text-[10px] text-zinc-500">
                          +{transcript.segments.length - 40} more…
                        </li>
                      )}
                    </ul>
                  )}
                  {transcript.kind === "music_instrumental" && (
                    <p className="text-[10px] text-zinc-500">
                      No intelligible vocals — captions will use beats only.
                    </p>
                  )}
                </div>
              )}

              {!rhythm && !transcript && audioStatus === "none" && (
                <p className="text-[11px] text-zinc-500">
                  Re-run analysis to extract BPM, beats, and timed transcript.
                </p>
              )}

              <button
                onClick={() => reanalyzeAsset(projectId, asset.id)}
                disabled={audioBusy}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
              >
                {audioBusy ? "Analyzing…" : "Re-analyze audio + vision"}
              </button>
            </section>
          )}

          <section className="pt-2 border-t border-zinc-800">
            <h4 className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">
              File
            </h4>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
              <dt className="text-zinc-500">Size</dt>
              <dd className="font-mono text-zinc-300">{formatSize(meta?.fileSize || 0)}</dd>
              <dt className="text-zinc-500">MIME</dt>
              <dd className="font-mono text-zinc-300 truncate">{meta?.mimeType || "—"}</dd>
              {meta?.codec && (
                <>
                  <dt className="text-zinc-500">Codec</dt>
                  <dd className="font-mono text-zinc-300">{meta.codec}</dd>
                </>
              )}
              {analysis?.model && (
                <>
                  <dt className="text-zinc-500">Model</dt>
                  <dd className="font-mono text-zinc-300 truncate">{analysis.model}</dd>
                </>
              )}
            </dl>
            {(status === "ready" || status === "error" || status === "skipped") && (
              <button
                onClick={() => reanalyzeAsset(projectId, asset.id)}
                disabled={busy}
                className="mt-3 text-[11px] text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
              >
                {busy ? "Analyzing…" : "Re-run analysis"}
              </button>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export function MediaBin() {
  const projectId = useProjectStore((s) => s.id);
  const {
    assets,
    isLoading,
    uploadingCount,
    loadAssets,
    uploadFile,
    deleteAsset,
    analyzeAll,
  } = useMediaStore();
  const {
    fonts,
    isLoading: fontsLoading,
    uploading: fontUploading,
    loadedProjectId: fontsLoadedProjectId,
    loadFonts,
    uploadFont,
    deleteFont,
  } = useFontsStore();
  const {
    luts,
    isLoading: lutsLoading,
    uploading: lutUploading,
    loadedProjectId: lutsLoadedProjectId,
    loadLuts,
    uploadLut,
    deleteLut,
  } = useLutsStore();
  const sequences = useSequenceStore((s) => s.sequences);
  const createEmptySeq = useSequenceStore((s) => s.createEmpty);
  const enterSequence = useSequenceStore((s) => s.enterSequence);
  const renameSequence = useSequenceStore((s) => s.rename);
  const removeSequence = useSequenceStore((s) => s.remove);
  const duplicateSequence = useSequenceStore((s) => s.duplicate);
  const usageCount = useSequenceStore((s) => s.usageCount);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const lutInputRef = useRef<HTMLInputElement>(null);
  const packInputRef = useRef<HTMLInputElement>(null);
  const [binTab, setBinTab] = useState<"media" | "fonts" | "luts" | "packs" | "sequences">("media");
  const [packs, setPacks] = useState<Array<{ id: string; name: string; version: string }>>([]);
  const [packsLoading, setPacksLoading] = useState(false);
  const [packsUploading, setPacksUploading] = useState(false);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    if (projectId) {
      loadAssets(projectId);
    }
  }, [projectId, loadAssets]);

  useEffect(() => {
    if (
      projectId &&
      binTab === "fonts" &&
      fontsLoadedProjectId !== projectId &&
      !fontsLoading
    ) {
      void loadFonts(projectId);
    }
  }, [projectId, binTab, fontsLoadedProjectId, fontsLoading, loadFonts]);

  useEffect(() => {
    if (
      projectId &&
      binTab === "luts" &&
      lutsLoadedProjectId !== projectId &&
      !lutsLoading
    ) {
      void loadLuts(projectId);
    }
  }, [projectId, binTab, lutsLoadedProjectId, lutsLoading, loadLuts]);

  useEffect(() => {
    if (!projectId || binTab !== "packs") return;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setPacksLoading(true);
      const res = await apiFetch<{ packs: Array<{ id: string; name: string; version: string }> }>(
        `/api/projects/${projectId}/packs`
      );
      if (cancelled) return;
      if (res.success && res.data?.packs) setPacks(res.data.packs);
      setPacksLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, binTab]);

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      if (!projectId) return;
      Array.from(files).forEach((f) => uploadFile(projectId, f));
    },
    [projectId, uploadFile]
  );

  const handleFontFiles = useCallback(
    (files: FileList | File[]) => {
      if (!projectId) return;
      Array.from(files).forEach((f) => void uploadFont(projectId, f));
    },
    [projectId, uploadFont]
  );

  const handleLutFiles = useCallback(
    (files: FileList | File[]) => {
      if (!projectId) return;
      Array.from(files).forEach((f) => void uploadLut(projectId, f));
    },
    [projectId, uploadLut]
  );

  const handlePackFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!projectId) return;
      const file = Array.from(files)[0];
      if (!file) return;
      setPacksUploading(true);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await apiUpload<{ pack: { id: string; name: string; version: string } }>(
          `/api/projects/${projectId}/packs`,
          form
        );
        if (res.success) {
          const list = await apiFetch<{
            packs: Array<{ id: string; name: string; version: string }>;
          }>(`/api/projects/${projectId}/packs`);
          if (list.success && list.data?.packs) setPacks(list.data.packs);
          toast.success(`Pack uploaded: ${res.data?.pack?.name || file.name}`);
        } else {
          toast.error(res.error || "Failed to upload pack");
        }
      } catch {
        toast.error("Failed to upload pack");
      } finally {
        setPacksUploading(false);
      }
    },
    [projectId]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (!e.dataTransfer.files.length) return;
      if (binTab === "fonts") handleFontFiles(e.dataTransfer.files);
      else if (binTab === "luts") handleLutFiles(e.dataTransfer.files);
      else if (binTab === "packs") void handlePackFiles(e.dataTransfer.files);
      else handleFiles(e.dataTransfer.files);
    },
    [binTab, handleFiles, handleFontFiles, handleLutFiles, handlePackFiles]
  );

  const handleDragStart = useCallback((e: React.DragEvent, asset: MediaAsset) => {
    e.dataTransfer.setData("application/x-tempo-asset", JSON.stringify(asset));
    e.dataTransfer.effectAllowed = "copy";
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const prioritized = [...assets].sort((a, b) => {
      const aReference = a.metadata?.referenceAudio ? 1 : 0;
      const bReference = b.metadata?.referenceAudio ? 1 : 0;
      return bReference - aReference;
    });
    if (!q) return prioritized;
    const tokens = q.split(/\s+/).filter(Boolean);
    return prioritized.filter((a) => {
      const analysis = a.metadata?.analysis;
      const hay = [
        a.name,
        a.type,
        analysis?.summary,
        analysis?.mood,
        analysis?.shotType,
        ...(analysis?.tags || []),
        ...(analysis?.subjects || []),
        ...(analysis?.bestFor || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return tokens.every((token) => hay.includes(token));
    });
  }, [assets, search]);

  const filteredFonts = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return fonts;
    return fonts.filter(
      (f) =>
        f.familyName.toLowerCase().includes(q) ||
        f.fileName.toLowerCase().includes(q)
    );
  }, [fonts, search]);

  const filteredLuts = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return luts;
    return luts.filter(
      (l) =>
        l.name.toLowerCase().includes(q) || l.fileName.toLowerCase().includes(q)
    );
  }, [luts, search]);

  const selected = selectedId ? assets.find((a) => a.id === selectedId) : null;

  const activeItemCount =
    binTab === "media"
      ? filtered.length
      : binTab === "fonts"
        ? filteredFonts.length
        : binTab === "luts"
          ? filteredLuts.length
          : binTab === "packs"
            ? packs.length
            : sequences.length;

  const addActionLabel =
    binTab === "fonts"
      ? "Import fonts"
      : binTab === "luts"
        ? "Import LUTs"
        : binTab === "packs"
          ? "Import graphics pack"
          : binTab === "sequences"
            ? "Create sequence"
            : "Import media";

  const handlePrimaryAdd = () => {
    if (binTab === "fonts") {
      fontInputRef.current?.click();
      return;
    }
    if (binTab === "luts") {
      lutInputRef.current?.click();
      return;
    }
    if (binTab === "packs") {
      packInputRef.current?.click();
      return;
    }
    if (binTab === "sequences") {
      const id = createEmptySeq("Sequence");
      if (id) toast.success("Empty sequence created");
      return;
    }
    fileInputRef.current?.click();
  };

  return (
    <div className="h-full flex flex-col bg-[var(--bg-secondary)] relative">
      {selected && projectId && binTab === "media" && (
        <MediaDetailPanel
          asset={selected}
          projectId={projectId}
          onClose={() => setSelectedId(null)}
        />
      )}

      <div className="flex-shrink-0 border-b border-[var(--border-default)]">
        <div className="flex h-9 items-center gap-2 px-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
              Media Bin
            </span>
            <span
              className="flex h-4 min-w-4 flex-shrink-0 items-center justify-center rounded-full bg-white/5 px-1 text-[8px] tabular-nums text-zinc-500"
              aria-label={`${activeItemCount} items`}
            >
              {activeItemCount}
            </span>
          </div>

          <div className="flex flex-shrink-0 items-center gap-0.5">
            {binTab === "media" && assets.length > 0 && projectId && (
              <button
                type="button"
                onClick={() => analyzeAll(projectId)}
                className="flex h-6 items-center rounded px-1.5 text-[9px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                title="Analyze assets missing vision metadata"
              >
                Analyze
              </button>
            )}
            {binTab === "media" && (
              <button
                type="button"
                onClick={() => setViewMode(viewMode === "grid" ? "list" : "grid")}
                className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                title={viewMode === "grid" ? "List view" : "Grid view"}
                aria-label={
                  viewMode === "grid" ? "Switch to list view" : "Switch to grid view"
                }
              >
                {viewMode === "grid" ? (
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M1 2.5A1.5 1.5 0 012.5 1h3A1.5 1.5 0 017 2.5v3A1.5 1.5 0 015.5 7h-3A1.5 1.5 0 011 5.5v-3zm8 0A1.5 1.5 0 0110.5 1h3A1.5 1.5 0 0115 2.5v3A1.5 1.5 0 0113.5 7h-3A1.5 1.5 0 019 5.5v-3zm-8 8A1.5 1.5 0 012.5 9h3A1.5 1.5 0 017 10.5v3A1.5 1.5 0 015.5 15h-3A1.5 1.5 0 011 13.5v-3zm8 0A1.5 1.5 0 0110.5 9h3a1.5 1.5 0 011.5 1.5v3a1.5 1.5 0 01-1.5 1.5h-3A1.5 1.5 0 019 13.5v-3z" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
                    <path
                      fillRule="evenodd"
                      d="M2.5 12a.5.5 0 01.5-.5h10a.5.5 0 010 1H3a.5.5 0 01-.5-.5zm0-4a.5.5 0 01.5-.5h10a.5.5 0 010 1H3a.5.5 0 01-.5-.5zm0-4a.5.5 0 01.5-.5h10a.5.5 0 010 1H3a.5.5 0 01-.5-.5z"
                    />
                  </svg>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={handlePrimaryAdd}
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              title={addActionLabel}
              aria-label={addActionLabel}
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="Media library sections"
          className="grid grid-cols-5 gap-0.5 px-2 pb-2"
        >
          {(
            [
              ["media", "Media", "Media"],
              ["fonts", "Fonts", "Fonts"],
              ["luts", "LUTs", "LUTs"],
              ["packs", "Packs", "Graphics packs"],
              ["sequences", "Seq", "Sequences"],
            ] as const
          ).map(([id, label, accessibleLabel]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={binTab === id}
              aria-label={accessibleLabel}
              title={accessibleLabel}
              onClick={() => setBinTab(id)}
              className={`h-6 min-w-0 truncate rounded px-1 text-[9px] font-medium transition-colors ${
                binTab === id
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,audio/*,image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={fontInputRef}
          type="file"
          accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFontFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={lutInputRef}
          type="file"
          accept=".cube,text/plain"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleLutFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={packInputRef}
          type="file"
          accept=".zip,.tempo-pack,application/zip"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void handlePackFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {((binTab === "media" && assets.length > 0) ||
        (binTab === "fonts" && fonts.length > 0) ||
        (binTab === "luts" && luts.length > 0)) && (
        <div className="px-3 py-1.5 border-b border-[var(--border-default)]">
          <input
            type="text"
            placeholder={
              binTab === "fonts"
                ? "Search fonts…"
                : binTab === "luts"
                  ? "Search LUTs…"
                  : "Search name, tags, mood…"
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-2 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[11px] text-[var(--text-primary)] placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
          />
        </div>
      )}

      <div
        className={`flex-1 overflow-y-auto p-2 ${isDragOver ? "ring-2 ring-inset ring-blue-500/50 bg-blue-950/10" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
      >
        {binTab === "sequences" ? (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => {
                const id = createEmptySeq("Sequence");
                if (id) toast.success("Empty sequence created");
              }}
              className="w-full px-2 py-1.5 rounded text-[10px] bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
            >
              + New empty sequence
            </button>
            {sequences.length === 0 ? (
              <p className="text-[10px] text-zinc-500 px-1">
                No sequences yet. Create one or select clips on Main → Create sequence.
              </p>
            ) : (
              sequences.map((seq) => {
                const used = usageCount(seq.id);
                const end = sequenceContentEnd(seq);
                return (
                  <div
                    key={seq.id}
                    className="rounded border border-teal-900/50 bg-teal-950/20 p-2"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(
                        "application/x-tempo-sequence",
                        JSON.stringify({ id: seq.id, name: seq.name, duration: end || seq.durationHint || 5 })
                      );
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <button
                        type="button"
                        className="text-[11px] text-teal-100 font-medium truncate text-left hover:underline"
                        onClick={() => {
                          const r = enterSequence(seq.id);
                          if (!r.ok) toast.error(r.message);
                        }}
                      >
                        {seq.name}
                      </button>
                      <span className="text-[9px] font-mono text-zinc-500">
                        {end.toFixed(1)}s · {used}×
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      <button
                        type="button"
                        className="text-[9px] text-zinc-400 hover:text-zinc-200"
                        onClick={() => {
                          const r = enterSequence(seq.id);
                          if (!r.ok) toast.error(r.message);
                        }}
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        className="text-[9px] text-zinc-400 hover:text-zinc-200"
                        onClick={() => {
                          const name = window.prompt("Rename sequence", seq.name);
                          if (!name) return;
                          const r = renameSequence(seq.id, name);
                          if (!r.ok) toast.error(r.message);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="text-[9px] text-zinc-400 hover:text-zinc-200"
                        onClick={() => {
                          const r = duplicateSequence(seq.id);
                          if (!r.ok) toast.error(r.message);
                        }}
                      >
                        Dup
                      </button>
                      <button
                        type="button"
                        className="text-[9px] text-red-400 hover:text-red-300"
                        onClick={() => {
                          const r = removeSequence(seq.id);
                          if (!r.ok) toast.error(r.message);
                          else toast.success("Deleted");
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : binTab === "packs" ? (
          <>
            {packsUploading && (
              <div className="mb-2 px-2 py-1.5 bg-blue-950/30 border border-blue-900 rounded text-[10px] text-blue-300 flex items-center gap-2">
                <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                Uploading pack…
              </div>
            )}
            {packsLoading ? (
              <div className="space-y-1">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-8 rounded bg-zinc-800/50 animate-pulse" />
                ))}
              </div>
            ) : packs.length === 0 ? (
              <div
                className="border border-dashed border-[var(--border-default)] rounded-[var(--radius-md)] flex flex-col items-center justify-center py-8 px-4 bg-[var(--bg-primary)] hover:border-zinc-700 transition-colors cursor-pointer"
                onClick={() => packInputRef.current?.click()}
              >
                <p className="text-xs text-[var(--text-muted)] text-center font-medium">
                  Drop .tempo-pack / .zip here
                </p>
                <p className="text-[10px] font-mono text-[var(--text-muted)] opacity-60 mt-1">
                  manifest.json + optional assets/
                </p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {packs.map((pack) => (
                  <div
                    key={pack.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--bg-tertiary)]"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] text-[var(--text-primary)] truncate">{pack.name}</p>
                      <p className="text-[9px] font-mono text-[var(--text-muted)] truncate">
                        {pack.id} · v{pack.version}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : binTab === "luts" ? (
          <>
            {lutUploading && (
              <div className="mb-2 px-2 py-1.5 bg-blue-950/30 border border-blue-900 rounded text-[10px] text-blue-300 flex items-center gap-2">
                <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                Uploading LUT…
              </div>
            )}
            {lutsLoading ? (
              <div className="space-y-1">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-8 rounded bg-zinc-800/50 animate-pulse" />
                ))}
              </div>
            ) : filteredLuts.length === 0 ? (
              <div
                className="border border-dashed border-[var(--border-default)] rounded-[var(--radius-md)] flex flex-col items-center justify-center py-8 px-4 bg-[var(--bg-primary)] hover:border-zinc-700 transition-colors cursor-pointer"
                onClick={() => lutInputRef.current?.click()}
              >
                <p className="text-xs text-[var(--text-muted)] text-center font-medium">
                  {luts.length === 0 ? "Drop .cube LUTs here" : "No matching LUTs"}
                </p>
                <p className="text-[10px] font-mono text-[var(--text-muted)] opacity-60 mt-1">
                  Adobe / Resolve .cube
                </p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {filteredLuts.map((lut) => (
                  <div
                    key={lut.id}
                    className="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--bg-tertiary)] transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] text-[var(--text-primary)] truncate">
                        {lut.name}
                      </p>
                      <p className="text-[9px] text-[var(--text-muted)] font-mono truncate">
                        {lut.fileName}
                        {lut.size ? ` · ${lut.size}³` : ""}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        if (projectId) void deleteLut(projectId, lut.id);
                      }}
                      className="w-4 h-4 rounded text-zinc-500 hover:text-red-400 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-[10px]"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : binTab === "fonts" ? (
          <>
            {fontUploading && (
              <div className="mb-2 px-2 py-1.5 bg-blue-950/30 border border-blue-900 rounded text-[10px] text-blue-300 flex items-center gap-2">
                <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                Uploading font…
              </div>
            )}
            {fontsLoading ? (
              <div className="space-y-1">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-8 rounded bg-zinc-800/50 animate-pulse" />
                ))}
              </div>
            ) : filteredFonts.length === 0 ? (
              <div
                className="border border-dashed border-[var(--border-default)] rounded-[var(--radius-md)] flex flex-col items-center justify-center py-8 px-4 bg-[var(--bg-primary)] hover:border-zinc-700 transition-colors cursor-pointer"
                onClick={() => fontInputRef.current?.click()}
              >
                <p className="text-xs text-[var(--text-muted)] text-center font-medium">
                  {fonts.length === 0 ? "Drop fonts here" : "No matching fonts"}
                </p>
                <p className="text-[10px] font-mono text-[var(--text-muted)] opacity-60 mt-1">
                  TTF, OTF, WOFF, WOFF2
                </p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {filteredFonts.map((font) => (
                  <div
                    key={font.id}
                    className="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--bg-tertiary)] transition-colors"
                  >
                    <div
                      className="flex-1 min-w-0"
                      style={{ fontFamily: `"${font.familyName}", sans-serif` }}
                    >
                      <p className="text-[12px] text-[var(--text-primary)] truncate">
                        {font.familyName}
                      </p>
                      <p className="text-[9px] text-[var(--text-muted)] font-mono truncate">
                        {font.fileName} · {font.format}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        if (projectId) void deleteFont(projectId, font.id);
                      }}
                      className="w-4 h-4 rounded text-zinc-500 hover:text-red-400 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-[10px]"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
        {uploadingCount > 0 && (
          <div className="mb-2 px-2 py-1.5 bg-blue-950/30 border border-blue-900 rounded text-[10px] text-blue-300 flex items-center gap-2">
            <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            Uploading {uploadingCount} file{uploadingCount > 1 ? "s" : ""}...
          </div>
        )}

        {isLoading ? (
          <div className="grid grid-cols-2 gap-1.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded overflow-hidden"
              >
                <div className="aspect-video bg-zinc-800/50 animate-pulse" />
                <div className="p-1.5 space-y-1">
                  <div className="w-3/4 h-2.5 rounded bg-zinc-800 animate-pulse" />
                  <div className="w-1/2 h-2 rounded bg-zinc-800/60 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div
            className="border border-dashed border-[var(--border-default)] rounded-[var(--radius-md)] flex flex-col items-center justify-center py-8 px-4 bg-[var(--bg-primary)] hover:border-zinc-700 transition-colors cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="w-8 h-8 rounded-[var(--radius-sm)] border border-zinc-800 bg-zinc-900 flex items-center justify-center mb-2">
              <svg className="w-4 h-4 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
              </svg>
            </div>
            <p className="text-xs text-[var(--text-muted)] text-center font-medium">
              {assets.length === 0 ? "Drag files here to import" : "No matching assets"}
            </p>
            <p className="text-[10px] font-mono text-[var(--text-muted)] opacity-60 mt-1">
              MP4, MOV, WAV, PNG
            </p>
          </div>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-2 gap-1.5">
            {filtered.map((asset) => (
              <div
                key={asset.id}
                draggable
                onDragStart={(e) => handleDragStart(e, asset)}
                onClick={() => setSelectedId(asset.id)}
                className="group relative bg-[var(--bg-primary)] border border-[var(--border-default)] rounded overflow-hidden cursor-grab hover:border-zinc-600 transition-colors"
              >
                <div className="aspect-video bg-zinc-900 flex items-center justify-center overflow-hidden relative">
                  <AssetThumb asset={asset} />
                  <div className="absolute top-1 left-1">
                    <AnalysisBadge asset={asset} />
                  </div>
                  {asset.type === "video" && (
                    <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded bg-black/70 text-[8px] font-mono text-zinc-200">
                      {(asset.duration ?? asset.metadata?.duration)
                        ? `${Number(asset.duration ?? asset.metadata?.duration).toFixed(1)}s`
                        : "VIDEO"}
                    </span>
                  )}
                </div>
                <div className="p-1.5">
                  <p className="text-[10px] text-[var(--text-primary)] truncate font-medium">
                    {asset.name}
                  </p>
                  <p className="text-[9px] text-[var(--text-muted)] font-mono truncate">
                    {asset.metadata?.referenceAudio
                      ? `Imported soundtrack · ${Number(asset.duration ?? asset.metadata?.duration ?? 0).toFixed(1)}s`
                      : asset.metadata?.shotIndex?.shots?.length
                      ? `${asset.metadata.shotIndex.shots.length} shots`
                      : asset.metadata?.analysis?.tags?.[0]
                        ? asset.metadata.analysis.tags.slice(0, 2).join(" · ")
                        : `${asset.type} · ${formatSize(asset.metadata?.fileSize || 0)}`}
                  </p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (projectId) deleteAsset(projectId, asset.id);
                  }}
                  className="absolute top-1 right-1 w-4 h-4 rounded bg-zinc-900/80 text-zinc-400 hover:text-red-400 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-[10px]"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((asset) => (
              <div
                key={asset.id}
                draggable
                onDragStart={(e) => handleDragStart(e, asset)}
                onClick={() => setSelectedId(asset.id)}
                className="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--bg-tertiary)] cursor-grab transition-colors"
              >
                <div className="w-8 h-8 rounded bg-zinc-900 overflow-hidden flex items-center justify-center flex-shrink-0 relative">
                  <AssetThumb asset={asset} iconClassName="text-sm" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-[var(--text-primary)] truncate">{asset.name}</p>
                  <p className="text-[9px] text-[var(--text-muted)] font-mono truncate">
                    {asset.metadata?.referenceAudio
                      ? `Imported soundtrack · ${Number(asset.duration ?? asset.metadata?.duration ?? 0).toFixed(1)}s`
                      : asset.metadata?.analysis?.summary?.slice(0, 48) ||
                        `${asset.type} · ${formatSize(asset.metadata?.fileSize || 0)}`}
                  </p>
                </div>
                <AnalysisBadge asset={asset} />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (projectId) deleteAsset(projectId, asset.id);
                  }}
                  className="w-4 h-4 rounded text-zinc-500 hover:text-red-400 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-[10px]"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
          </>
        )}
      </div>
    </div>
  );
}
