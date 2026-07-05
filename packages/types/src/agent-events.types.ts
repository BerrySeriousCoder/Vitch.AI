export interface AgentEventBase {
  protocolVersion: 1;
  event: string;
  runId: string;
  turnId: string;
  sequence: number;
  timestamp: string;
}

export type AgentRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "incomplete";

export type AgentRunEvent =
  | (AgentEventBase & {
      event: "run.started";
      model: string;
      provider: "gemini-interactions";
    })
  | (AgentEventBase & {
      event: "phase.started";
      phaseId: string;
      title: string;
      detail?: string;
    })
  | (AgentEventBase & {
      event: "reasoning.started";
      stepId: string;
    })
  | (AgentEventBase & {
      event: "reasoning.delta";
      stepId: string;
      delta: string;
    })
  | (AgentEventBase & {
      event: "reasoning.completed";
      stepId: string;
    })
  | (AgentEventBase & {
      event: "reply.started";
      stepId: string;
    })
  | (AgentEventBase & {
      event: "reply.delta";
      stepId: string;
      delta: string;
    })
  | (AgentEventBase & {
      event: "reply.completed";
      stepId: string;
    })
  | (AgentEventBase & {
      event: "tool.call.started";
      stepId: string;
      toolCallId: string;
      name: string;
    })
  | (AgentEventBase & {
      event: "tool.arguments.delta";
      stepId: string;
      toolCallId: string;
      delta: string;
    })
  | (AgentEventBase & {
      event: "tool.call.ready";
      stepId: string;
      toolCallId: string;
      name: string;
      arguments: Record<string, unknown>;
    })
  | (AgentEventBase & {
      event: "tool.result";
      stepId: string;
      toolCallId: string;
      name: string;
      status: "done" | "error";
      result: unknown;
      durationMs: number;
      mutating: boolean;
    })
  | (AgentEventBase & {
      event: "project.patch";
      revision: number;
      mode: "snapshot";
      affectedIds?: string[];
      project: Record<string, unknown>;
    })
  | (AgentEventBase & {
      event: "usage.updated";
      inputTokens?: number;
      outputTokens?: number;
      thoughtTokens?: number;
      totalTokens?: number;
    })
  | (AgentEventBase & {
      event: "run.completed";
      status: AgentRunStatus;
      interactionId?: string;
      incomplete?: boolean;
      resumeHint?: string;
      project: Record<string, unknown>;
    })
  | (AgentEventBase & {
      event: "run.failed";
      status: "failed";
      message: string;
      recoverable: boolean;
    })
  | (AgentEventBase & {
      event: "run.cancelled";
      status: "cancelled";
      interactionId?: string;
    });
