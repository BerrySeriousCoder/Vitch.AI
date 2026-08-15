import type {
  EditPlan,
  EditPlanStep,
  EditPlanStepStatus,
  EditPlanShotCriteria,
  EditPlanStepToolHint,
} from "@tempo/types";
import { randomUUID } from "crypto";
import type { ProjectState } from "./project-state.js";

function parseStatus(raw: unknown): EditPlanStepStatus | null {
  const s = String(raw || "");
  if (
    s === "pending" ||
    s === "in_progress" ||
    s === "done" ||
    s === "failed"
  ) {
    return s;
  }
  return null;
}

function parseToolHints(raw: unknown): EditPlanStepToolHint[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: EditPlanStepToolHint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const tool = String((item as any).tool || "");
    if (!tool) continue;
    out.push({
      tool,
      argsSketch:
        (item as any).argsSketch && typeof (item as any).argsSketch === "object"
          ? ((item as any).argsSketch as Record<string, unknown>)
          : undefined,
    });
  }
  return out.length ? out : undefined;
}

function parseShotCriteria(raw: unknown): EditPlanShotCriteria | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const criteria: EditPlanShotCriteria = {};
  if (o.role != null) criteria.role = String(o.role);
  if (o.energy != null) criteria.energy = String(o.energy);
  if (o.query != null) criteria.query = String(o.query);
  if (Array.isArray(o.tags)) criteria.tags = o.tags.map(String);
  return Object.keys(criteria).length ? criteria : undefined;
}

export const planToolDefinitions = [
  {
    name: "create_edit_plan",
    description:
      "Create a structured edit plan (goal + ordered steps) before heavy timeline mutations. Steps may include toolHints, shotCriteria, durationSec, acceptance.",
    parameters: {
      type: "object" as const,
      properties: {
        goal: { type: "string" },
        durationSec: { type: "number" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              purpose: { type: "string" },
              notes: { type: "string" },
              durationSec: { type: "number" },
              toolHints: { type: "array", items: { type: "object" } },
              shotCriteria: { type: "object" },
              acceptance: { type: "string" },
            },
            required: ["purpose"],
          },
        },
      },
      required: ["goal", "steps"],
    },
  },
  {
    name: "get_edit_plan",
    description: "Return the current structured edit plan if any.",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    name: "execute_next_plan_step",
    description:
      "Pick the next pending plan step, mark it in_progress, and return its purpose, toolHints, shotCriteria, and acceptance. Then call the hinted tools (and select_shots_for_plan if needed), validate_timeline, then update_plan_step.",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    name: "update_plan_step",
    description:
      "Update a plan step status (pending|in_progress|done|failed) and optional notes. Use status=pending to reopen a failed step.",
    parameters: {
      type: "object" as const,
      properties: {
        stepId: { type: "string" },
        status: { type: "string" },
        notes: { type: "string" },
        critiqueIssueCodes: {
          type: "array",
          items: { type: "string" },
          description: "Optional issue codes from critique_preview",
        },
      },
      required: ["stepId", "status"],
    },
  },
  {
    name: "reopen_failed_plan_steps",
    description:
      "Set failed plan steps back to pending so execute_next_plan_step can continue the refine loop. Optional stepIds filter; default = all failed.",
    parameters: {
      type: "object" as const,
      properties: {
        stepIds: { type: "array", items: { type: "string" } },
      },
    },
  },
];

export const planToolExecutors: Record<
  string,
  (
    args: Record<string, any>,
    state: ProjectState
  ) => { result: string; state: ProjectState }
