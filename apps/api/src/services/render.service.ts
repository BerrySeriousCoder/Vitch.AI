import { Queue } from "bullmq";
import { getRedisConnection } from "../config/redis.js";
import type { ExportSettings } from "@tempo/types";

export const RENDER_QUEUE_NAME = "render-jobs";

let _queue: Queue | null = null;

export function getRenderQueue(): Queue {
  if (!_queue) {
    _queue = new Queue(RENDER_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // A render is expensive and most failures (missing media, codec, GPU)
        // are deterministic. Let the user retry after the surfaced cause is fixed.
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    });
  }
  return _queue;
}

export interface RenderJobData {
  projectId: string;
  userId: string;
  jobId: string;
  settings: ExportSettings;
}

export async function enqueueRenderJob(data: RenderJobData): Promise<string> {
  const queue = getRenderQueue();
  const job = await queue.add("render", data, {
    jobId: data.jobId,
  });
  return job.id!;
}
