import type {
  AgentRunEvent,
  AIMessage,
  AIMessagePart,
  AIToolCall,
  AIToolResult,
} from "@tempo/types";

function appendStreamTextPart(
  parts: AIMessagePart[],
  params: {
    type: "reasoning" | "reply";
    id: string;
    stepId: string;
    delta: string;
  }
): AIMessagePart[] {
  if (!params.delta) return parts;
  const next = [...parts];
  const index = next.findIndex(
    (part) => part.type === params.type && part.stepId === params.stepId
  );
  if (index >= 0) {
    const current = next[index] as Extract<AIMessagePart, { type: "reasoning" | "reply" }>;
    next[index] = { ...current, text: current.text + params.delta, status: "streaming" };
    return next;
  }
  next.push({
    type: params.type,
    id: params.id,
    stepId: params.stepId,
    text: params.delta,
    status: "streaming",
  });
  return next;
}

function completeStreamTextPart(
  parts: AIMessagePart[],
  type: "reasoning" | "reply",
  stepId: string
): AIMessagePart[] {
  return parts.map((part) =>
    part.type === type && part.stepId === stepId
      ? { ...part, status: "done" as const }
      : part
  );
}

/** Append or merge a text chunk into the ordered parts timeline. */
export function appendTextPart(
  parts: AIMessagePart[],
  text: string,
  makeId: () => string
): AIMessagePart[] {
  if (!text) return parts;
  const next = [...parts];
  const last = next[next.length - 1];
  if (last?.type === "text") {
    next[next.length - 1] = { ...last, text: last.text + text };
    return next;
  }
  next.push({ type: "text", id: makeId(), text });
  return next;
}

/** Push a running tool part. */
export function appendToolCallPart(
  parts: AIMessagePart[],
  tool: { id: string; stepId?: string; name: string; arguments: Record<string, unknown>; argumentsText?: string }
): AIMessagePart[] {
  return [
    ...parts,
    {
      type: "tool",
      id: tool.id,
      stepId: tool.stepId,
      name: tool.name,
      arguments: tool.arguments,
      argumentsText: tool.argumentsText,
      status: "running",
    },
  ];
}

/** Mark a tool part done (or error) with its result. */
export function completeToolPart(
  parts: AIMessagePart[],
  toolCallId: string,
  result: unknown,
  error?: string,
  metadata?: { durationMs?: number; mutating?: boolean }
): AIMessagePart[] {
  return parts.map((p) => {
    if (p.type !== "tool" || p.id !== toolCallId) return p;
    return {
      ...p,
      result,
      error,
      durationMs: metadata?.durationMs,
      mutating: metadata?.mutating,
      status: error ? ("error" as const) : ("done" as const),
    };
  });
}

/** Derive flat mirrors from ordered parts (for legacy consumers / persistence). */
export function mirrorsFromParts(parts: AIMessagePart[]): {
  content: string;
  toolCalls: AIToolCall[];
  toolResults: AIToolResult[];
} {
  const toolCalls: AIToolCall[] = [];
  const toolResults: AIToolResult[] = [];
  const textChunks: string[] = [];

  for (const p of parts) {
    if (p.type === "text" || p.type === "reply") {
      textChunks.push(p.text);
    } else if (p.type === "tool") {
      toolCalls.push({ id: p.id, name: p.name, arguments: p.arguments });
      if (p.status !== "running") {
        toolResults.push({
          toolCallId: p.id,
          name: p.name,
          result: p.result,
          error: p.error,
        });
      }
    }
  }

  return {
    content: textChunks.join(""),
    toolCalls,
    toolResults,
  };
}

/**
 * Ensure a message has ordered parts. Legacy messages (content + toolCalls only)
 * hydrate as text-then-tools — best-effort; new streams build parts live.
 */
export function ensureMessageParts(
  msg: AIMessage,
  makeId: () => string
): AIMessagePart[] {
  if (Array.isArray(msg.parts) && msg.parts.length > 0) {
    return msg.parts;
  }

  const parts: AIMessagePart[] = [];
  if (msg.content?.trim()) {
    parts.push({ type: "text", id: makeId(), text: msg.content });
  }

  const results = new Map(
    (msg.toolResults || []).map((tr) => [tr.toolCallId, tr])
  );
  for (const tc of msg.toolCalls || []) {
    const tr = results.get(tc.id);
    parts.push({
      type: "tool",
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      result: tr?.result,
      error: tr?.error,
      status: tr ? (tr.error ? "error" : "done") : "done",
    });
  }

  return parts;
}

/** Fold one wire event into persisted/renderable chronological transcript parts. */
export function applyAgentEventToParts(
  parts: AIMessagePart[],
  event: AgentRunEvent,
  makeId: () => string
): AIMessagePart[] {
  switch (event.event) {
    case "phase.started":
      return [...parts, { type: "phase", id: makeId(), phaseId: event.phaseId, title: event.title, detail: event.detail }];
    case "reasoning.started":
      return parts.some((part) => part.type === "reasoning" && part.stepId === event.stepId)
        ? parts
        : [...parts, { type: "reasoning", id: makeId(), stepId: event.stepId, text: "", status: "streaming" }];
    case "reasoning.delta":
      return appendStreamTextPart(parts, { type: "reasoning", id: makeId(), stepId: event.stepId, delta: event.delta });
    case "reasoning.completed":
      return completeStreamTextPart(parts, "reasoning", event.stepId);
    case "reply.started":
      return parts.some((part) => part.type === "reply" && part.stepId === event.stepId)
        ? parts
        : [...parts, { type: "reply", id: makeId(), stepId: event.stepId, text: "", status: "streaming" }];
    case "reply.delta":
      return appendStreamTextPart(parts, { type: "reply", id: makeId(), stepId: event.stepId, delta: event.delta });
    case "reply.completed":
      return completeStreamTextPart(parts, "reply", event.stepId);
    case "tool.call.started":
      return appendToolCallPart(parts, { id: event.toolCallId, stepId: event.stepId, name: event.name, arguments: {}, argumentsText: "" });
    case "tool.arguments.delta":
      return parts.map((part) =>
        part.type === "tool" && part.id === event.toolCallId
          ? { ...part, argumentsText: `${part.argumentsText || ""}${event.delta}` }
          : part
      );
    case "tool.call.ready":
      return parts.map((part) =>
        part.type === "tool" && part.id === event.toolCallId
          ? { ...part, name: event.name, arguments: event.arguments }
          : part
      );
    case "tool.result":
      return completeToolPart(parts, event.toolCallId, event.result, event.status === "error" ? String(event.result) : undefined, { durationMs: event.durationMs, mutating: event.mutating });
    default:
      return parts;
  }
}
