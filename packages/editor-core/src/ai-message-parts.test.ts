import { describe, expect, it } from "vitest";
import {
  appendTextPart,
  appendToolCallPart,
  applyAgentEventToParts,
  completeToolPart,
  ensureMessageParts,
  mirrorsFromParts,
} from "./ai-message-parts";
import type {
  AgentRunEvent,
  AIMessage,
  AIMessagePart,
} from "@tempo/types";

describe("AI message parts timeline", () => {
  let n = 0;
  const id = () => `id-${++n}`;

  it("interleaves text and tools in arrival order", () => {
    n = 0;
    let parts: AIMessagePart[] = [];
    parts = appendTextPart(parts, "Plan: add title.", id);
    parts = appendToolCallPart(parts, {
      id: "tc-1",
      name: "add_text_clip",
      arguments: { text: "Hi" },
    });
    parts = completeToolPart(parts, "tc-1", "ok");
    parts = appendTextPart(parts, "Done.", id);

    expect(parts.map((p) => p.type)).toEqual(["text", "tool", "text"]);
    expect(parts[0]).toMatchObject({ type: "text", text: "Plan: add title." });
    expect(parts[1]).toMatchObject({
      type: "tool",
      name: "add_text_clip",
      status: "done",
      result: "ok",
    });
    expect(parts[2]).toMatchObject({ type: "text", text: "Done." });

    const mirrors = mirrorsFromParts(parts);
    expect(mirrors.content).toBe("Plan: add title.Done.");
    expect(mirrors.toolCalls).toHaveLength(1);
    expect(mirrors.toolResults).toHaveLength(1);
  });

  it("merges contiguous text chunks", () => {
    n = 0;
    let parts: AIMessagePart[] = [];
    parts = appendTextPart(parts, "Hello ", id);
    parts = appendTextPart(parts, "world", id);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "text", text: "Hello world" });
  });

  it("hydrates legacy messages without parts", () => {
    n = 0;
    const msg: AIMessage = {
      id: "m1",
      role: "assistant",
      content: "All done",
      toolCalls: [{ id: "tc-1", name: "inspect_timeline", arguments: {} }],
      toolResults: [
        { toolCallId: "tc-1", name: "inspect_timeline", result: "ok" },
      ],
      timestamp: new Date().toISOString(),
    };
    const parts = ensureMessageParts(msg, id);
    expect(parts.map((p) => p.type)).toEqual(["text", "tool"]);
  });
});

describe("typed agent run events", () => {
  const base = {
    protocolVersion: 1,
    runId: "run-1",
    turnId: "turn-1",
    sequence: 1,
    timestamp: "2026-08-11T00:00:00.000Z",
  } as const;
  let partId = 0;
  const makeId = () => `part-${++partId}`;

  it("keeps reasoning, tools, and replies distinct in chronological order", () => {
    const events: AgentRunEvent[] = [
      { ...base, event: "reasoning.started", stepId: "thought-1" },
      { ...base, sequence: 2, event: "reasoning.delta", stepId: "thought-1", delta: "Checking format." },
      { ...base, sequence: 3, event: "reasoning.completed", stepId: "thought-1" },
      { ...base, sequence: 4, event: "tool.call.started", stepId: "tool-step", toolCallId: "call-1", name: "inspect_timeline" },
      { ...base, sequence: 5, event: "tool.call.ready", stepId: "tool-step", toolCallId: "call-1", name: "inspect_timeline", arguments: {} },
      { ...base, sequence: 6, event: "tool.result", stepId: "tool-step", toolCallId: "call-1", name: "inspect_timeline", status: "done", result: "OK", durationMs: 4, mutating: false },
      { ...base, sequence: 7, event: "reply.started", stepId: "reply-1" },
      { ...base, sequence: 8, event: "reply.delta", stepId: "reply-1", delta: "Finished." },
      { ...base, sequence: 9, event: "reply.completed", stepId: "reply-1" },
    ];
    const parts = events.reduce(
      (current, event) => applyAgentEventToParts(current, event, makeId),
      [] as AIMessagePart[]
    );
    expect(parts.map((part) => part.type)).toEqual(["reasoning", "tool", "reply"]);
    expect(mirrorsFromParts(parts).content).toBe("Finished.");
    expect(parts[0]).toMatchObject({ type: "reasoning", status: "done" });
  });
});