> = {
  create_edit_plan: (args, state) => {
    const stepsRaw = Array.isArray(args.steps) ? args.steps : [];
    if (!args.goal || stepsRaw.length === 0) {
      return { result: "Error: goal and non-empty steps required", state };
    }
    const steps: EditPlanStep[] = stepsRaw.map((s: any, i: number) => ({
      id: String(s.id || `step_${i + 1}_${randomUUID().slice(0, 6)}`),
      purpose: String(s.purpose || `Step ${i + 1}`),
      status: "pending" as const,
      notes: s.notes != null ? String(s.notes) : undefined,
      durationSec:
        s.durationSec != null && Number.isFinite(Number(s.durationSec))
          ? Number(s.durationSec)
          : undefined,
      toolHints: parseToolHints(s.toolHints),
      shotCriteria: parseShotCriteria(s.shotCriteria),
      acceptance: s.acceptance != null ? String(s.acceptance) : undefined,
    }));
    const plan: EditPlan = {
      goal: String(args.goal),
      durationSec:
        args.durationSec != null && Number.isFinite(Number(args.durationSec))
          ? Number(args.durationSec)
          : undefined,
      steps,
      updatedAt: new Date().toISOString(),
    };
    state.editPlan = plan;
    return {
      result: `Created edit plan (${steps.length} steps): ${plan.goal}\n${steps
        .map((s, i) => `${i + 1}. [${s.id}] ${s.purpose}`)
        .join("\n")}`,
      state,
    };
  },

  get_edit_plan: (_args, state) => {
    if (!state.editPlan) return { result: "No edit plan yet. Use create_edit_plan.", state };
    return { result: JSON.stringify(state.editPlan, null, 2), state };
  },

  execute_next_plan_step: (_args, state) => {
    if (!state.editPlan) return { result: "Error: no edit plan", state };
    const next =
      state.editPlan.steps.find((s) => s.status === "in_progress") ||
      state.editPlan.steps.find((s) => s.status === "pending");
    if (!next) {
      return {
        result: "All plan steps are done or failed. Use get_edit_plan.",
        state,
      };
    }
    next.status = "in_progress";
    state.editPlan.updatedAt = new Date().toISOString();
    return {
      result: JSON.stringify(
        {
          step: next,
          instruction:
            "Execute toolHints (and select_shots_for_plan if shotCriteria). Then validate_timeline / optional critique_preview, then update_plan_step done|failed.",
        },
        null,
        2
      ),
      state,
    };
  },

  update_plan_step: (args, state) => {
    if (!state.editPlan) return { result: "Error: no edit plan", state };
    const status = parseStatus(args.status);
    if (!status) {
      return {
        result: "Error: status must be pending|in_progress|done|failed",
        state,
      };
    }
    const step = state.editPlan.steps.find((s) => s.id === args.stepId);
    if (!step) return { result: `Error: step ${args.stepId} not found`, state };
    step.status = status;
    if (args.notes != null) step.notes = String(args.notes);
    if (Array.isArray(args.critiqueIssueCodes)) {
      step.critiqueIssueCodes = args.critiqueIssueCodes.map(String);
      step.lastCritiqueAt = new Date().toISOString();
    }
    state.editPlan.updatedAt = new Date().toISOString();
    const pending = state.editPlan.steps.filter((s) => s.status === "pending").length;
    const failed = state.editPlan.steps.filter((s) => s.status === "failed").length;
    return {
      result: `Step ${step.id} → ${status}. Remaining pending=${pending}, failed=${failed}`,
      state,
    };
  },

  reopen_failed_plan_steps: (args, state) => {
    if (!state.editPlan) return { result: "Error: no edit plan", state };
    const filter = Array.isArray(args.stepIds)
      ? new Set(args.stepIds.map(String))
      : null;
    const reopened: string[] = [];
    for (const step of state.editPlan.steps) {
      if (step.status !== "failed") continue;
      if (filter && !filter.has(step.id)) continue;
      step.status = "pending";
      step.notes = [step.notes, "Reopened for refine"]
        .filter(Boolean)
        .join(" | ");
      reopened.push(step.id);
    }
    state.editPlan.updatedAt = new Date().toISOString();
    if (reopened.length === 0) {
      return { result: "No failed steps to reopen", state };
    }
    return {
      result: `Reopened ${reopened.length} step(s) to pending: ${reopened.join(", ")}. Call execute_next_plan_step to continue.`,
      state,
    };
  },
};
