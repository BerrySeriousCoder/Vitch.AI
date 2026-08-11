/**
 * Applies full snapshots at a bounded UI cadence while always retaining the
 * newest state. Producers remain unthrottled; only expensive consumer sync is
 * coalesced. The first snapshot is immediate and `flush` is a terminal barrier.
 */
export class LatestSnapshotSynchronizer<T> {
  private pending: T | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastAppliedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly apply: (snapshot: T) => void,
    private readonly minimumIntervalMs = 200
  ) {}

  enqueue(snapshot: T): void {
    const now = Date.now();
    const elapsed = now - this.lastAppliedAt;
    if (!this.timer && elapsed >= this.minimumIntervalMs) {
      this.pending = undefined;
      this.lastAppliedAt = now;
      this.apply(snapshot);
      return;
    }

    this.pending = snapshot;
    if (this.timer) return;
    const delay = Math.max(0, this.minimumIntervalMs - Math.max(0, elapsed));
    this.timer = setTimeout(() => {
      this.timer = null;
      const latest = this.pending;
      this.pending = undefined;
      if (latest === undefined) return;
      this.lastAppliedAt = Date.now();
      this.apply(latest);
    }, delay);
  }

  /** Apply the newest pending snapshot immediately, e.g. at run completion. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const latest = this.pending;
    this.pending = undefined;
    if (latest === undefined) return;
    this.lastAppliedAt = Date.now();
    this.apply(latest);
  }

  /** Discard pending work, e.g. before rolling a failed run back. */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = undefined;
  }
}
