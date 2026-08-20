import { runAgentLoop, type SSEEvent } from "../ai/agent.service.js";
import { logger } from "../../utils/logger.js";
import type { EditBlueprint, MediaAsset, ProjectSettings, StyleDNA } from "@tempo/types";
import type { AssetMapping } from "./asset-matching.service.js";
import type { Content } from "@google/genai";
import type { ReferenceEditComparison } from "../critique/reference-comparison.service.js";
import type {
  RecreationManifest,
  RecreationProjectContext,
} from "./recreation-compiler.service.js";

const ANIMATION_MAP: Record<string, string> = {
  "fade-in": "fade-in",
  fade: "fade-in",
  "slide-up": "slide-in-up",
  "slide-in-up": "slide-in-up",
  "slide-in-left": "slide-in-left",
  "scale-up": "scale-up",
  bounce: "bounce",
  glitch: "glitch",
  typewriter: "typewriter",
  kinetic: "slide-in-up",
  none: "none",
};

function mapTextAnimation(animation?: string): string {
  if (!animation) return "none";
  return ANIMATION_MAP[animation.toLowerCase()] || "none";
}

function summarizeDna(dna: StyleDNA): string {
  const roles = dna.narrativeRoles
    .map((r) => `${r.role}(w=${r.weight.toFixed(1)})`)
    .join(", ");
  const referenceStats = dna.color.referenceStatistics;
  const decodedColorProfile = referenceStats
    ? `Decoded color profile: luma=${referenceStats.meanLuma.toFixed(2)}, contrast=${referenceStats.lumaStdDev.toFixed(2)}, saturation=${referenceStats.meanSaturation.toFixed(2)}, source=${referenceStats.source}. Use apply_reference_color_match after clips are placed.`
    : null;
  return [
    `Style DNA (${dna.source}): pacing=${dna.pacing.label} avgShot=${dna.pacing.avgShotSec}s cutRate=${dna.pacing.cutRate}/min`,
    `Color: ${dna.color.gradingHint}; palette=${dna.color.palette.slice(0, 4).join(", ") || "n/a"}`,
    decodedColorProfile,
    `Motion energy=${dna.motion.energy.toFixed(2)} zoomBias=${dna.motion.zoomBias.toFixed(2)}`,
    `Audio: bpm=${dna.audio.bpm ?? "?"} mood=${dna.audio.mood ?? "?"} beatCutBias=${dna.audio.beatCutBias}`,
    `Transitions vocab (apply only if supported): ${dna.transitions.vocabulary.join(", ") || "cut"}`,
    `Typography density=${dna.typography.density}/min hints=${dna.typography.animationHints.slice(0, 3).join(", ") || "none"}`,
    `Roles: ${roles || "none"}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

/**
 * Build a structured prompt that instructs the AI agent to recreate the edit
 * using Style DNA (style transfer) + ranked shot mappings — not shot cloning.
 */
function buildRecreationPrompt(
  blueprint: EditBlueprint,
  mappings: AssetMapping[],
  manifest: RecreationManifest,
  styleDna?: StyleDNA | null,
  targetSettings?: Pick<ProjectSettings, "width" | "height">
): string {
  const beatTimes = blueprint.audioAnalysis.beats
    .slice(0, 80)
    .map((b) =>
      b.isDownbeat ? `${b.time.toFixed(2)}*` : b.time.toFixed(2)
    )
    .join(", ");

  const parts: string[] = [
    `Recreate this video edit as STYLE TRANSFER from the reference — do not clone exact reference shots.`,
    `A deterministic compiler has already assembled and source-bounds-checked the complete reference cut. Polish that cut; do not rebuild it.`,
    `The reference was ${blueprint.totalDuration.toFixed(1)}s with ${blueprint.segments.length} segments.`,
    `Reference raster: ${blueprint.referenceWidth || "unknown"}x${blueprint.referenceHeight || "unknown"}; target raster: ${targetSettings?.width || "unknown"}x${targetSettings?.height || "unknown"}.`,
    `The compiler already adapted text groups into target title-safe bounds when those aspect ratios differ. Preserve relative typography hierarchy, then inspect simultaneous text for collision, clipping, and platform-UI occlusion; reflow only the failing group rather than copying reference pixels or moving unrelated captions.`,
    `Overall style: ${blueprint.overallStyle.pacing} pacing, ${blueprint.overallStyle.mood} mood, ${blueprint.overallStyle.genre} genre.`,
    `Color grading hint: ${blueprint.overallStyle.colorGrading || "match segment palettes"}.`,
    blueprint.audioAnalysis.beatSource === "detected" && blueprint.audioAnalysis.bpm > 0
      ? `Audio: measured ${blueprint.audioAnalysis.bpm} BPM, mood ${blueprint.audioAnalysis.mood}. Reference cut times already preserve the detected rhythm.`
      : `Audio: reliable BPM unavailable, mood ${blueprint.audioAnalysis.mood}. Do not synthesize a beat grid.`,
    beatTimes
      ? `Beat grid (seconds, *=downbeat): ${beatTimes}`
      : "Beat grid: unavailable — preserve compiled reference cut times and do not invent a metronome.",
    "",
  ];

  if (styleDna) {
    parts.push("STYLE DNA (authoritative abstract style):");
    parts.push(summarizeDna(styleDna));
    parts.push(
      "Place ranked shots first; call apply_style_dna after clips/text exist (hints need clips to mutate)."
    );
    parts.push("");
  }

  parts.push(
    "For each segment, use the mapped asset/shot (role-ranked). Prefer DNA roles over copying reference composition:"
  );
  parts.push("");

  for (const segment of blueprint.segments) {
    const mapping = mappings.find((m) => m.segmentIndex === segment.index && !m.layerId);
    const layerMappings = mappings.filter((m) => m.segmentIndex === segment.index && m.layerId);
    if (!mapping && layerMappings.length === 0) continue;
    const generated = manifest.entries.find(
      (entry) => entry.binding.kind === "segment" && entry.binding.segmentIndex === segment.index
    );

    parts.push(`SEGMENT ${segment.index}${mapping?.role ? ` [${mapping.role}]` : ""}:`);
    if (generated) parts.push(`  Existing generated clip id: ${generated.clipId}`);
    if (mapping) {
      parts.push(`  Asset: "${mapping.assetName}" (id: ${mapping.assetId})`);
      if (mapping.shotId) parts.push(`  Shot id: ${mapping.shotId}`);
    }
    parts.push(
      `  Timeline: start=${segment.startTime.toFixed(2)}s, duration=${segment.duration.toFixed(2)}s`
    );
    parts.push(
      mapping
        ? `  Source in-point: ${mapping.inPoint.toFixed(2)}s (already compiled)`
        : "  Base full-frame clip intentionally replaced by measured composition layers."
    );
    parts.push(
      `  Shot: ${segment.shotType}, Motion: ${segment.motionType}, Speed: ${segment.speed}x`
    );
    parts.push(
      `  Energy: ${segment.energyLevel}/100, On beat: ${segment.onBeat}`
    );
    parts.push(`  Transition to next: ${segment.transitionToNext}`);
    parts.push(`  Visual intent: ${segment.visualDescription}`);
    if (segment.colorPalette?.length) {
      parts.push(`  Colors: ${segment.colorPalette.join(", ")}`);
    }

    if (segment.effects.length > 0) {
      parts.push(`  Effects: ${segment.effects.join(", ")}`);
    }

    if (segment.textOverlays.length > 0) {
      for (const text of segment.textOverlays) {
        parts.push(`  Text overlay: "${text.text}" (style=${text.style}, position=${text.position}, fill=${text.fillMode || "solid"})`);
        if (text.animationSpec) {
          parts.push(`    Measured animation recipe: ${JSON.stringify(text.animationSpec)}. Preserve it; do not substitute a preset or add unmeasured whole-text movement.`);
        } else {
          const preset = mapTextAnimation(text.animation);
          parts.push(`    Coarse animation hint only: ${preset}`);
        }
      }
    }

    if (segment.composition?.layers.length) {
      parts.push(`  Measured composition: replaceBase=${segment.composition.replaceBase}, background=${segment.composition.backgroundColor || "transparent"}`);
      for (const layer of segment.composition.layers) {
        const layerMapping = layerMappings.find((candidate) => candidate.layerId === layer.id);
        const generatedLayer = manifest.entries.find((entry) =>
          entry.binding.kind === "composition-layer" &&
          entry.binding.segmentIndex === segment.index &&
          entry.binding.layerId === layer.id
        );
        parts.push(`    Layer ${layer.id}: role=${layer.role}, clipId=${generatedLayer?.clipId || "omitted"}, asset=${layerMapping?.assetName || "unmapped"}, viewport=${JSON.stringify(layer.viewport)}, timing=${JSON.stringify(layer.timing)}, matteTextOverlayIndex=${layer.matteTextOverlayIndex ?? "none"}`);
        if (layer.motion) parts.push(`      Measured motion: ${JSON.stringify(layer.motion)}.`);
      }
    }

    parts.push("");
  }

  const vocab = (styleDna?.transitions.vocabulary || []).map((t) =>
    t.toLowerCase()
  );
  const wantsOpacity = vocab.some((t) =>
    ["crossfade", "dissolve", "fade", "dip-black"].includes(t)
  );
  const wantsWipe = vocab.some((t) => ["swipe", "wipe"].includes(t));
  const wantsPush = vocab.includes("push");
  const wantsWhip = vocab.includes("whip");
  const wantsIris = vocab.includes("iris");
  const supportedHints: string[] = [];
  if (wantsOpacity) supportedHints.push("crossfade or dip-black");
  if (wantsWipe) supportedHints.push("wipe (map swipe→wipe) with direction");
  if (wantsPush) supportedHints.push("push with direction");
  if (wantsWhip) supportedHints.push("whip with direction/blur");
  if (wantsIris) supportedHints.push("iris with softness/center");

  parts.push("Instructions (execute with tools):");
  parts.push(
    "1. Call inspect_timeline first. The generated segment and text clips already exist with referenceEditBinding provenance. Never delete, duplicate, move, trim, retime, or replace those bound clips."
  );
  parts.push(
    "2. Polish existing text clips using their returned IDs. Their base layout is already normalized/clamped from detected reference geometry; preserve it unless validate_graphic_layout reports a problem."
  );
  parts.push(
    `3. Call apply_style_dna only when it will not overwrite measured layer/text motion. If decoded reference color statistics exist, call apply_reference_color_match for only generated video/composition clip IDs at the restrained default strength; never grade text, matte sources, or music.`
  );
  parts.push(
    "4. For deliberate grading, call get_effect_schema for color-grade, then add_effect color-grade with restrained params derived from the DNA and palette; add vignette or LUT only when the reference calls for it."
  );
  parts.push(
    "5. Do not move cuts to guessed beats. The compiler preserves measured reference timings; an empty beat grid means timing confidence was unavailable."
  );
  parts.push(
    `6. Preserve the explicit audio policy exactly: soundtrack=${manifest.audioPolicy.soundtrack}, sourceAudio=${manifest.audioPolicy.sourceAudio}. Do not replace, delete, retime, mute, unmute, remix, or duplicate reference-bound segment/music clips.`
  );
  parts.push("7. Do not invent media or clip IDs. Use only IDs listed here or returned by inspect tools.");
  if (supportedHints.length > 0) {
    parts.push(
      `8. Transitions were already attempted deterministically from the blueprint (${supportedHints.join("; ")}). Inspect them; do not add duplicates.`
    );
  } else {
    parts.push(
      "8. Preserve the compiled hard cuts; do not add speculative transitions."
    );
  }
  parts.push("9. Finish with validate_graphic_layout and validate_timeline. Same-track text overlap is a structural caption failure: never call add_transition for it and never label it intentional or safe to ignore. The server performs the authoritative reference comparison after your pass; do not claim visual fidelity from structural validation alone.");
  parts.push("10. Presets are conveniences, not constraints. When measured recipes exist, preserve their custom keyframes, viewports, text animator channels, and matte relationships exactly. Never add a guessed zoom/drift/transition merely because no preset name matches.");

  return parts.join("\n");
}

/**
 * Feed the blueprint, Style DNA, and asset mapping to the AI agent loop.
 */
export async function* recreateEdit(
  projectContext: RecreationProjectContext,
  mediaAssets: MediaAsset[],
  blueprint: EditBlueprint,
  mappings: AssetMapping[],
  manifest: RecreationManifest,
  styleDna?: StyleDNA | null,
  options: { signal?: AbortSignal } = {}
): AsyncGenerator<SSEEvent> {
  logger.info(
    { segments: blueprint.segments.length, mappings: mappings.length },
    "Starting edit recreation via AI agent"
  );

  const dna = styleDna ?? projectContext.styleDna ?? null;
  const prompt = buildRecreationPrompt(blueprint, mappings, manifest, dna, projectContext.settings);
  const conversationHistory: Content[] = [];

  for await (const event of runAgentLoop(
    {
      ...projectContext,
      editBlueprint: projectContext.editBlueprint ?? blueprint,
      styleDna: dna,
    },
    mediaAssets,
    prompt,
    conversationHistory,
    options
  )) {
    yield event;
  }
}

/** One bounded correction pass driven only by paired reference/render evidence. */
export async function* repairVerifiedRecreation(
  projectContext: RecreationProjectContext,
  mediaAssets: MediaAsset[],
  blueprint: EditBlueprint,
  manifest: RecreationManifest,
  comparisons: Array<{ segmentIndex: number; result: ReferenceEditComparison }>,
  options: { signal?: AbortSignal } = {}
): AsyncGenerator<SSEEvent> {
  const failures = comparisons.filter(({ result }) =>
    result.verdict === "mismatch" || result.differences.some((difference) => difference.severity === "error")
  );
  if (!failures.length) return;
  const allowedClipIds = [...new Set(failures.flatMap(({ segmentIndex }) =>
    manifest.entries
      .filter((entry) => entry.binding.segmentIndex === segmentIndex)
      .map((entry) => entry.clipId)
  ))];
  const prompt = `Repair this deterministic Edit Like This draft using the paired reference/render evidence below.

${JSON.stringify(failures, null, 2)}

The only clips in scope are: ${JSON.stringify(allowedClipIds)}

Rules:
- Inspect the timeline first and use only existing clip ids or registered tools.
- Modify only the listed in-scope clip ids. Do not bulk-update a whole track or touch clips from passing ranges.
- Preserve referenceEditBinding clip identity, source selection, source bounds, and audio policy.
- Correct measured viewport/keyframe timing, text size/animation, matte relation, z-order, and restrained color only where the evidence identifies a mismatch.
- Do not add speculative presets, clips, effects, or whole-layer motion.
- Do not remove strokes, effects, animation channels, or text merely to make validation pass unless a specific paired-frame difference identifies that exact property.
- Matte-fill and support clips must never receive automatic color grading.
- Never use add_transition to address overlapping text clips. Text overlap is a timing/layout failure and must remain unresolved unless the paired evidence supports a permitted in-scope text correction.
- Finish with validate_graphic_layout and validate_timeline. Treat any warning affecting an in-scope clip as unresolved; do not claim completion until both validators pass. The server will render and compare the same ranges again.`;
  for await (const event of runAgentLoop(
    { ...projectContext, editBlueprint: blueprint },
    mediaAssets,
    prompt,
    [],
    options
  )) yield event;
}
