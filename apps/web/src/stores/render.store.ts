import { create } from "zustand";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import type { RenderJob, ExportSettings } from "@tempo/types";

interface RenderState {
  jobs: RenderJob[];
  activeJobId: string | null;
  isLoading: boolean;

  startRender: (projectId: string, settings: Partial<ExportSettings>) => Promise<void>;
  loadJobs: (projectId: string) => Promise<void>;
  updateJobProgress: (jobId: string, progress: number, status: string) => void;
  updateJobComplete: (jobId: string, outputUrl: string) => void;
  updateJobFailed: (jobId: string, error: string) => void;
  reset: () => void;
}

const renderPollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const LIVE_RENDER_STATUSES = new Set<RenderJob["status"]>([
  "queued",
  "processing",
  "encoding",
  "uploading",
]);

function upsertJob(jobs: RenderJob[], job: RenderJob): RenderJob[] {
  return jobs.some((candidate) => candidate.id === job.id)
    ? jobs.map((candidate) => (candidate.id === job.id ? job : candidate))
    : [job, ...jobs];
}

function stopPolling(jobId: string): void {
  const timer = renderPollTimers.get(jobId);
  if (timer) clearTimeout(timer);
  renderPollTimers.delete(jobId);
}

function pollRenderJob(projectId: string, jobId: string): void {
  stopPolling(jobId);
  let failures = 0;
  const tick = async () => {
    const res = await apiFetch<RenderJob>(`/api/projects/${projectId}/render/${jobId}`);
    if (res.success && res.data) {
      failures = 0;
      const job = res.data;
      useRenderStore.setState((state) => ({
        jobs: upsertJob(
          state.jobs,
          (() => {
            const current = state.jobs.find((candidate) => candidate.id === job.id);
            return current && LIVE_RENDER_STATUSES.has(current.status) && LIVE_RENDER_STATUSES.has(job.status)
              ? { ...job, progress: Math.max(current.progress, job.progress) }
              : job;
          })()
        ),
        activeJobId: LIVE_RENDER_STATUSES.has(job.status) ? job.id : state.activeJobId,
      }));
      if (!LIVE_RENDER_STATUSES.has(job.status)) {
        stopPolling(jobId);
        return;
      }
    } else {
      failures += 1;
      if (failures >= 10) {
        stopPolling(jobId);
        return;
      }
    }
    renderPollTimers.set(jobId, setTimeout(tick, 1_000));
  };
  renderPollTimers.set(jobId, setTimeout(tick, 500));
}

export const useRenderStore = create<RenderState>((set) => ({
  jobs: [],
  activeJobId: null,
  isLoading: false,

  startRender: async (projectId, settings) => {
    set({ isLoading: true });
    try {
      const res = await apiFetch<RenderJob>(`/api/projects/${projectId}/render`, {
        method: "POST",
        body: JSON.stringify(settings),
      });
      if (!res.success || !res.data) {
        throw new Error(res.error || "Failed to start render");
      }
      set((state) => ({
        jobs: upsertJob(state.jobs, res.data!),
        activeJobId: res.data!.id,
        isLoading: false,
      }));
      if (LIVE_RENDER_STATUSES.has(res.data.status)) {
        pollRenderJob(projectId, res.data.id);
      }
    } catch (err: unknown) {
      set({ isLoading: false });
      toast.error(err instanceof Error ? err.message : "Failed to start render");
    }
  },

  loadJobs: async (projectId) => {
    try {
      const res = await apiFetch<RenderJob[]>(`/api/projects/${projectId}/render`);
      if (!res.success || !res.data) return;
      set((state) => {
        const liveJob = res.data!.find((job) => LIVE_RENDER_STATUSES.has(job.status));
        if (liveJob) pollRenderJob(projectId, liveJob.id);
        return {
        jobs: res.data!,
        activeJobId: liveJob?.id || (state.activeJobId && res.data!.some((job) => job.id === state.activeJobId)
          ? state.activeJobId
          : res.data![0]?.id || null),
        };
      });
    } catch {
      // non-fatal
    }
  },

  updateJobProgress: (jobId, progress, status) =>
    set((state) => ({
      jobs: state.jobs.map((j) =>
        j.id === jobId
          ? { ...j, progress: Math.max(j.progress, progress), status: status as RenderJob["status"] }
          : j
      ),
    })),

  updateJobComplete: (jobId, outputUrl) => {
    stopPolling(jobId);
    set((state) => ({
      jobs: state.jobs.map((j) =>
        j.id === jobId
          ? { ...j, status: "completed" as const, progress: 100, outputUrl }
          : j
      ),
    }));
  },

  updateJobFailed: (jobId, error) => {
    stopPolling(jobId);
    set((state) => ({
      jobs: state.jobs.map((j) =>
        j.id === jobId
          ? { ...j, status: "failed" as const, error }
          : j
      ),
    }));
  },

  reset: () => {
    for (const jobId of renderPollTimers.keys()) stopPolling(jobId);
    set({ jobs: [], activeJobId: null, isLoading: false });
  },
}));
