import { describe, expect, it } from "vitest";
import type { Clip, Track } from "@tempo/types";
import { planToolExecutors } from "./plan.tool.js";
import { critiqueToolExecutors } from "./critique.tool.js";
import { createProjectState } from "./index.js";

function clip(partial: Partial<Clip> & { id: string; trackId: string }): Clip {
  return {
    sourceMediaId: "m1",
    startTime: 0,
    duration: 5,
    sourceOffset: 0,
    speed: 1,
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    blendMode: "normal",
    effects: [],
    keyframes: [],
    mask: null,
    muted: false,
    volume: 1,
    ...partial,
  };
}

function track(id: string, clips: Clip[]): Track {
  return {
    id,
    name: id,
    type: "video",
    order: 0,
    locked: false,
    visible: true,
    solo: false,
    clips,
  };
}

describe("plan tools", () => {
  it("creates and updates plan steps", () => {
    const state = createProjectState([]);
    const created = planToolExecutors.create_edit_plan!(
      {
        goal: "Hook + CTA reel",
        steps: [{ purpose: "Lay bed" }, { purpose: "Add titles" }],
      },
      state
    );
    expect(created.result).toMatch(/Created edit plan/);
    expect(created.state.editPlan?.steps).toHaveLength(2);
    const stepId = created.state.editPlan!.steps[0]!.id;
    const updated = planToolExecutors.update_plan_step!(
      { stepId, status: "done" },
      created.state
    );
    expect(updated.result).toMatch(/done/);
    expect(updated.state.editPlan!.steps[0]!.status).toBe("done");
  });

  it("execute_next_plan_step marks in_progress", () => {
    const state = createProjectState([]);
    planToolExecutors.create_edit_plan!(
      {
        goal: "Test",
        steps: [
          {
            purpose: "Pick hook",
            shotCriteria: { role: "hook" },
            toolHints: [{ tool: "select_shots_for_plan" }],
          },
          { purpose: "Titles" },
        ],
      },
      state
    );
    const exec = planToolExecutors.execute_next_plan_step!({}, state);
    expect(exec.state.editPlan!.steps[0]!.status).toBe("in_progress");
    expect(exec.result).toMatch(/select_shots_for_plan/);
  });

  it("reopen_failed_plan_steps restores pending", () => {
    const state = createProjectState([]);
    planToolExecutors.create_edit_plan!(
      { goal: "Test", steps: [{ purpose: "A" }, { purpose: "B" }] },
      state
    );
    const a = state.editPlan!.steps[0]!.id;
    planToolExecutors.update_plan_step!({ stepId: a, status: "failed" }, state);
    const out = planToolExecutors.reopen_failed_plan_steps!({}, state);
    expect(out.result).toMatch(/Reopened/);
    expect(state.editPlan!.steps[0]!.status).toBe("pending");
  });
});

describe("validate_timeline", () => {
  it("flags unknown effects and overlaps", async () => {
    const state = createProjectState([
      track("t1", [
        clip({
          id: "a",
          trackId: "t1",
          startTime: 0,
          duration: 3,
          effects: [
            {
              id: "e1",
              type: "not-a-real-fx",
              name: "x",
              enabled: true,
              params: {},
              keyframes: [],
            },
          ],
        }),
        clip({ id: "b", trackId: "t1", startTime: 2, duration: 3 }),
      ]),
    ]);
    const out = await Promise.resolve(
      critiqueToolExecutors.validate_timeline!({}, state)
    );
    expect(out.result).toMatch(/unknown effect/);
    expect(out.result).toMatch(/overlap/);
  });
});
