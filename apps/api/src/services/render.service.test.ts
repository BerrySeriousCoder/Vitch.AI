import { beforeEach, describe, expect, it, vi } from "vitest";

const addMock = vi.fn();

vi.mock("../config/redis.js", () => ({
  getRedisConnection: vi.fn(() => ({})),
}));

vi.mock("bullmq", () => {
  class Queue {
    add = addMock;
    constructor(_name: string, _opts?: unknown) {}
  }
  return { Queue };
});

import { enqueueRenderJob, getRenderQueue, RENDER_QUEUE_NAME } from "./render.service.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Reset module-level queue cache by re-importing is hard; getRenderQueue creates once.
  addMock.mockResolvedValue({ id: "job-1" });
});

describe("render.service", () => {
  it("exposes queue name", () => {
    expect(RENDER_QUEUE_NAME).toBe("render-jobs");
  });

  it("creates a queue and enqueues jobs", async () => {
    const queue = getRenderQueue();
    expect(queue).toBeTruthy();

    const id = await enqueueRenderJob({
      projectId: "p1",
      userId: "u1",
      jobId: "job-1",
      settings: {
        format: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        width: 1920,
        height: 1080,
        fps: 30,
        videoBitrate: "5000k",
        audioBitrate: "192k",
        qualityPreset: "standard",
      },
    });

    expect(id).toBe("job-1");
    expect(addMock).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ projectId: "p1", jobId: "job-1" }),
      expect.objectContaining({ jobId: "job-1" })
    );
  });
});
