// ============================================================
// STYLE DNA — abstract editing style for Edit Like This
// ============================================================

import type { ColorStatistics } from "./media.types.js";

/** Narrative / structural roles used for shot matching */
export type StyleDnaNarrativeRole =
  | "hook"
  | "build"
  | "drop"
  | "outro"
  | "broll"
  | "cta";

export interface StyleDnaPacing {
  avgShotSec: number;
  /** Cuts per minute */
  cutRate: number;
  label: "slow" | "moderate" | "fast" | "variable";
}

export interface StyleDnaColor {
  palette: string[];
  gradingHint: string;
  /** -1..1 soft bias for contrast FX when applying hints */
  contrastBias?: number;
  /** Reference-video profile extracted from decoded frames, when available. */
  referenceStatistics?: ColorStatistics;
}

export interface StyleDnaTypography {
  /** Text overlays per minute (approx) */
  density: number;
  preferredPositions: Array<"top" | "center" | "bottom" | "custom">;
  animationHints: string[];
}

export interface StyleDnaMotion {
  zoomBias: number;
  panBias: number;
  /** 0..1 average energy */
  energy: number;
}

export interface StyleDnaAudio {
  bpm?: number;
  mood?: string;
  /** Prefer cuts on beats when true */
  beatCutBias: boolean;
}

export interface StyleDnaTransitions {
  /** Detected names only — apply only if engine supports */
  vocabulary: string[];
}

export interface StyleDnaNarrativeRoleSpec {
  role: StyleDnaNarrativeRole;
  weight: number;
  targetDurationSec?: number;
  energy?: number;
  shotCriteria: string[];
}

/**
 * Abstract Style DNA — apply without cloning exact reference shots.
 * Persisted on `projects.data.styleDna`.
 */
export interface StyleDNA {
  id: string;
  source: "reference" | "manual";
  referenceUrl?: string;
  derivedFromBlueprintId?: string;
  pacing: StyleDnaPacing;
  color: StyleDnaColor;
  typography: StyleDnaTypography;
  motion: StyleDnaMotion;
  audio: StyleDnaAudio;
  transitions: StyleDnaTransitions;
  narrativeRoles: StyleDnaNarrativeRoleSpec[];
  createdAt: string;
}
