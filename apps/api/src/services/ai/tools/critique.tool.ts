import type { CritiqueScorecard } from "@tempo/types";
import {
  validateTimeline,
  formatTimelineValidationIssues,
  estimateTextBounds,
  resolveDeliveryProfile,
  resolveGraphicGeometry,
  validateGraphicGeometry,
  toolErr,
} from "@tempo/editor-core";
import type { ProjectState } from "./project-state.js";
import { sampleCritiqueFrames } from "../../critique/critique-frames.service.js";
import { runVisionCritique } from "../../critique/critique-vision.service.js";
import { checkChromiumHealth } from "../../../utils/chromium-health.js";

function timelineEnd(state: ProjectState): number {
  let max = 0;
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      max = Math.max(max, clip.startTime + clip.duration);
    }
  }
  return max;
}

function graphicLayoutIssues(state: ProjectState): string[] {
  if (!state.settings) return [];
  const profile = resolveDeliveryProfile(state.settings);
  const issues: string[] = [];
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      if (!clip.layout || (!clip.textParams && !clip.shapeParams)) continue;
      const intrinsic = clip.textParams
        ? estimateTextBounds(clip.textParams)
        : { width: clip.shapeParams!.width, height: clip.shapeParams!.height };
      const geometry = resolveGraphicGeometry(profile, clip.layout, intrinsic);
      for (const issue of validateGraphicGeometry(profile, clip.layout, geometry)) {
        issues.push(`${issue.severity}: clip ${clip.id} ${issue.code}: ${issue.message}`);
      }
    }
  }
  return issues;
}

function sampleTimes(state: ProjectState, maxSamples = 10): number[] {
  const end = timelineEnd(state);
  const times = new Set<number>();
  if (end <= 0) {
    times.add(0);
    return [...times];
  }
  times.add(0);
  times.add(end * 0.5);
  times.add(Math.max(0, end - 0.05));
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      times.add(clip.startTime + Math.min(0.1, clip.duration * 0.5));
      times.add(clip.startTime + clip.duration * 0.5);
      if (clip.textParams) times.add(clip.startTime + 0.05);
    }
  }
  for (const tr of state.transitions || []) {
    for (const track of state.tracks) {
      const a = track.clips.find((c) => c.id === tr.clipAId);
      if (a) times.add(a.startTime + a.duration - tr.duration / 2);
    }
  }
  return [...times]
    .filter((t) => Number.isFinite(t) && t >= 0 && t <= end + 1e-3)
    .sort((a, b) => a - b)
    .slice(0, maxSamples);
}

function scorecardSummary(card: CritiqueScorecard): string {
  const dimBits = card.dims
    ? ` dims={visual:${card.dims.visual ?? "-"},pacing:${card.dims.pacing ?? "-"},typography:${card.dims.typography ?? "-"}}`
    : "";
  const overall =
    card.overall != null ? ` overall=${card.overall}` : "";
  if (card.issues.length === 0) {
    return `critique_preview: sampled ${card.sampledTimes.length} frame(s) — no issues flagged${overall}${dimBits}`;
  }
  const lines = card.issues.map(
    (i) =>
      `[${i.severity}] t=${i.time.toFixed(2)}s ${i.code}: ${i.message}${
        i.fixHint ? ` → ${i.fixHint}` : ""
      }${i.clipId ? ` (clip ${i.clipId})` : ""}`
  );
  return `critique_preview: ${card.issues.length} issue(s) from ${card.sampledTimes.length} frame(s)${overall}${dimBits}\n${lines.join("\n")}\n\nSCORECARD_JSON:${JSON.stringify(card)}`;
}

