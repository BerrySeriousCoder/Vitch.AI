import type {
  EditBlueprint,
  StyleDNA,
  StyleDnaNarrativeRole,
  StyleDnaNarrativeRoleSpec,
  ShotIndexEntry,
  Track,
  Effect,
  Clip,
} from "@tempo/types";
import { defaultEffectInstance, getEffectDefinition } from "./effect-registry";
import {
  applyAnimationPresetToKeyframes,
  getAnimationPreset,
} from "./animation-presets";
import {
  applyTextAnimatorPreset,
  getTextAnimatorPreset,
} from "./text-animators";
import { deriveColorMatch, NEUTRAL_COLOR_STATISTICS } from "./color-match";

/** Map vision/blueprint animation labels onto registered preset ids */
export const STYLE_DNA_ANIMATION_MAP: Record<string, string> = {
  "fade-in": "fade-in",
  fade: "fade-in",
  "slide-up": "slide-in-up",
  "slide-in-up": "slide-in-up",
  "slide-in-left": "slide-in-left",
  "scale-up": "scale-up",
  bounce: "bounce",
  glitch: "glitch",
  typewriter: "typewriter",
  kinetic: "cascade-up",
  "cascade-up": "cascade-up",
  "word-pop": "word-pop",
  "line-fade": "line-fade",
  none: "fade-in",
};

export function resolveStyleDnaAnimationPresetId(
  hint?: string | null
): string | null {
  if (!hint) return null;
  const mapped = STYLE_DNA_ANIMATION_MAP[hint.toLowerCase()] || hint;
  if (getTextAnimatorPreset(mapped) || getAnimationPreset(mapped)) return mapped;
  return null;
}

