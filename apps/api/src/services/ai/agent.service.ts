import { GoogleGenAI, type Content } from "@google/genai";
import { randomUUID } from "crypto";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { buildSystemPrompt } from "./prompts/creative-director.prompt.js";
import {
  getToolDefinitions,
  getToolExecutor,
  createProjectState,
  MUTATING_TOOL_NAMES,
  type ProjectState,
} from "./tools/index.js";
import type { AgentRunEvent, Track, MediaAsset, AudioMixer, EditBlueprint, AIMessage, StyleDNA, Camera3D, Light3D } from "@tempo/types";

export type SSEEvent = AgentRunEvent;

interface ProjectContext {
  id: string;
  name: string;
  settings: Record<string, any>;
  tracks: Track[];
  transitions?: import("@tempo/types").Transition[];
  sequences?: import("@tempo/types").Sequence[];
  cameras?: Camera3D[];
  lights?: Light3D[];
  markers?: import("@tempo/types").TimelineMarker[];
  brandKit?: import("@tempo/types").BrandKit | null;
  graphicTemplates?: import("@tempo/types").GraphicTemplate[];
  audioMixer?: AudioMixer;
  editBlueprint?: EditBlueprint | null;
  styleDna?: StyleDNA | null;
  editPlan?: import("@tempo/types").EditPlan | null;
  styleDnaLibrary?: ProjectState["styleDnaLibrary"];
  previousInteractionId?: string | null;
}

/** Safety ceiling only — prevents infinite loops on bugs, not a creative edit budget. */
export const SAFETY_MAX_ITERATIONS = 200;
export const INTERACTION_INACTIVITY_TIMEOUT_MS = 120_000;
const OBSERVE_NUDGE_EVERY = 5;
// A successful mutating tool is a durability/UI boundary. Emitting immediately
// means Stop can preserve every completed edit even if the next model call is
// cancelled before another batch checkpoint.
const PROJECT_UPDATE_EVERY = 1;

function toInteractionTools() {
  return getToolDefinitions().map((def) => ({
    type: "function" as const,
    name: def.name,
    description: def.description,
    parameters: def.parameters as any,
  }));
}

function beatTimesFromBlueprint(blueprint: EditBlueprint | null | undefined): number[] | undefined {
  const beats = blueprint?.audioAnalysis?.beats;
  if (!beats?.length) return undefined;
  return beats.map((b) => b.time).filter((t) => Number.isFinite(t));
}

/** Prefer Edit Like This blueprint; else first audio (then video) with persisted audioRhythm. */
function beatTimesFromMedia(assets: MediaAsset[]): number[] | undefined {
  const withRhythm = assets.filter((a) => (a.metadata?.audioRhythm?.beats?.length || 0) > 0);
  if (withRhythm.length === 0) return undefined;
  withRhythm.sort((a, b) => {
    const rank = (x: MediaAsset) => (x.type === "audio" ? 0 : x.type === "video" ? 1 : 2);
    return rank(a) - rank(b);
  });
  const beats = withRhythm[0]!.metadata!.audioRhythm!.beats;
  return beats.map((b) => b.time).filter((t) => Number.isFinite(t));
}

function projectSnapshot(state: ProjectState): Record<string, unknown> {
  return {
    settings: state.settings,
    tracks: state.tracks,
    audioMixer: state.audioMixer,
    transitions: state.transitions || [],
    sequences: state.sequences || [],
    cameras: state.cameras || [],
    lights: state.lights || [],
    markers: state.markers || [],
    brandKit: state.brandKit || null,
    graphicTemplates: state.graphicTemplates || [],
    styleDna: state.styleDna || null,
    editPlan: state.editPlan || null,
    styleDnaLibrary: state.styleDnaLibrary || [],
  };
}

function eventText(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const value = content as Record<string, unknown>;
  return value.type === "text" && typeof value.text === "string" ? value.text : "";
}

function parseArguments(text: string, fallback: Record<string, unknown>) {
  if (!text.trim()) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fallback;
  } catch {
    return fallback;
  }
}

