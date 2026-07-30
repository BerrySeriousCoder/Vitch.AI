import type { MotionGraph } from "@tempo/types";

export type MotionGraphValues = Partial<Record<"transform.x" | "transform.y" | "transform.scaleX" | "transform.scaleY" | "transform.rotation" | "opacity", number>>;

const OUTPUTS = new Set<keyof MotionGraphValues>([
  "transform.x", "transform.y", "transform.scaleX", "transform.scaleY", "transform.rotation", "opacity",
]);

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Reject dangling references and feedback loops before a graph reaches preview/export. */
export function validateMotionGraph(graph: MotionGraph | null | undefined): { ok: boolean; message?: string } {
  if (!graph?.id || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return { ok: false, message: "A motion graph needs an id and at least one node" };
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (ids.size !== graph.nodes.length || [...ids].some((id) => !id)) return { ok: false, message: "Motion graph node ids must be unique" };
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges || []) {
    if (!ids.has(edge.fromNodeId) || !ids.has(edge.toNodeId)) return { ok: false, message: "Motion graph edge references a missing node" };
    const list = incoming.get(edge.toNodeId) || [];
    list.push(edge.fromNodeId); incoming.set(edge.toNodeId, list);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const parent of incoming.get(id) || []) if (!visit(parent)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  if (![...ids].every(visit)) return { ok: false, message: "Motion graph cannot contain a cycle" };
  for (const node of graph.nodes) {
    if (node.type === "output" && !OUTPUTS.has(String(node.params.property) as keyof MotionGraphValues)) {
      return { ok: false, message: "Motion graph output property is unsupported" };
    }
  }
  return { ok: true };
}

/** Small deterministic graph runtime shared by preview and Chromium frame export. */
export function evaluateMotionGraph(graph: MotionGraph | null | undefined, time: number): MotionGraphValues {
  if (!validateMotionGraph(graph).ok || !graph) return {};
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = new Map<string, string[]>();
  for (const edge of graph.edges || []) edges.set(edge.toNodeId, [...(edges.get(edge.toNodeId) || []), edge.fromNodeId]);
  const memo = new Map<string, number>();
  const valueOf = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    const node = nodes.get(id); if (!node) return 0;
    const inputs = (edges.get(id) || []).map(valueOf);
    const p = node.params || {};
    let value = 0;
    switch (node.type) {
      case "time": value = time; break;
      case "constant": value = finite(p.value); break;
      case "sine": value = finite(p.offset) + finite(p.amplitude, 1) * Math.sin(Math.PI * 2 * finite(p.frequency, 1) * time + finite(p.phase)); break;
      case "add": value = inputs.reduce((sum, current) => sum + current, finite(p.value)); break;
      case "multiply": value = inputs.reduce((product, current) => product * current, finite(p.value, 1)); break;
      case "output": value = inputs[0] ?? finite(p.value); break;
      default: value = finite(p.value);
    }
    memo.set(id, value); return value;
  };
  const result: MotionGraphValues = {};
  for (const node of graph.nodes) {
    if (node.type !== "output") continue;
    const property = String(node.params.property) as keyof MotionGraphValues;
    if (OUTPUTS.has(property)) result[property] = valueOf(node.id);
  }
  return result;
}