function newId(): string {
  return `dna_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface RankedShot {
  shot: ShotIndexEntry;
  score: number;
  reasons: string[];
}

export interface RankShotsCriteria {
  role?: StyleDnaNarrativeRole | string;
  query?: string;
  shotType?: string;
  tags?: string[];
  minDuration?: number;
  maxDuration?: number;
  /** Optional query embedding; blended with heuristic score when shots have embeddings */
  queryEmbedding?: number[];
  /** Weight 0..1 for cosine contribution (default 0.45) */
  embeddingWeight?: number;
}

export interface ApplyStyleDnaOpts {
  /** Only mutate video/image clips (default true) */
  videoOnly?: boolean;
  /** Skip clips that already have any color FX (default true) */
  skipIfHasColorFx?: boolean;
  /** Optional exact scope, used by reference recreation to preserve unrelated user layers. */
  clipIds?: readonly string[];
}

const COLOR_FX = new Set([
  "brightness",
  "contrast",
  "saturate",
  "hue-rotate",
  "grayscale",
  "sepia",
  "vignette",
  "color-grade",
  "levels",
  "lift-gamma-gain",
  "hsl-secondary",
  "color-curves",
]);

const ROLE_ORDER: StyleDnaNarrativeRole[] = [
  "hook",
  "build",
  "drop",
  "broll",
  "cta",
  "outro",
];

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
}

function tokenOverlap(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

function shotDuration(shot: ShotIndexEntry): number {
  return Math.max(0, (shot.end ?? 0) - (shot.start ?? 0));
}

function assignRolesFromSegments(
  bp: EditBlueprint
): StyleDnaNarrativeRoleSpec[] {
  const segments = bp.segments || [];
  if (segments.length === 0) {
    return [
      {
        role: "hook",
        weight: 1,
        shotCriteria: ["opening", "attention"],
      },
    ];
  }

  const energies = segments.map((s) => Number(s.energyLevel) || 0);
  const maxEnergy = Math.max(...energies, 1);
  const dropIdx = energies.indexOf(Math.max(...energies));
  const roles: StyleDnaNarrativeRoleSpec[] = [];

  const pushRole = (
    role: StyleDnaNarrativeRole,
    idx: number,
    weight: number,
    criteria: string[]
  ) => {
    const seg = segments[idx];
    if (!seg) return;
    roles.push({
      role,
      weight,
      targetDurationSec: seg.duration,
      energy: clamp01((Number(seg.energyLevel) || 0) / 100),
      shotCriteria: [
        ...criteria,
        seg.shotType,
        seg.visualDescription?.slice(0, 80) || "",
      ].filter(Boolean),
    });
  };

  pushRole("hook", 0, 1.2, ["opening", "hook", "attention"]);
  if (segments.length >= 3) {
    const mid = Math.floor(segments.length / 2);
    pushRole("build", mid, 1, ["build", "story"]);
  }
  if (dropIdx > 0) {
    pushRole("drop", dropIdx, 1 + energies[dropIdx]! / maxEnergy, [
      "climax",
      "drop",
      "peak",
    ]);
  }
  if (segments.length > 1) {
    pushRole("outro", segments.length - 1, 0.9, ["outro", "ending", "cta"]);
  }

  // Ensure unique roles (keep highest weight) — prefer outro on last segment over drop
  const byRole = new Map<StyleDnaNarrativeRole, StyleDnaNarrativeRoleSpec>();
  for (const r of roles) {
    const prev = byRole.get(r.role);
    if (!prev || r.weight > prev.weight) byRole.set(r.role, r);
  }
  // If drop stole the last segment slot, restore outro and move drop if needed
  if (segments.length > 1) {
    const last = segments[segments.length - 1]!;
    const drop = byRole.get("drop");
    if (drop && drop.targetDurationSec === last.duration && dropIdx === segments.length - 1) {
      byRole.set("outro", {
        role: "outro",
        weight: 0.95,
        targetDurationSec: last.duration,
        energy: clamp01((Number(last.energyLevel) || 0) / 100),
        shotCriteria: ["outro", "ending", "cta"],
      });
      // Prefer previous high-energy segment for drop when last was peak
      let alt = -1;
      let altE = -1;
      for (let i = 0; i < segments.length - 1; i++) {
        const e = energies[i]!;
        if (e > altE) {
          altE = e;
          alt = i;
        }
      }
      if (alt >= 0) {
        const seg = segments[alt]!;
        byRole.set("drop", {
          role: "drop",
          weight: 1 + altE / maxEnergy,
          targetDurationSec: seg.duration,
          energy: clamp01(altE / 100),
          shotCriteria: ["climax", "drop", "peak", seg.shotType, seg.visualDescription?.slice(0, 80) || ""].filter(Boolean),
        });
      }
    }
  }
  return ROLE_ORDER.map((role) => byRole.get(role)).filter(
    Boolean
  ) as StyleDnaNarrativeRoleSpec[];
}

/**
 * Derive abstract Style DNA from an Edit Like This blueprint.
 */
export function extractStyleDnaFromBlueprint(bp: EditBlueprint): StyleDNA {
  const segments = bp.segments || [];
  const n = Math.max(1, segments.length);
  const totalDur = Math.max(
    0.1,
    Number(bp.totalDuration) ||
      segments.reduce((s, seg) => s + (seg.duration || 0), 0)
  );
  const avgShotSec =
    segments.length > 0
      ? segments.reduce((s, seg) => s + (seg.duration || 0), 0) / segments.length
      : totalDur;
  const cutRate = (segments.length / totalDur) * 60;

  const palette: string[] = [];
  for (const seg of segments) {
    for (const c of seg.colorPalette || []) {
      if (c && !palette.includes(c)) palette.push(c);
      if (palette.length >= 8) break;
    }
    if (palette.length >= 8) break;
  }

  const textOverlays = segments.flatMap((s) => s.textOverlays || []);
  const positions = Array.from(
    new Set(textOverlays.map((t) => t.position).filter(Boolean))
  ) as StyleDNA["typography"]["preferredPositions"];
  const animationHints = Array.from(
    new Set(
      textOverlays
        .map((t) => t.animation || t.style)
        .filter(Boolean)
        .map(String)
    )
  ).slice(0, 8);

  const motionVotes = { zoom: 0, pan: 0 };
  let energySum = 0;
  for (const seg of segments) {
    energySum += clamp01((Number(seg.energyLevel) || 0) / 100);
    const m = seg.motionType || "";
    if (m.includes("zoom")) motionVotes.zoom++;
    if (m.includes("pan") || m === "tracking") motionVotes.pan++;
  }

  const vocab = Array.from(
    new Set(
      segments
        .map((s) => s.transitionToNext)
        .filter((t) => t && t !== "none" && t !== "cut")
        .map(String)
    )
  );

  const onBeatCount = segments.filter((s) => s.onBeat).length;

  return {
    id: newId(),
    source: "reference",
    referenceUrl: bp.referenceUrl,
    derivedFromBlueprintId: bp.id,
    pacing: {
      avgShotSec: Number(avgShotSec.toFixed(3)),
      cutRate: Number(cutRate.toFixed(2)),
      label: bp.overallStyle?.pacing || "moderate",
    },
    color: {
      palette,
      gradingHint:
        bp.overallStyle?.colorGrading ||
        (palette[0] ? `Dominant: ${palette[0]}` : "neutral"),
      contrastBias: bp.overallStyle?.pacing === "fast" ? 0.15 : 0.05,
      referenceStatistics: bp.colorStatistics,
    },
    typography: {
      density: Number(((textOverlays.length / totalDur) * 60).toFixed(2)),
      preferredPositions: positions.length > 0 ? positions : ["center"],
      animationHints,
    },
    motion: {
      zoomBias: motionVotes.zoom / n,
      panBias: motionVotes.pan / n,
      energy: clamp01(energySum / n),
    },
    audio: {
      bpm: bp.audioAnalysis?.bpm,
      mood: bp.audioAnalysis?.mood || bp.overallStyle?.mood,
      beatCutBias: onBeatCount / n >= 0.35,
    },
    transitions: { vocabulary: vocab },
    narrativeRoles: assignRolesFromSegments(bp),
    createdAt: new Date().toISOString(),
  };
}

function roleText(role: string, dna?: StyleDNA | null): string {
  const spec = dna?.narrativeRoles?.find((r) => r.role === role);
  const parts = [
    role,
    ...(spec?.shotCriteria || []),
    dna?.audio?.mood || "",
    dna?.color?.gradingHint || "",
  ];
  return parts.filter(Boolean).join(" ");
}

/**
 * Heuristic score for how well a shot fits a narrative role / DNA.
 */
export function scoreShotForRole(
  shot: ShotIndexEntry,
  role: StyleDnaNarrativeRole | string,
  dna?: StyleDNA | null
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const hay = [
    shot.summary,
    ...(shot.tags || []),
    ...(shot.subjects || []),
    ...(shot.bestFor || []),
    shot.shotType,
    shot.mood,
    shot.cameraMotion,
  ]
    .filter(Boolean)
    .join(" ");

  const needle = roleText(role, dna);
  const overlap = tokenOverlap(needle, hay);
  score += overlap * 40;
  if (overlap > 0.15) reasons.push(`text overlap ${(overlap * 100).toFixed(0)}%`);

  const bestFor = (shot.bestFor || []).map((b) => b.toLowerCase());
  if (bestFor.some((b) => b.includes(String(role).toLowerCase()))) {
    score += 25;
    reasons.push(`bestFor includes ${role}`);
  }

  const spec = dna?.narrativeRoles?.find((r) => r.role === role);
  if (spec?.energy != null && shot.energy != null) {
    const diff = Math.abs(spec.energy - shot.energy);
    const energyScore = (1 - diff) * 15;
    score += energyScore;
    if (diff < 0.25) reasons.push("energy match");
  }

  if (spec?.targetDurationSec != null) {
    const d = shotDuration(shot);
    const ratio =
      Math.min(d, spec.targetDurationSec) /
      Math.max(d, spec.targetDurationSec, 0.1);
    score += ratio * 12;
    if (ratio > 0.6) reasons.push("duration fit");
  }

  if (dna?.pacing?.avgShotSec && shotDuration(shot) > 0) {
    const d = shotDuration(shot);
    const ratio =
      Math.min(d, dna.pacing.avgShotSec) /
      Math.max(d, dna.pacing.avgShotSec, 0.1);
    score += ratio * 8;
  }

  if (shot.shotType && needle.toLowerCase().includes(shot.shotType.toLowerCase())) {
    score += 8;
    reasons.push(`shotType ${shot.shotType}`);
  }

  return { score: Number(score.toFixed(2)), reasons };
}

/**
 * Rank shots for a role or free-text criteria.
 */
export function rankShots(
  shots: readonly ShotIndexEntry[],
  criteria: RankShotsCriteria | StyleDnaNarrativeRole | string,
  dna?: StyleDNA | null
): RankedShot[] {
  const c: RankShotsCriteria =
    typeof criteria === "string" ? { role: criteria } : criteria || {};
  const role = c.role || c.query || "broll";
  const queryExtra = c.query || "";

  let filtered = [...shots];
  if (c.shotType) {
    filtered = filtered.filter(
      (s) => (s.shotType || "").toLowerCase() === c.shotType!.toLowerCase()
    );
  }
  if (c.tags?.length) {
    const want = new Set(c.tags.map((t) => t.toLowerCase()));
    filtered = filtered.filter((s) =>
      (s.tags || []).some((t) => want.has(t.toLowerCase()))
    );
  }
  if (c.minDuration != null) {
    filtered = filtered.filter((s) => shotDuration(s) >= c.minDuration!);
  }
  if (c.maxDuration != null) {
    filtered = filtered.filter((s) => shotDuration(s) <= c.maxDuration!);
  }

  const ranked = filtered.map((shot) => {
    const base = scoreShotForRole(shot, role, dna);
    let score = base.score;
    const reasons = [...base.reasons];
    if (queryExtra) {
      const hay = [shot.summary, ...(shot.tags || []), ...(shot.subjects || [])]
        .filter(Boolean)
        .join(" ");
      const o = tokenOverlap(queryExtra, hay);
      score += o * 20;
      if (o > 0.1) reasons.push("query match");
    }
    if (c.queryEmbedding?.length && shot.embedding?.length) {
      const sim = cosineSimilarity(c.queryEmbedding, shot.embedding);
      const w = Math.max(0, Math.min(1, c.embeddingWeight ?? 0.45));
      score = score * (1 - w) + sim * 100 * w;
      if (sim > 0.2) reasons.push(`embedding ${sim.toFixed(2)}`);
    } else if (c.queryEmbedding?.length) {
      // Penalize missing embeddings the same way so heuristic-only shots don't dominate
      const w = Math.max(0, Math.min(1, c.embeddingWeight ?? 0.45));
      score = score * (1 - w);
    }
    return { shot, score: Number(score.toFixed(2)), reasons };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/** Cosine similarity in [-1, 1]; 0 if invalid. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!(na > 0) || !(nb > 0)) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function clipHasColorFx(clip: Clip): boolean {
  return (clip.effects || []).some(
    (e) => e.enabled !== false && COLOR_FX.has(e.type)
  );
}

function ensureEffect(
  effects: Effect[],
  type: string,
  params: object
): Effect[] {
  const existing = effects.find((e) => e.type === type);
  if (existing) return effects;
  const def = getEffectDefinition(type);
  if (!def) return effects;
  const inst = defaultEffectInstance(type, newId());
  if (!inst) return effects;
  return [...effects, { ...inst, params: { ...inst.params, ...params } }];
}

/**
 * Non-destructive Style DNA hints: add mild color FX / text animation
 * where missing. Does not invent unsupported transitions or LUTs.
 */
export function applyStyleDnaHints(
  tracks: Track[],
  dna: StyleDNA,
  opts: ApplyStyleDnaOpts = {}
): Track[] {
  const videoOnly = opts.videoOnly !== false;
  const skipIfHasColorFx = opts.skipIfHasColorFx !== false;
  const contrast =
    1 + Math.max(-0.3, Math.min(0.3, dna.color.contrastBias ?? 0.05));
  const saturate =
    dna.motion.energy > 0.6 ? 1.1 : dna.motion.energy < 0.3 ? 0.9 : 1;
  const referenceGrade = dna.color.referenceStatistics
    ? deriveColorMatch(dna.color.referenceStatistics, NEUTRAL_COLOR_STATISTICS, 0.25).grade
    : null;
  const animHint = dna.typography.animationHints[0];
  const animPresetId = resolveStyleDnaAnimationPresetId(animHint);
  const kineticPreset = animPresetId ? getTextAnimatorPreset(animPresetId) : null;
  const animPreset = animPresetId ? getAnimationPreset(animPresetId) : null;
  const clipIds = opts.clipIds ? new Set(opts.clipIds) : null;

  return tracks.map((track) => {
    if (videoOnly && track.type !== "video" && track.type !== "text") {
      return track;
    }

    const clips = (track.clips || []).map((clip) => {
      if (clipIds && !clipIds.has(clip.id)) return clip;
      if (track.type === "text") {
        if (kineticPreset && clip.textParams) {
          if (clip.textParams.animators?.length) return clip;
          return {
            ...clip,
            textParams: applyTextAnimatorPreset(
              clip.textParams,
              kineticPreset.id,
              clip.duration
            ),
          };
        }
        if (animPreset) {
          if ((clip.keyframes || []).length > 0) return clip;
          const keyframes = applyAnimationPresetToKeyframes(
            animPreset.id,
            clip.duration
          );
          if (!keyframes) return clip;
          return { ...clip, keyframes };
        }
        return clip;
      }

      if (track.type !== "video") return clip;
      if (skipIfHasColorFx && clipHasColorFx(clip)) return clip;

      let effects = [...(clip.effects || [])];
      if (referenceGrade) {
        effects = ensureEffect(effects, "color-grade", referenceGrade);
      } else {
        effects = ensureEffect(effects, "contrast", { value: contrast });
        effects = ensureEffect(effects, "saturate", { value: saturate });
      }
      return { ...clip, effects };
    });

    return { ...track, clips };
  });
}