function toolFailed(result: string): boolean {
  if (/^Error\b/i.test(result)) return true;
  try {
    const parsed = JSON.parse(result) as { ok?: boolean };
    return parsed?.ok === false;
  } catch {
    return false;
  }
}

function staleInteractionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /previous[_ ]interaction|interaction.*(?:not found|expired|invalid)|(?:not found|expired|invalid).*interaction|\b404\b/i.test(message);
}

function interactionAbortScope(parent?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = () => controller.abort(parent?.reason);
  const arm = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Agent interaction became inactive", "TimeoutError"));
    }, INTERACTION_INACTIVITY_TIMEOUT_MS);
    timeout.unref?.();
  };
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  arm();
  return {
    signal: controller.signal,
    reset: arm,
    timedOut: () => timedOut,
    dispose: () => {
      if (timeout) clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function phaseForTool(name: string): { id: string; title: string } {
  if (/plan|style_dna|rank_shots|select_shots/.test(name)) return { id: "planning", title: "Planning the edit" };
  if (/media|shot|transcript|audio_timeline/.test(name)) return { id: "understanding", title: "Understanding the footage" };
  if (/caption|text|shape|graphic|font|preset/.test(name)) return { id: "graphics", title: "Designing graphics and captions" };
  if (/audio|volume|duck|eq|music|master/.test(name)) return { id: "audio", title: "Mixing audio" };
  if (/critique|validate|inspect|summary/.test(name)) return { id: "quality", title: "Checking the edit" };
  if (/effect|color|lut|chroma|mask|crop|motion|transition/.test(name)) return { id: "finishing", title: "Styling and finishing" };
  return { id: "assembly", title: "Building the timeline" };
}

function conversationFallback(history: Content[], current: string): string {
  if (history.length === 0) return current;
  const prior = history
    .slice(-16)
    .map((entry) => {
      const text = (entry.parts || []).map((part) => part.text || "").join("").trim();
      return text ? `${entry.role === "model" ? "Assistant" : "User"}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
  return `${prior ? `Previous conversation:\n${prior}\n\n` : ""}Current user request:\n${current}`;
}

interface AgentLoopOptions {
  signal?: AbortSignal;
  runId?: string;
  turnId?: string;
}

/**
 * Run the agentic loop: plan → act → observe → correct until text-only reply
 * or safety cap. Yields SSE events for live streaming.
 */
export async function* runAgentLoop(
  project: ProjectContext,
  mediaAssets: MediaAsset[],
  userMessage: string,
  conversationHistory: Content[],
  options: AgentLoopOptions = {}
): AsyncGenerator<SSEEvent> {
  const runId = options.runId || `run-${randomUUID()}`;
  const turnId = options.turnId || `turn-${randomUUID()}`;
  let sequence = 0;
  let revision = 0;
  const model = "gemini-3.1-pro-preview";
  const makeEvent = (event: AgentRunEvent["event"], payload: Record<string, unknown> = {}): AgentRunEvent => ({
    protocolVersion: 1,
    event,
    runId,
    turnId,
    sequence: ++sequence,
    timestamp: new Date().toISOString(),
    ...payload,
  } as AgentRunEvent);

  if (!env.GEMINI_API_KEY) {
    yield makeEvent("run.failed", { status: "failed", message: "GEMINI_API_KEY is not configured", recoverable: false });
    return;
  }

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const systemPrompt = buildSystemPrompt(
    { id: project.id, name: project.name, settings: project.settings as any, tracks: project.tracks },
    mediaAssets
  );

  const tools = toInteractionTools();
  const blueprint = project.editBlueprint ?? null;
  const state = createProjectState(project.tracks, project.audioMixer, {
    beatTimes: beatTimesFromBlueprint(blueprint) ?? beatTimesFromMedia(mediaAssets),
    editBlueprint: blueprint,
    styleDna: project.styleDna ?? null,
    mediaAssets,
    projectId: project.id,
    transitions: project.transitions || [],
    sequences: project.sequences || [],
    cameras: project.cameras || [],
    lights: project.lights || [],
    editPlan: project.editPlan ?? null,
    styleDnaLibrary: project.styleDnaLibrary ?? [],
    markers: project.markers ?? [],
    brandKit: project.brandKit ?? null,
    graphicTemplates: project.graphicTemplates ?? [],
    settings: project.settings as import("@tempo/types").ProjectSettings,
  });

  let mutationsSinceInspect = 0;
  let mutationsSinceUpdate = 0;
  let hitSafetyCap = false;
  let currentInteractionId = project.previousInteractionId || undefined;
  let lastResumableInteractionId = project.previousInteractionId || undefined;
  let canFallbackFromStoredInteraction = Boolean(project.previousInteractionId);
  let input: unknown = project.previousInteractionId
    ? userMessage
    : conversationFallback(conversationHistory, userMessage);
  let activePhaseId = "";

  yield makeEvent("run.started", { model, provider: "gemini-interactions" });

  for (let iteration = 0; iteration < SAFETY_MAX_ITERATIONS; iteration++) {
    if (options.signal?.aborted) {
      if (currentInteractionId) void ai.interactions.cancel(currentInteractionId).catch(() => undefined);
      yield makeEvent("project.patch", { revision: ++revision, mode: "snapshot", project: projectSnapshot(state) });
      yield makeEvent("run.cancelled", { status: "cancelled", interactionId: lastResumableInteractionId });
      return;
    }

    const pendingCalls = new Map<string, {
      stepId: string;
      name: string;
      initialArguments: Record<string, unknown>;
      argumentsText: string;
    }>();
    const stepKinds = new Map<number, { kind: "reasoning" | "reply" | "tool"; stepId: string }>();
    let usageEmitted = "";
    const interactionAbort = interactionAbortScope(options.signal);
    try {
      const stream = await ai.interactions.create(
        {
          model,
          stream: true,
          store: true,
          system_instruction: systemPrompt,
          tools,
          input: input as any,
          previous_interaction_id: currentInteractionId,
          generation_config: {
            thinking_level: "high",
            thinking_summaries: "auto",
          },
        },
        { signal: interactionAbort.signal }
      );

      for await (const interactionEvent of stream) {
        interactionAbort.reset();
        if (options.signal?.aborted) throw new DOMException("Agent run cancelled", "AbortError");

        if (interactionEvent.event_type === "interaction.created" || interactionEvent.event_type === "interaction.completed") {
          currentInteractionId = interactionEvent.interaction.id || currentInteractionId;
          if (interactionEvent.event_type === "interaction.completed") {
            lastResumableInteractionId = interactionEvent.interaction.id || lastResumableInteractionId;
          }
          const completedSteps = interactionEvent.interaction.steps || [];
          for (let index = 0; index < completedSteps.length; index++) {
            const step = completedSteps[index] as any;
            if (step?.type !== "function_call" || pendingCalls.has(step.id)) continue;
            const stepId = `tool-${step.id}`;
            pendingCalls.set(step.id, { stepId, name: step.name, initialArguments: step.arguments || {}, argumentsText: "" });
            stepKinds.set(index, { kind: "tool", stepId });
            yield makeEvent("tool.call.started", { stepId, toolCallId: step.id, name: step.name });
          }
        }

        if (interactionEvent.event_type === "step.start") {
          const step = interactionEvent.step as any;
          if (step.type === "thought") {
            const stepId = `thought-${iteration}-${interactionEvent.index}`;
            stepKinds.set(interactionEvent.index, { kind: "reasoning", stepId });
            yield makeEvent("reasoning.started", { stepId });
            for (const content of step.summary || []) {
              const delta = eventText(content);
              if (delta) yield makeEvent("reasoning.delta", { stepId, delta });
            }
          } else if (step.type === "model_output") {
            const stepId = `reply-${iteration}-${interactionEvent.index}`;
            stepKinds.set(interactionEvent.index, { kind: "reply", stepId });
            yield makeEvent("reply.started", { stepId });
            for (const content of step.content || []) {
              const delta = eventText(content);
              if (delta) yield makeEvent("reply.delta", { stepId, delta });
            }
          } else if (step.type === "function_call") {
            const stepId = `tool-${step.id}`;
            stepKinds.set(interactionEvent.index, { kind: "tool", stepId });
            pendingCalls.set(step.id, { stepId, name: step.name, initialArguments: step.arguments || {}, argumentsText: "" });
            yield makeEvent("tool.call.started", { stepId, toolCallId: step.id, name: step.name });
          }
        } else if (interactionEvent.event_type === "step.delta") {
          const kind = stepKinds.get(interactionEvent.index);
          const delta = interactionEvent.delta as any;
          if (delta.type === "thought_summary" && kind?.kind === "reasoning") {
            const text = eventText(delta.content);
            if (text) yield makeEvent("reasoning.delta", { stepId: kind.stepId, delta: text });
          } else if (delta.type === "text" && kind?.kind === "reply" && typeof delta.text === "string") {
            yield makeEvent("reply.delta", { stepId: kind.stepId, delta: delta.text });
          } else if (delta.type === "arguments_delta" && kind?.kind === "tool") {
            const call = [...pendingCalls.entries()].find(([, value]) => value.stepId === kind.stepId);
            if (call && typeof delta.arguments === "string") {
              call[1].argumentsText += delta.arguments;
              yield makeEvent("tool.arguments.delta", { stepId: kind.stepId, toolCallId: call[0], delta: delta.arguments });
            }
          }

          const usage = interactionEvent.metadata?.total_usage as any;
          if (usage) {
            const key = JSON.stringify(usage);
            if (key !== usageEmitted) {
              usageEmitted = key;
              yield makeEvent("usage.updated", {
                inputTokens: usage.total_input_tokens,
                outputTokens: usage.total_output_tokens,
                thoughtTokens: usage.total_thought_tokens,
                totalTokens: usage.total_tokens,
              });
            }
          }
        } else if (interactionEvent.event_type === "step.stop") {
          const kind = stepKinds.get(interactionEvent.index);
          if (kind?.kind === "reasoning") yield makeEvent("reasoning.completed", { stepId: kind.stepId });
          if (kind?.kind === "reply") yield makeEvent("reply.completed", { stepId: kind.stepId });
        } else if (interactionEvent.event_type === "error") {
          const message = (interactionEvent.error as any)?.message || "Gemini interaction failed";
          throw new Error(message);
        }
      }
    } catch (err: any) {
      if (interactionAbort.timedOut()) {
        logger.warn(
          { interactionId: currentInteractionId, iteration },
          "Gemini interaction exceeded inactivity deadline"
        );
        yield makeEvent("project.patch", { revision: ++revision, mode: "snapshot", project: projectSnapshot(state) });
        yield makeEvent("run.failed", {
          status: "failed",
          message: "Creative polish timed out waiting for the model",
          recoverable: true,
        });
        return;
      }
      if (err?.name === "AbortError" || options.signal?.aborted) {
        if (currentInteractionId) void ai.interactions.cancel(currentInteractionId).catch(() => undefined);
        yield makeEvent("project.patch", { revision: ++revision, mode: "snapshot", project: projectSnapshot(state) });
        yield makeEvent("run.cancelled", { status: "cancelled", interactionId: lastResumableInteractionId });
        return;
      }
      if (
        iteration === 0 &&
        pendingCalls.size === 0 &&
        canFallbackFromStoredInteraction &&
        staleInteractionError(err)
      ) {
        logger.warn(
          { interactionId: currentInteractionId, err: err?.message },
          "Stored Gemini interaction is unavailable; retrying from persisted conversation"
        );
        canFallbackFromStoredInteraction = false;
        currentInteractionId = undefined;
        lastResumableInteractionId = undefined;
        input = conversationFallback(conversationHistory, userMessage);
        continue;
      }
      logger.error({ err: err.message }, "Gemini API error");
      yield makeEvent("project.patch", { revision: ++revision, mode: "snapshot", project: projectSnapshot(state) });
      yield makeEvent("run.failed", { status: "failed", message: `Gemini API error: ${err.message}`, recoverable: true });
      return;
    } finally {
      interactionAbort.dispose();
    }

    if (pendingCalls.size === 0) {
      break;
    }

    if (iteration === SAFETY_MAX_ITERATIONS - 1) {
      hitSafetyCap = true;
    }

    const functionResults: Array<Record<string, unknown>> = [];

    for (const [toolId, call] of pendingCalls) {
      const toolName = call.name;
      const toolArgs = parseArguments(call.argumentsText, call.initialArguments) as Record<string, any>;
      const phase = phaseForTool(toolName);
      if (phase.id !== activePhaseId) {
        activePhaseId = phase.id;
        yield makeEvent("phase.started", { phaseId: phase.id, title: phase.title });
      }
      yield makeEvent("tool.call.ready", { stepId: call.stepId, toolCallId: toolId, name: toolName, arguments: toolArgs });

      const executor = getToolExecutor(toolName);
      let resultText: string;
      const startedAt = Date.now();

      if (executor) {
        try {
          const execResult = await Promise.resolve(executor(toolArgs, state));
          resultText = execResult.result;
        } catch (err: any) {
          resultText = `Error executing ${toolName}: ${err.message}`;
        }
      } else {
        resultText = `Error: Unknown tool "${toolName}"`;
      }

      const failed = toolFailed(resultText);
      yield makeEvent("tool.result", {
        stepId: call.stepId,
        toolCallId: toolId,
        name: toolName,
        status: failed ? "error" : "done",
        result: resultText,
        durationMs: Date.now() - startedAt,
        mutating: MUTATING_TOOL_NAMES.has(toolName),
      });

      if (
        toolName === "inspect_timeline" ||
        toolName === "get_project_summary" ||
        toolName === "validate_timeline" ||
        toolName === "critique_preview" ||
        toolName === "compare_reference_to_edit"
      ) {
        mutationsSinceInspect = 0;
      } else if (MUTATING_TOOL_NAMES.has(toolName)) {
        mutationsSinceInspect++;
        mutationsSinceUpdate++;
      }

      if (mutationsSinceUpdate >= PROJECT_UPDATE_EVERY) {
        yield makeEvent("project.patch", { revision: ++revision, mode: "snapshot", project: projectSnapshot(state) });
        mutationsSinceUpdate = 0;
      }

      functionResults.push({
        type: "function_result",
        call_id: toolId,
        name: toolName,
        result: resultText,
        is_error: failed,
      });
    }

    input = functionResults;

    if (mutationsSinceInspect >= OBSERVE_NUDGE_EVERY && !hitSafetyCap) {
      input = [
        ...functionResults,
        {
          type: "user_input",
          content: [{ type: "text", text: "[Harness] You have made several edits without observing. Call inspect_timeline now, fix any issues, then continue. Do not claim the edit is finished until you have inspected." }],
        },
      ];
      mutationsSinceInspect = 0;
    }

    if (hitSafetyCap) {
      break;
    }
  }

  yield makeEvent("project.patch", { revision: ++revision, mode: "snapshot", project: projectSnapshot(state) });
  yield makeEvent("run.completed", {
    status: hitSafetyCap ? "incomplete" : "completed",
    interactionId: lastResumableInteractionId ?? currentInteractionId,
    incomplete: hitSafetyCap,
    resumeHint: hitSafetyCap ? 'Say "continue" to resume.' : undefined,
    project: projectSnapshot(state),
  });
}

export function serializeConversation(contents: Content[]): Content[] {
  return JSON.parse(JSON.stringify(contents));
}

/** Build a UI transcript turn for persistence (server-side). */
export function buildAssistantAIMessage(params: {
  content: string;
  parts?: AIMessage["parts"];
  toolCalls: AIMessage["toolCalls"];
  toolResults: AIMessage["toolResults"];
}): Omit<AIMessage, "id"> {
  return {
    role: "assistant",
    content: params.content,
    parts: params.parts,
    toolCalls: params.toolCalls,
    toolResults: params.toolResults,
    timestamp: new Date().toISOString(),
  };
}
