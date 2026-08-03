import { describe, expect, it } from "vitest";
import type { MotionGraph } from "@tempo/types";
import { evaluateMotionGraph, validateMotionGraph } from "./motion-graph";

describe("motion graph", () => {
  it("evaluates a sine output deterministically", () => {
    const graph: MotionGraph = { id: "float", name: "Float", nodes: [
      { id: "sine", type: "sine", params: { amplitude: 20, frequency: 1, offset: 3 } },
      { id: "out", type: "output", params: { property: "transform.y" } },
    ], edges: [{ id: "e", fromNodeId: "sine", fromPort: "value", toNodeId: "out", toPort: "value" }] };
    expect(validateMotionGraph(graph).ok).toBe(true);
    expect(evaluateMotionGraph(graph, 0)["transform.y"]).toBe(3);
    expect(evaluateMotionGraph(graph, 0.25)["transform.y"]).toBeCloseTo(23);
  });

  it("rejects feedback loops", () => {
    expect(validateMotionGraph({ id: "loop", name: "Loop", nodes: [
      { id: "a", type: "add", params: {} }, { id: "b", type: "add", params: {} },
    ], edges: [
      { id: "ab", fromNodeId: "a", fromPort: "value", toNodeId: "b", toPort: "value" },
      { id: "ba", fromNodeId: "b", fromPort: "value", toNodeId: "a", toPort: "value" },
    ] } as MotionGraph).ok).toBe(false);
  });
});