export const critiqueToolDefinitions = [
  {
    name: "validate_timeline",
    description:
      "Deterministic timeline and delivery-layout validation: structural issues plus graphic composition bounds, safe areas, and platform UI collisions. No vision.",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    name: "critique_preview",
    description:
      "Render composed preview frames (Chromium/WebGPU) at sample times and run a generic vision critic. Returns a CritiqueScorecard (JSON after SCORECARD_JSON:). It does not see the reference; use compare_reference_to_edit for recreation fidelity.",
    parameters: {
      type: "object" as const,
      properties: {
        maxFrames: {
          type: "number",
          description: "Max frames to sample (default 8, max 12)",
        },
      },
    },
  },
];

export const critiqueToolExecutors: Record<
  string,
  (
    args: Record<string, any>,
    state: ProjectState
  ) =>
    | { result: string; state: ProjectState }
    | Promise<{ result: string; state: ProjectState }>
> = {
  validate_timeline: (_args, state) => {
    const mediaDurations = Object.fromEntries(
      (state.mediaAssets || []).flatMap((asset) => {
        const duration = asset.duration ?? asset.metadata?.duration;
        return typeof duration === "number" && duration > 0 ? [[asset.id, duration]] : [];
      })
    );
    const issues = validateTimeline(
      state.tracks,
      state.transitions || [],
      state.sequences || [],
      mediaDurations
    );
    const layoutIssues = graphicLayoutIssues(state);
    if (issues.length === 0 && layoutIssues.length === 0) {
      return { result: "validate_timeline: OK (no structural or delivery-layout issues)", state };
    }
    const sections = [
      issues.length ? formatTimelineValidationIssues(issues) : "",
      layoutIssues.length ? layoutIssues.join("\n") : "",
    ].filter(Boolean);
    return {
      result: `validate_timeline: ${issues.length + layoutIssues.length} issue(s)\n${sections.join("\n")}`,
      state,
    };
  },

  critique_preview: async (args, state) => {
    if (!state.projectId) {
      return {
        result: toolErr(
          "projectId missing on agent state — cannot capture composed frames",
          { code: "NO_PROJECT_ID" }
        ),
        state,
      };
    }
    const health = await checkChromiumHealth();
    if (!health.ok) {
      return {
        result: toolErr(health.error, {
          code: health.code,
          fixHint: health.fixHint,
        }),
        state,
      };
    }
    const maxFrames = Math.min(12, Math.max(4, Number(args.maxFrames) || 8));
    const times = sampleTimes(state, maxFrames);
    try {
      const frames = await sampleCritiqueFrames({
        projectId: state.projectId,
        tracks: state.tracks,
        transitions: state.transitions || [],
        sequences: state.sequences || [],
        times,
      });
      const card = await runVisionCritique(frames);
      // Stamp related failed steps when plan exists and issues found
      if (state.editPlan && card.issues.length > 0) {
        const codes = [...new Set(card.issues.map((i) => i.code))];
        const now = new Date().toISOString();
        const target =
          state.editPlan.steps.find((s) => s.status === "in_progress") ||
          [...state.editPlan.steps]
            .reverse()
            .find((s) => s.status === "done");
        if (target) {
          target.status = "failed";
          target.critiqueIssueCodes = codes;
          target.lastCritiqueAt = now;
          target.notes = [
            target.notes,
            `Critique: ${card.issues
              .slice(0, 3)
              .map((i) => i.message)
              .join("; ")}`,
          ]
            .filter(Boolean)
            .join(" | ");
        }
        state.editPlan.updatedAt = now;
      }
      return { result: scorecardSummary(card), state };
    } catch (err: any) {
      const msg = err?.message || String(err);
      const chromiumish = /Executable doesn't exist|playwright install/i.test(
        msg
      );
      return {
        result: toolErr(`critique_preview failed — ${msg}`, {
          code: chromiumish ? "CHROMIUM_MISSING" : "CRITIQUE_FAILED",
          fixHint: chromiumish
            ? "From apps/api run: pnpm exec playwright install chromium"
            : "You can still use validate_timeline and inspect_timeline.",
        }),
        state,
      };
    }
  },
};
