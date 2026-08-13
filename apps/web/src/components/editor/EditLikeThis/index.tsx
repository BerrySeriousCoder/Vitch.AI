"use client";

import { useMemo, useState } from "react";
import { useAIStore, type EditLikeThisStep } from "@/stores/ai.store";
import { useProjectStore } from "@/stores/project.store";
import { useMediaStore } from "@/stores/media.store";
import { toast } from "sonner";
import { isSupportedReferenceUrl } from "@tempo/validators/media";
import type { EditLikeThisAudioPolicy } from "@tempo/types";

const STEPS: { key: EditLikeThisStep; label: string }[] = [
  { key: "downloading", label: "Downloading reference" },
  { key: "analyzing_scenes", label: "Detecting scenes" },
  { key: "analyzing_audio", label: "Analyzing audio" },
  { key: "importing_audio", label: "Importing soundtrack" },
  { key: "analyzing_visuals", label: "Analyzing visuals" },
  { key: "generating_blueprint", label: "Generating blueprint" },
  { key: "style_dna", label: "Extracting Style DNA" },
  { key: "matching_assets", label: "Matching shots" },
  { key: "recreating", label: "Recreating edit" },
];

function stepIndex(step: EditLikeThisStep): number {
  if (step === "complete") return STEPS.length;
  if (step === "idle" || step === "error") return -1;
  return STEPS.findIndex((s) => s.key === step);
}

function referenceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 28 ? `${parsed.pathname.slice(0, 28)}…` : parsed.pathname;
    return `${parsed.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
}

function soundtrackLabel(value: EditLikeThisAudioPolicy["soundtrack"]): string {
  if (value === "reference") return "Reference audio";
  if (value === "uploaded") return "Uploaded soundtrack";
  return "No soundtrack";
}

function sourceAudioLabel(value: EditLikeThisAudioPolicy["sourceAudio"]): string {
  if (value === "mute") return "Footage muted";
  if (value === "duck") return "Dialogue kept + ducking";
  return "Footage audio kept";
}

export function EditLikeThis() {
  const {
    editLikeThisStep,
    editLikeThisDetail,
    blueprint,
    styleDna,
    assetMappings,
    isEditLikeThisRunning,
    editLikeThisQuality,
    editLikeThisWarnings,
    runEditLikeThis,
    cancelRun,
    clearEditLikeThis,
  } = useAIStore();

  const [url, setUrl] = useState("");
  const [showPanel, setShowPanel] = useState(false);
  const [showRunDetails, setShowRunDetails] = useState(false);
  const [soundtrack, setSoundtrack] = useState<EditLikeThisAudioPolicy["soundtrack"]>("reference");
  const [sourceAudio, setSourceAudio] = useState<EditLikeThisAudioPolicy["sourceAudio"]>("mute");
  const [uploadedAudioAssetId, setUploadedAudioAssetId] = useState("");
  const [referenceAudioAuthorized, setReferenceAudioAuthorized] = useState(false);
  const mediaAssets = useMediaStore((state) => state.assets);
  const audioAssets = useMemo(
    () => mediaAssets.filter((asset) => asset.type === "audio"),
    [mediaAssets]
  );

  const urlValid = useMemo(() => (url.trim() ? isSupportedReferenceUrl(url.trim()) : false), [url]);
  const audioPolicy = useMemo<EditLikeThisAudioPolicy>(() => ({
    soundtrack,
    sourceAudio,
    ...(soundtrack === "uploaded" ? { uploadedAudioAssetId } : {}),
    ...(soundtrack === "reference" ? { referenceAudioAuthorized } : {}),
    soundtrackVolume: 0.85,
    sourceVolume: 1,
    duckLevel: 0.25,
  }), [referenceAudioAuthorized, soundtrack, sourceAudio, uploadedAudioAssetId]);
  const audioPolicyValid =
    (soundtrack !== "reference" || referenceAudioAuthorized) &&
    (soundtrack !== "uploaded" || Boolean(uploadedAudioAssetId)) &&
    (sourceAudio !== "duck" || soundtrack !== "none");
  const currentIdx = stepIndex(editLikeThisStep);

  const handleStart = async () => {
    if (!urlValid || !audioPolicyValid || isEditLikeThisRunning) return;
    setShowPanel(true);
    setShowRunDetails(false);
    await runEditLikeThis(url.trim(), audioPolicy);
    if (useAIStore.getState().editLikeThisStep === "complete") setShowPanel(false);
  };

  const handleRegenerate = async () => {
    if (!urlValid || !audioPolicyValid || isEditLikeThisRunning) return;
    setShowPanel(true);
    setShowRunDetails(false);
    await runEditLikeThis(url.trim(), audioPolicy);
    if (useAIStore.getState().editLikeThisStep === "complete") setShowPanel(false);
  };

  return (
    <div className="border-b border-[var(--border-default)]">
      <button
        type="button"
        onClick={() => setShowPanel((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-[var(--bg-tertiary)] transition-colors"
      >
        <div>
          <p className="text-[11px] font-semibold text-[var(--text-primary)]">Edit Like This</p>
          <p className="text-[10px] text-[var(--text-muted)]">
            {isEditLikeThisRunning
              ? `${Math.max(1, currentIdx + 1)}/${STEPS.length} · ${editLikeThisDetail || "Working"}`
              : editLikeThisStep === "complete"
                ? "Recreation complete · open for blueprint and controls"
                : "Paste a reel/short URL to recreate the style"}
          </p>
        </div>
        <svg
          className={`w-3.5 h-3.5 text-[var(--text-muted)] transition-transform ${showPanel ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {showPanel && (
        <div className="px-3 pb-3 space-y-3">
          {isEditLikeThisRunning ? (
            <div className="flex items-start gap-1.5">
              <details className="min-w-0 flex-1 rounded border border-[var(--border-default)] bg-[var(--bg-primary)]">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-[10px] text-[var(--text-muted)]">
                  <span className="min-w-0 flex-1 truncate" title={url}>
                    {referenceLabel(url)} · {soundtrackLabel(soundtrack)} · {sourceAudioLabel(sourceAudio)}
                  </span>
                  <span className="shrink-0 text-zinc-600">Setup ▸</span>
                </summary>
                <div className="space-y-1 border-t border-[var(--border-default)] px-2 py-1.5 text-[10px] text-[var(--text-muted)]">
                  <p className="break-all">{url}</p>
                  <p>{soundtrackLabel(soundtrack)}</p>
                  <p>{sourceAudioLabel(sourceAudio)}</p>
                </div>
              </details>
              <button
                type="button"
                onClick={cancelRun}
                className="px-2.5 py-1.5 border border-red-500/40 text-red-300 hover:bg-red-500/10 rounded-[var(--radius-sm)] text-[11px] font-medium"
              >
                Stop
              </button>
            </div>
          ) : (
            <>
              <div>
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Instagram Reel, YouTube Short, TikTok, or X URL"
                  className="w-full px-2.5 py-1.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-zinc-500"
                />
                {url.trim() && !urlValid && (
                  <p className="mt-1 text-[10px] text-red-400">URL must be Instagram, YouTube, TikTok, or X</p>
                )}
              </div>

              <div className="rounded border border-[var(--border-default)] bg-[var(--bg-primary)] p-2 space-y-2">
            <label className="block space-y-1">
              <span className="text-[10px] font-medium text-[var(--text-secondary)]">Soundtrack</span>
              <select
                value={soundtrack}
                onChange={(event) => {
                  const next = event.target.value as EditLikeThisAudioPolicy["soundtrack"];
                  setSoundtrack(next);
                  if (next === "none" && sourceAudio === "duck") setSourceAudio("keep");
                }}
                className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1 text-[10px] text-[var(--text-primary)]"
              >
                <option value="reference">Reference reel/short audio</option>
                <option value="uploaded">Choose uploaded music</option>
                <option value="none">No soundtrack</option>
              </select>
            </label>

            {soundtrack === "reference" && (
              <label className="flex items-start gap-2 text-[10px] leading-snug text-[var(--text-muted)]">
                <input
                  type="checkbox"
                  checked={referenceAudioAuthorized}
                  onChange={(event) => setReferenceAudioAuthorized(event.target.checked)}
                  className="mt-0.5"
                />
                <span>I have permission to reuse this reference audio in my edit.</span>
              </label>
            )}

            {soundtrack === "uploaded" && (
              <select
                value={uploadedAudioAssetId}
                onChange={(event) => setUploadedAudioAssetId(event.target.value)}
                className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1 text-[10px] text-[var(--text-primary)]"
              >
                <option value="">Select project audio…</option>
                {audioAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>{asset.name}</option>
                ))}
              </select>
            )}

            <label className="block space-y-1">
              <span className="text-[10px] font-medium text-[var(--text-secondary)]">Your footage audio</span>
              <select
                value={sourceAudio}
                onChange={(event) => setSourceAudio(event.target.value as EditLikeThisAudioPolicy["sourceAudio"])}
                className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1 text-[10px] text-[var(--text-primary)]"
              >
                <option value="mute">Mute it — soundtrack only</option>
                <option value="keep">Keep it at full level</option>
                <option value="duck" disabled={soundtrack === "none"}>Keep dialogue and duck soundtrack</option>
              </select>
            </label>
              </div>
            </>
          )}

          {!isEditLikeThisRunning && (
            <div className="flex gap-1.5">
            <button
              type="button"
              onClick={handleStart}
              disabled={!urlValid || !audioPolicyValid}
              className="flex-1 px-2.5 py-1.5 bg-zinc-100 hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-950 rounded-[var(--radius-sm)] text-[11px] font-medium transition-colors"
            >
              Analyze & Recreate
            </button>
            {(editLikeThisStep === "complete" || editLikeThisStep === "error") && (
              <button
                type="button"
                onClick={handleRegenerate}
                disabled={!urlValid || !audioPolicyValid}
                className="px-2.5 py-1.5 border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-[var(--radius-sm)] text-[11px] font-medium disabled:opacity-40"
              >
                Regenerate
              </button>
            )}
            {editLikeThisStep !== "idle" && (
              <button
                type="button"
                onClick={clearEditLikeThis}
                className="px-2.5 py-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] text-[11px]"
              >
                Clear
              </button>
            )}
            </div>
          )}

          {editLikeThisStep !== "idle" && (
            <div className="space-y-1.5">
              <div className="h-1 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-blue-500 transition-[width] duration-300"
                  style={{ width: `${Math.max(0, Math.min(100, ((currentIdx + (editLikeThisStep === "complete" ? 0 : 1)) / STEPS.length) * 100))}%` }}
                />
              </div>
              {isEditLikeThisRunning && currentIdx >= 0 && !showRunDetails && (
                <div className="flex items-center gap-2 text-[10px] text-[var(--text-primary)]">
                  <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-500/20 text-[8px] text-blue-400">…</span>
                  <span>{STEPS[currentIdx]?.label}</span>
                </div>
              )}
              {(showRunDetails || !isEditLikeThisRunning) && STEPS.map((step, i) => {
                const done = currentIdx > i || editLikeThisStep === "complete";
                const active = currentIdx === i && isEditLikeThisRunning;
                return (
                  <div key={step.key} className="flex items-center gap-2 text-[10px]">
                    <span
                      className={`w-3.5 h-3.5 rounded-full flex items-center justify-center text-[8px] ${
                        done
                          ? "bg-green-500/20 text-green-400"
                          : active
                            ? "bg-blue-500/20 text-blue-400"
                            : "bg-zinc-800 text-zinc-600"
                      }`}
                    >
                      {done ? "✓" : active ? "…" : i + 1}
                    </span>
                    <span className={done || active ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}>
                      {step.label}
                    </span>
                  </div>
                );
              })}
              {isEditLikeThisRunning && (
                <button
                  type="button"
                  onClick={() => setShowRunDetails((value) => !value)}
                  className="text-[10px] text-blue-400 hover:text-blue-300"
                >
                  {showRunDetails ? "Hide all steps" : "Show all steps"}
                </button>
              )}
              {editLikeThisDetail && !isEditLikeThisRunning && editLikeThisStep !== "error" && (
                <p className="text-[10px] text-[var(--text-muted)] pt-1">{editLikeThisDetail}</p>
              )}
              {editLikeThisStep === "error" && (
                <p className="text-[10px] text-red-400">{editLikeThisDetail}</p>
              )}
              {editLikeThisStep === "complete" && editLikeThisQuality && (
                <p className={`text-[10px] ${editLikeThisQuality === "polished" ? "text-green-400" : "text-amber-300"}`}>
                  {editLikeThisQuality === "polished" ? "Validated polished edit" : "Validated deterministic draft"}
                </p>
              )}
              {editLikeThisWarnings.length > 0 && (
                <div className="rounded border border-amber-500/25 bg-amber-500/5 p-1.5 space-y-1">
                  {editLikeThisWarnings.map((warning, index) => (
                    <p key={`${warning}-${index}`} className="text-[10px] leading-snug text-amber-200/80">{warning}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {blueprint && (
            <details className="rounded border border-[var(--border-default)] bg-[var(--bg-primary)]">
              <summary className="cursor-pointer list-none p-2 text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
                Blueprint · {blueprint.segments.length} segments · {blueprint.totalDuration.toFixed(1)}s
              </summary>
              <div className="max-h-40 space-y-1.5 overflow-y-auto px-2 pb-2">
              <p className="text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
                Reference style details
              </p>
              <p className="text-[10px] text-[var(--text-muted)]">
                {blueprint.overallStyle.pacing} pacing · {blueprint.overallStyle.mood} ·{" "}
                {blueprint.audioAnalysis.beatSource === "unavailable" || blueprint.audioAnalysis.bpm <= 0
                  ? "beat grid unavailable"
                  : `${blueprint.audioAnalysis.bpm} BPM`}
              </p>
              {styleDna && (
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[10px] text-[var(--text-muted)]">
                    Style DNA · {styleDna.pacing.label} · roles{" "}
                    {styleDna.narrativeRoles.map((r) => r.role).join("/")} · palette{" "}
                    {styleDna.color.palette.slice(0, 3).join(", ") || "n/a"}
                  </p>
                  <button
                    type="button"
                    className="shrink-0 text-[10px] text-blue-400 hover:text-blue-300"
                    onClick={() => {
                      const lib = useProjectStore.getState().styleDnaLibrary || [];
                      const id = `dna_lib_${Date.now().toString(36)}`;
                      useProjectStore.getState().setStyleDnaLibrary([
                        ...lib,
                        {
                          id,
                          name: `ELT ${new Date().toLocaleDateString()}`,
                          dna: styleDna,
                          createdAt: new Date().toISOString(),
                        },
                      ]);
                      toast.success("Style DNA saved to project library");
                    }}
                  >
                    Save DNA
                  </button>
                </div>
              )}
              {blueprint.segments.slice(0, 8).map((seg) => {
                const mapping = assetMappings.find((m) => m.segmentIndex === seg.index);
                return (
                  <div key={seg.index} className="text-[10px] text-[var(--text-muted)] truncate">
                    <span className="text-[var(--text-primary)]">#{seg.index}</span>{" "}
                    {seg.shotType} · {seg.duration.toFixed(1)}s
                    {mapping?.role ? ` [${mapping.role}]` : ""}
                    {mapping ? ` → ${mapping.assetName}` : ""}
                  </div>
                );
              })}
              {blueprint.segments.length > 8 && (
                <p className="text-[10px] text-[var(--text-muted)]">
                  +{blueprint.segments.length - 8} more segments
                </p>
              )}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
