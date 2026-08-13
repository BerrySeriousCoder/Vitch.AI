"use client";

import { useProjectStore } from "@/stores/project.store";

export function EditPlanPanel() {
  const editPlan = useProjectStore((s) => s.editPlan);
  const setEditPlan = useProjectStore((s) => s.setEditPlan);

  if (!editPlan) {
    return null;
  }

  const failedCount = editPlan.steps.filter((s) => s.status === "failed").length;

  const reopenFailed = () => {
    setEditPlan({
      ...editPlan,
      updatedAt: new Date().toISOString(),
      steps: editPlan.steps.map((s) =>
        s.status === "failed"
          ? {
              ...s,
              status: "pending" as const,
              notes: [s.notes, "Reopened for refine"].filter(Boolean).join(" | "),
            }
          : s
      ),
    });
  };

  return (
    <details className="border-b border-[var(--border-default)]">
      <summary className="cursor-pointer list-none px-3 py-2 text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider hover:bg-[var(--bg-tertiary)]">
        Edit plan · {editPlan.steps.filter((step) => step.status === "done").length}/{editPlan.steps.length}
      </summary>
      <div className="px-3 pb-2 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider">
          Edit plan
        </div>
        {failedCount > 0 && (
          <button
            type="button"
            onClick={reopenFailed}
            className="text-[10px] text-amber-400 hover:text-amber-300"
          >
            Reopen {failedCount} failed
          </button>
        )}
      </div>
      <div className="text-xs text-[var(--text-primary)] font-medium leading-snug">
        {editPlan.goal}
      </div>
      <ul className="space-y-1">
        {editPlan.steps.map((step, i) => (
          <li
            key={step.id}
            className="flex items-start gap-2 text-[11px] text-[var(--text-secondary)]"
          >
            <span
              className={
                step.status === "done"
                  ? "text-emerald-500"
                  : step.status === "failed"
                    ? "text-red-400"
                    : step.status === "in_progress"
                      ? "text-amber-400"
                      : "text-[var(--text-muted)]"
              }
            >
              {step.status === "done"
                ? "✓"
                : step.status === "failed"
                  ? "!"
                  : step.status === "in_progress"
                    ? "…"
                    : `${i + 1}.`}
            </span>
            <div className="flex-1 min-w-0 leading-snug">
              <div>{step.purpose}</div>
              {step.status === "failed" && step.notes && (
                <div className="text-[10px] text-red-400/80 mt-0.5 truncate">
                  {step.notes}
                </div>
              )}
              {step.critiqueIssueCodes && step.critiqueIssueCodes.length > 0 && (
                <div className="text-[9px] font-mono text-[var(--text-muted)] mt-0.5">
                  {step.critiqueIssueCodes.join(", ")}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      </div>
    </details>
  );
}
