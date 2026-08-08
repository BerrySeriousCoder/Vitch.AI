import { describe, expect, it, vi } from "vitest";
import { FrameCache } from "./frame-cache";

function bitmap(width: number, height: number) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

describe("FrameCache", () => {
  it("evicts by decoded byte size instead of retaining many 4K frames", () => {
    const cache = new FrameCache(60, 100);
    const first = bitmap(5, 5); // 100 bytes
    const second = bitmap(5, 5);
    cache.set("first", first);
    cache.set("second", second);
    expect(cache.get("first")).toBeUndefined();
    expect(first.close).toHaveBeenCalledOnce();
    expect(cache.get("second")).toBe(second);
  });

  it("closes a replaced bitmap and all retained resources on clear", () => {
    const cache = new FrameCache(2, 1_000);
    const first = bitmap(2, 2);
    const replacement = bitmap(2, 2);
    cache.set("frame", first);
    cache.set("frame", replacement);
    expect(first.close).toHaveBeenCalledOnce();
    cache.clear();
    expect(replacement.close).toHaveBeenCalledOnce();
  });
});
