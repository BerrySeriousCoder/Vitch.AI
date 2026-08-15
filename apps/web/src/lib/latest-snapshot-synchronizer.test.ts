import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LatestSnapshotSynchronizer } from "./latest-snapshot-synchronizer";

describe("LatestSnapshotSynchronizer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T00:00:00.000Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("applies the first snapshot immediately and coalesces a burst to the latest", async () => {
    const apply = vi.fn();
    const sync = new LatestSnapshotSynchronizer<number>(apply, 200);
    sync.enqueue(1);
    sync.enqueue(2);
    sync.enqueue(3);
    expect(apply.mock.calls).toEqual([[1]]);

    await vi.advanceTimersByTimeAsync(200);
    expect(apply.mock.calls).toEqual([[1], [3]]);
  });

  it("flushes terminal state and can discard a failed run", () => {
    const apply = vi.fn();
    const sync = new LatestSnapshotSynchronizer<number>(apply, 200);
    sync.enqueue(1);
    sync.enqueue(2);
    sync.flush();
    expect(apply.mock.calls).toEqual([[1], [2]]);
    sync.enqueue(3);
    sync.clear();
    vi.runAllTimers();
    expect(apply.mock.calls).toEqual([[1], [2]]);
  });
});
