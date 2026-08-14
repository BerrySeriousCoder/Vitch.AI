import { describe, expect, it } from "vitest";
import { markerToolExecutors } from "./markers.tool.js";

describe("marker tools", () => {
  it("creates sorted persistent markers and validates their data", () => {
    const state: any = { tracks: [], audioMixer: {} };
    markerToolExecutors.add_marker!({ time: 8.1239, label: "Chapter two", type: "chapter" }, state);
    markerToolExecutors.add_marker!({ time: 2, label: "Hook" }, state);
    expect(state.markers.map((marker: any) => marker.time)).toEqual([2, 8.124]);
    expect(state.markers[0].type).toBe("comment");
    expect(markerToolExecutors.add_marker!({ time: -1, label: "No" }, state).result).toMatch(/^Error/);
  });

  it("updates and removes a marker", () => {
    const state: any = { tracks: [], audioMixer: {}, markers: [{ id: "m1", time: 1, label: "Old", color: "#f59e0b", type: "comment" }] };
    markerToolExecutors.update_marker!({ markerId: "m1", time: 3, label: "New", color: "#22c55e", type: "todo" }, state);
    expect(state.markers[0]).toMatchObject({ time: 3, label: "New", color: "#22c55e", type: "todo" });
    expect(markerToolExecutors.remove_marker!({ markerId: "m1" }, state).result).toContain('"ok":true');
    expect(state.markers).toHaveLength(0);
  });
});
