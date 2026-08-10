import { create } from "zustand";
import { toast } from "sonner";
import { streamAIChat, streamEditLikeThis } from "@/lib/ai-client";
import { useProjectStore } from "./project.store";
import { useTimelineStore } from "./timeline.store";
import { useSequenceStore } from "./sequence.store";
import { usePlaybackStore } from "./playback.store";
import { useMediaStore } from "./media.store";
import type {
  AIMessage,
  AIMessagePart,
  EditBlueprint,
  AudioMixer,
  StyleDNA,
  EditPlan,
  Sequence,
  Track,
  Transition,
  Camera3D,
  Light3D,
  TimelineMarker,
  BrandKit,
  GraphicTemplate,
  AgentRunEvent,
  EditLikeThisAudioPolicy,
  MediaAsset,
} from "@tempo/types";
import {
  appendTextPart,
  applyAgentEventToParts,
  ensureMessageParts,
  mirrorsFromParts,
} from "@tempo/editor-core";
import { apiFetch } from "@/lib/api-client";
import { LatestSnapshotSynchronizer } from "@/lib/latest-snapshot-synchronizer";

export type EditLikeThisStep =
  | "idle"
  | "downloading"
  | "analyzing_scenes"
  | "analyzing_audio"
  | "importing_audio"
  | "analyzing_visuals"
  | "generating_blueprint"
  | "style_dna"
  | "matching_assets"
  | "recreating"
  | "complete"
  | "error";

export interface AssetMappingPreview {
  segmentIndex: number;
  assetId: string;
  assetName: string;
  inPoint: number;
  duration: number;
  confidence: number;
  shotId?: string;
  role?: string;
}

interface AIState {
  messages: AIMessage[];
  isStreaming: boolean;
  activeToolCall: { id?: string; name: string; args: Record<string, unknown> } | null;
  activeRunId: string | null;
  currentPhase: string | null;
  runUsage: { inputTokens?: number; outputTokens?: number; thoughtTokens?: number; totalTokens?: number } | null;

  // Edit Like This
  editLikeThisStep: EditLikeThisStep;
  editLikeThisDetail: string;
  blueprint: EditBlueprint | null;
  styleDna: StyleDNA | null;
  assetMappings: AssetMappingPreview[];
  isEditLikeThisRunning: boolean;
  editLikeThisQuality: "polished" | "draft" | null;
  editLikeThisWarnings: string[];

  sendMessage: (message: string) => Promise<void>;
  cancelRun: () => void;
  runEditLikeThis: (url: string, audioPolicy: EditLikeThisAudioPolicy) => Promise<void>;
  clearEditLikeThis: () => void;
  loadConversation: (projectId: string) => Promise<void>;
  reset: () => void;
}

let messageCounter = 0;
let activeAgentController: AbortController | null = null;
let activeEditLikeThisController: AbortController | null = null;
function nextId() {
  return `ai-msg-${Date.now()}-${++messageCounter}`;
}

function patchAssistant(
  messages: AIMessage[],
  assistantMsgId: string,
  patch: Partial<AIMessage>
): AIMessage[] {
  return messages.map((m) => (m.id === assistantMsgId ? { ...m, ...patch } : m));
}

interface StyleDnaLibraryEntry {
  id: string;
  name: string;
  dna: StyleDNA;
  createdAt: string;
}

type LegacyConversationEntry = { role: string; parts?: Array<{ text?: string }> };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function applyAgentSurfaceUpdate(data: Record<string, unknown>): void {
  useSequenceStore.getState().applyAgentProjectUpdate({
    tracks: Array.isArray(data.tracks) ? data.tracks as Track[] : undefined,
    transitions: Array.isArray(data.transitions) ? data.transitions as Transition[] : undefined,
    sequences: Array.isArray(data.sequences) ? data.sequences as Sequence[] : undefined,
  });
  const settings = data.settings && typeof data.settings === "object"
    ? data.settings as import("@tempo/types").ProjectSettings
    : undefined;
  useProjectStore.getState().applyAgentSurfaces({
    settings,
    audioMixer: data.audioMixer as AudioMixer | undefined,
    editPlan: data.editPlan === undefined ? undefined : (data.editPlan as EditPlan | null) ?? null,
    styleDnaLibrary: Array.isArray(data.styleDnaLibrary) ? data.styleDnaLibrary as StyleDnaLibraryEntry[] : undefined,
    cameras: Array.isArray(data.cameras) ? data.cameras as Camera3D[] : undefined,
    lights: Array.isArray(data.lights) ? data.lights as Light3D[] : undefined,
    markers: Array.isArray(data.markers) ? data.markers as TimelineMarker[] : undefined,
    brandKit: data.brandKit === undefined ? undefined : (data.brandKit as BrandKit | null) ?? null,
    graphicTemplates: Array.isArray(data.graphicTemplates) ? data.graphicTemplates as GraphicTemplate[] : undefined,
  });
  if (settings) usePlaybackStore.getState().setDuration(settings.duration || 0);
}

export const useAIStore = create<AIState>((set, get) => ({
  messages: [],
  isStreaming: false,
  activeToolCall: null,
  activeRunId: null,
  currentPhase: null,
  runUsage: null,

  editLikeThisStep: "idle",
  editLikeThisDetail: "",
  blueprint: null,
  styleDna: null,
  assetMappings: [],
  isEditLikeThisRunning: false,
  editLikeThisQuality: null,
  editLikeThisWarnings: [],

  sendMessage: async (message: string) => {
    const projectId = useProjectStore.getState().id;
    if (!projectId || get().isStreaming || get().isEditLikeThisRunning) return;

    const userMsg: AIMessage = {
      id: nextId(),
      role: "user",
      content: message,
      timestamp: new Date().toISOString(),
    };

    set((s) => ({
      messages: [...s.messages, userMsg],
      isStreaming: true,
      activeToolCall: null,
      activeRunId: null,
      currentPhase: "Planning",
      runUsage: null,
    }));

    const assistantMsgId = nextId();
    let parts: AIMessagePart[] = [];
    let partSeq = 0;
    const nextPartId = () => `part-${assistantMsgId}-${++partSeq}`;
    const commitAssistantParts = (visibleParts: AIMessagePart[]) => {
      const mirrors = mirrorsFromParts(visibleParts);
      set((s) => ({
        messages: patchAssistant(s.messages, assistantMsgId, {
          parts: [...visibleParts],
          content: mirrors.content,
          toolCalls: mirrors.toolCalls,
          toolResults: mirrors.toolResults,
        }),
      }));
    };
    const assistantSync = new LatestSnapshotSynchronizer<AIMessagePart[]>(
      commitAssistantParts,
      32
    );
    const syncAssistant = (
      nextParts: AIMessagePart[],
      extra?: { activeToolCall?: AIState["activeToolCall"] }
    ) => {
      parts = nextParts;
      if (extra?.activeToolCall !== undefined) set({ activeToolCall: extra.activeToolCall });
      assistantSync.enqueue([...nextParts]);
    };

    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: assistantMsgId,
          role: "assistant",
          content: "",
          parts: [],
          toolCalls: [],
          toolResults: [],
          timestamp: new Date().toISOString(),
        },
      ],
    }));

    let agentFailed = false;
    const projectSync = new LatestSnapshotSynchronizer<Record<string, unknown>>(
      applyAgentSurfaceUpdate
    );
    try {
      // Persist flushed nest/main so agent tools see current sequences
      useSequenceStore.getState().flushActiveToHome();
      await useProjectStore.getState().saveProject();

      // One agent turn → one undo checkpoint (pause zundo for mid-stream updates)
      const baselineTracks = structuredClone(useTimelineStore.getState().tracks);
      const baselineTransitions = structuredClone(
        useTimelineStore.getState().transitions
      );
      const baselineSeq = useSequenceStore.getState().snapshotForAgentBaseline();
      useTimelineStore.temporal.getState().pause();

      try {
        activeAgentController = new AbortController();
        for await (const agentEvent of streamAIChat(projectId, message, activeAgentController.signal)) {
          const nextParts = applyAgentEventToParts(parts, agentEvent, nextPartId);
          if (nextParts !== parts) syncAssistant(nextParts);

          switch (agentEvent.event) {
            case "run.started":
              set({ activeRunId: agentEvent.runId });
              break;
            case "phase.started":
              set({ currentPhase: agentEvent.title });
              break;
            case "tool.call.started":
              set({ activeToolCall: { id: agentEvent.toolCallId, name: agentEvent.name, args: {} } });
              break;
            case "tool.call.ready":
              set({ activeToolCall: { id: agentEvent.toolCallId, name: agentEvent.name, args: agentEvent.arguments } });
              break;
            case "tool.result":
              if (get().activeToolCall?.id === agentEvent.toolCallId) set({ activeToolCall: null });
              break;
            case "usage.updated":
              set({ runUsage: {
                inputTokens: agentEvent.inputTokens,
                outputTokens: agentEvent.outputTokens,
                thoughtTokens: agentEvent.thoughtTokens,
                totalTokens: agentEvent.totalTokens,
              } });
              break;
            case "project.patch": {
              const snapshot = agentEvent.project;
              projectSync.enqueue(snapshot);
              break;
            }
            case "run.failed": {
              agentFailed = true;
              projectSync.clear();
              const errMsg = agentEvent.message || "AI error";
              toast.error(errMsg);
              syncAssistant(
                appendTextPart(parts, `\n\n*Error: ${errMsg}*`, nextPartId),
                { activeToolCall: null }
              );
              break;
            }
            case "run.completed": {
              const snapshot = agentEvent.project;
              projectSync.enqueue(snapshot);
              projectSync.flush();
              break;
            }
            case "run.cancelled":
              projectSync.flush();
              toast.info("Agent run stopped. Completed edits were kept and can be undone.");
              break;
          }
        }
      } catch (err: unknown) {
        const wasCancelled =
          activeAgentController?.signal.aborted === true ||
          (err instanceof DOMException && err.name === "AbortError");
        if (wasCancelled) {
          projectSync.flush();
          toast.info("Agent run stopped. Completed edits were kept and can be undone.");
        } else {
          agentFailed = true;
          projectSync.clear();
          const errMsg = errorMessage(err, "Connection failed");
          toast.error(errMsg);
          syncAssistant(appendTextPart(parts, `\n\n*Error: ${errMsg}*`, nextPartId));
        }
      } finally {
        activeAgentController = null;
        if (agentFailed) projectSync.clear();
        else projectSync.flush();
        useTimelineStore.temporal.getState().resume();
        const current = useTimelineStore.getState().tracks;
        const currentTx = useTimelineStore.getState().transitions;
        const seqNow = useSequenceStore.getState().snapshotForAgentBaseline();
        const timelineChanged =
          JSON.stringify(baselineTracks) !== JSON.stringify(current) ||
          JSON.stringify(baselineTransitions) !== JSON.stringify(currentTx);
        const seqChanged =
          JSON.stringify(baselineSeq) !== JSON.stringify(seqNow);
        if (agentFailed) {
          useTimelineStore
            .getState()
            .setTimeline(baselineTracks, baselineTransitions);
          useSequenceStore.getState().restoreAgentBaseline(baselineSeq);
        } else if (timelineChanged || seqChanged) {
          // Always record a turn checkpoint when Main/library changed even if
          // the active nest timeline was untouched (so Undo has a turn boundary).
          useTimelineStore.temporal.setState((t) => ({
            pastStates: [
              ...t.pastStates,
              { tracks: baselineTracks, transitions: baselineTransitions },
            ],
            futureStates: [],
          }));
          if (seqChanged) {
            useSequenceStore.setState({
              agentUndoBaseline: baselineSeq,
              agentRedoBaseline: null,
            });
          }
        }
      }
    } catch (err: unknown) {
      projectSync.clear();
      const errMsg = errorMessage(err, "Connection failed");
      toast.error(errMsg);
      syncAssistant(appendTextPart(parts, `\n\n*Error: ${errMsg}*`, nextPartId));
    }

    const mirrors = mirrorsFromParts(parts);
    assistantSync.flush();
    assistantSync.clear();
    set((s) => ({
      isStreaming: false,
      activeToolCall: null,
      activeRunId: null,
      currentPhase: null,
      messages: patchAssistant(s.messages, assistantMsgId, {
        parts: [...parts],
        content: mirrors.content,
        toolCalls: mirrors.toolCalls,
        toolResults: mirrors.toolResults,
      }),
    }));
  },

  cancelRun: () => {
    activeAgentController?.abort();
    activeEditLikeThisController?.abort();
  },

  runEditLikeThis: async (url: string, audioPolicy: EditLikeThisAudioPolicy) => {
    const projectId = useProjectStore.getState().id;
    if (!projectId || get().isEditLikeThisRunning || get().isStreaming) return;

    set({
      isEditLikeThisRunning: true,
      editLikeThisStep: "downloading",
      editLikeThisDetail: "Starting...",
      blueprint: null,
      styleDna: null,
      assetMappings: [],
      editLikeThisQuality: null,
      editLikeThisWarnings: [],
      activeToolCall: null,
      activeRunId: null,
      currentPhase: "Preparing reference",
      runUsage: null,
    });

    const userMsg: AIMessage = {
      id: nextId(),
      role: "user",
      content: `Edit like this: ${url}`,
      timestamp: new Date().toISOString(),
    };
    const assistantMsgId = nextId();
    let parts: AIMessagePart[] = [];
    let partSeq = 0;
    const nextPartId = () => `part-${assistantMsgId}-${++partSeq}`;
    set((state) => ({
      messages: [
        ...state.messages,
        userMsg,
        {
          id: assistantMsgId,
          role: "assistant",
          content: "",
          parts: [],
          toolCalls: [],
          toolResults: [],
          timestamp: new Date().toISOString(),
        },
      ],
    }));
    const commitEditLikeThisParts = (visibleParts: AIMessagePart[]) => {
      const mirrors = mirrorsFromParts(visibleParts);
      set((state) => ({
        messages: patchAssistant(state.messages, assistantMsgId, {
          parts: [...visibleParts],
          content: mirrors.content,
          toolCalls: mirrors.toolCalls,
          toolResults: mirrors.toolResults,
        }),
      }));
    };
    const assistantSync = new LatestSnapshotSynchronizer<AIMessagePart[]>(
      commitEditLikeThisParts,
      32
    );
    const syncEditLikeThisAssistant = (nextParts: AIMessagePart[]) => {
      parts = nextParts;
      assistantSync.enqueue([...nextParts]);
    };
    const projectSync = new LatestSnapshotSynchronizer<Record<string, unknown>>(
      applyAgentSurfaceUpdate
    );

    let eltFailed = false;
    const baselineTracks = structuredClone(useTimelineStore.getState().tracks);
    const baselineTransitions = structuredClone(
      useTimelineStore.getState().transitions
    );
    const baselineSeq = useSequenceStore.getState().snapshotForAgentBaseline();
    const baselineProjectSurfaces = structuredClone({
      settings: useProjectStore.getState().settings,
      audioMixer: useProjectStore.getState().audioMixer,
      cameras: useProjectStore.getState().cameras,
      lights: useProjectStore.getState().lights,
      markers: useProjectStore.getState().markers,
      brandKit: useProjectStore.getState().brandKit,
      graphicTemplates: useProjectStore.getState().graphicTemplates,
    });
    useTimelineStore.temporal.getState().pause();

    try {
      useSequenceStore.getState().flushActiveToHome();
      await useProjectStore.getState().saveProject();

      activeEditLikeThisController = new AbortController();
      let terminalSeen = false;
      for await (const sseEvent of streamEditLikeThis(
        projectId,
        url,
        audioPolicy,
        activeEditLikeThisController.signal
      )) {
        const possibleAgentEvent = sseEvent.data as unknown as AgentRunEvent;
        if (
          possibleAgentEvent?.protocolVersion === 1 &&
          possibleAgentEvent.event === sseEvent.event
        ) {
          const nextParts = applyAgentEventToParts(parts, possibleAgentEvent, nextPartId);
          if (nextParts !== parts) syncEditLikeThisAssistant(nextParts);
        }
        switch (sseEvent.event) {
          case "progress": {
            const step = (sseEvent.data.step as EditLikeThisStep) || "downloading";
            const detail = (sseEvent.data.detail as string) || "";
            set({ editLikeThisStep: step, editLikeThisDetail: detail, currentPhase: detail || "Working on reference" });
            break;
          }

          case "blueprint": {
            set({ blueprint: sseEvent.data.blueprint as EditBlueprint });
            break;
          }

          case "style_dna": {
            set({ styleDna: (sseEvent.data.styleDna as StyleDNA) || null });
            break;
          }

          case "mappings": {
            set({
              assetMappings: (sseEvent.data.mappings as AssetMappingPreview[]) || [],
            });
            break;
          }

          case "project_update": {
            projectSync.enqueue(sseEvent.data);
            break;
          }

          case "run.started": {
            set({ activeRunId: possibleAgentEvent.runId });
            break;
          }

          case "phase.started": {
            if (possibleAgentEvent.event === "phase.started") {
              set({ currentPhase: possibleAgentEvent.title });
            }
            break;
          }

          case "reasoning.delta": {
            // Chronological reasoning belongs to the assistant message parts.
            // The step detail remains a stable pipeline-status description.
            break;
          }

          case "tool.call.started": {
            if (possibleAgentEvent.event === "tool.call.started") {
              set({ activeToolCall: { id: possibleAgentEvent.toolCallId, name: possibleAgentEvent.name, args: {} } });
            }
            break;
          }

          case "tool.call.ready": {
            if (possibleAgentEvent.event === "tool.call.ready") {
              set({ activeToolCall: { id: possibleAgentEvent.toolCallId, name: possibleAgentEvent.name, args: possibleAgentEvent.arguments } });
            }
            break;
          }

          case "tool.result": {
            if (possibleAgentEvent.event === "tool.result") set({ activeToolCall: null });
            break;
          }

          case "tool_call": {
            const name = sseEvent.data.name as string;
            const args = (sseEvent.data.args as Record<string, unknown>) || {};
            const id = (sseEvent.data.id as string) || undefined;
            set({ activeToolCall: { id, name, args } });
            break;
          }

          case "tool_result": {
            set({ activeToolCall: null });
            break;
          }

          case "done": {
            terminalSeen = true;
            projectSync.enqueue(sseEvent.data);
            projectSync.flush();
            const qualityStatus = sseEvent.data.qualityStatus as string | undefined;
            const warnings = Array.isArray(sseEvent.data.warnings) ? sseEvent.data.warnings as string[] : [];
            if (sseEvent.data.blueprint) {
              set({ blueprint: sseEvent.data.blueprint as EditBlueprint });
            }
            if (sseEvent.data.styleDna) {
              set({ styleDna: sseEvent.data.styleDna as StyleDNA });
            }
            if (sseEvent.data.mappings) {
              set({
                assetMappings: sseEvent.data.mappings as AssetMappingPreview[],
              });
            }
            set({
              editLikeThisStep: "complete",
              editLikeThisDetail: "Edit recreation complete",
              isEditLikeThisRunning: false,
              activeToolCall: null,
              editLikeThisQuality: qualityStatus === "draft" ? "draft" : "polished",
              editLikeThisWarnings: warnings,
              activeRunId: null,
              currentPhase: null,
            });
            const hasAgentReply = parts.some((part) => part.type === "reply" || part.type === "text");
            if (!hasAgentReply) {
              syncEditLikeThisAssistant(appendTextPart(
                parts,
                qualityStatus === "draft"
                  ? `Created a validated reference edit with ${warnings.length || 1} warning${warnings.length === 1 ? "" : "s"}.`
                  : "Created and validated the reference edit.",
                nextPartId
              ));
            }
            if (qualityStatus === "draft" || warnings.length > 0) {
              toast.warning(`Edit created with ${warnings.length || 1} warning${warnings.length === 1 ? "" : "s"}`);
            } else {
              toast.success("Edit Like This complete");
            }
            if (sseEvent.data.referenceAudioAsset) {
              useMediaStore.getState().upsertAsset(sseEvent.data.referenceAudioAsset as MediaAsset);
              await useMediaStore.getState().loadAssets(projectId);
            }
            break;
          }

          case "error": {
            terminalSeen = true;
            eltFailed = true;
            projectSync.clear();
            const errMsg =
              (sseEvent.data.message as string) || "Edit Like This failed";
            set({
              editLikeThisStep: "error",
              editLikeThisDetail: errMsg,
              isEditLikeThisRunning: false,
              activeToolCall: null,
              activeRunId: null,
              currentPhase: null,
            });
            syncEditLikeThisAssistant(appendTextPart(parts, `*Error: ${errMsg}*`, nextPartId));
            toast.error(errMsg);
            break;
          }
        }
      }

      if (!terminalSeen && get().isEditLikeThisRunning) {
        throw new Error("Edit Like This stream ended before a terminal result");
      }
    } catch (err: unknown) {
      eltFailed = true;
      projectSync.clear();
      const wasCancelled = activeEditLikeThisController?.signal.aborted === true ||
        (err instanceof DOMException && err.name === "AbortError");
      const errMsg = wasCancelled ? "Edit Like This stopped; incomplete changes were rolled back" : errorMessage(err, "Connection failed");
      set({
        editLikeThisStep: wasCancelled ? "idle" : "error",
        editLikeThisDetail: errMsg,
        isEditLikeThisRunning: false,
        activeToolCall: null,
        activeRunId: null,
        currentPhase: null,
      });
      syncEditLikeThisAssistant(appendTextPart(
        parts,
        wasCancelled ? "Edit Like This was stopped. Incomplete changes were rolled back." : `*Error: ${errMsg}*`,
        nextPartId
      ));
      if (wasCancelled) toast.info(errMsg);
      else toast.error(errMsg);
    } finally {
      activeEditLikeThisController = null;
      assistantSync.flush();
      assistantSync.clear();
      if (eltFailed) projectSync.clear();
      else projectSync.flush();
      useTimelineStore.temporal.getState().resume();
      const current = useTimelineStore.getState().tracks;
      const currentTx = useTimelineStore.getState().transitions;
      const seqNow = useSequenceStore.getState().snapshotForAgentBaseline();
      const timelineChanged =
        JSON.stringify(baselineTracks) !== JSON.stringify(current) ||
        JSON.stringify(baselineTransitions) !== JSON.stringify(currentTx);
      const seqChanged =
        JSON.stringify(baselineSeq) !== JSON.stringify(seqNow);

      if (eltFailed) {
        useTimelineStore
          .getState()
          .setTimeline(baselineTracks, baselineTransitions);
        useSequenceStore.getState().restoreAgentBaseline(baselineSeq);
        useProjectStore.setState(baselineProjectSurfaces);
        usePlaybackStore.getState().setDuration(baselineProjectSurfaces.settings.duration || 0);
      } else if (timelineChanged || seqChanged) {
        useTimelineStore.temporal.setState((t) => ({
          pastStates: [
            ...t.pastStates,
            { tracks: baselineTracks, transitions: baselineTransitions },
          ],
          futureStates: [],
        }));
        if (seqChanged) {
          useSequenceStore.setState({
            agentUndoBaseline: baselineSeq,
            agentRedoBaseline: null,
          });
        }
      }
    }
  },

  clearEditLikeThis: () =>
    set({
      editLikeThisStep: "idle",
      editLikeThisDetail: "",
      blueprint: null,
      styleDna: null,
      assetMappings: [],
      isEditLikeThisRunning: false,
      editLikeThisQuality: null,
      editLikeThisWarnings: [],
    }),

  loadConversation: async (projectId: string) => {
    const res = await apiFetch<{
      data?: {
        aiMessages?: AIMessage[];
        aiConversation?: LegacyConversationEntry[];
      };
    }>(`/api/projects/${projectId}`);

    if (!res.success || !res.data) return;

    // Don't clobber an in-flight chat if load resolves after sendMessage started
    if (get().isStreaming || get().isEditLikeThisRunning) return;

    const data = res.data.data || {};
    const storedMessages = data.aiMessages;

    if (Array.isArray(storedMessages) && storedMessages.length > 0) {
      if (get().isStreaming || get().isEditLikeThisRunning) return;
      set({
        messages: storedMessages.map((m: AIMessage) => {
          const id = m.id || nextId();
          let partSeq = 0;
          const parts = ensureMessageParts(m, () => `${id}-hydrated-${++partSeq}`);
          const mirrors = mirrorsFromParts(parts);
          return {
            ...m,
            id,
            parts,
            content: mirrors.content || m.content || "",
            toolCalls: mirrors.toolCalls.length ? mirrors.toolCalls : m.toolCalls,
            toolResults: mirrors.toolResults.length
              ? mirrors.toolResults
              : m.toolResults,
          };
        }),
      });
      return;
    }

    // Legacy fallback: plain Gemini text turns (skip stub placeholders)
    const rawConvo = data.aiConversation;
    if (!Array.isArray(rawConvo) || rawConvo.length === 0) return;
    if (get().isStreaming || get().isEditLikeThisRunning) return;

    const messages: AIMessage[] = rawConvo
      .filter((entry) => {
        const text = entry.parts?.[0]?.text;
        return text && !text.startsWith("[");
      })
      .map((entry) => ({
        id: nextId(),
        role: entry.role === "user" ? ("user" as const) : ("assistant" as const),
        content: entry.parts?.[0]?.text || "",
        timestamp: new Date().toISOString(),
      }));

    set({ messages });
  },

  reset: () => {
    activeAgentController?.abort();
    activeAgentController = null;
    activeEditLikeThisController?.abort();
    activeEditLikeThisController = null;
    set({
      messages: [],
      isStreaming: false,
      activeToolCall: null,
      activeRunId: null,
      currentPhase: null,
      runUsage: null,
      editLikeThisStep: "idle",
      editLikeThisDetail: "",
      blueprint: null,
      styleDna: null,
      assetMappings: [],
      isEditLikeThisRunning: false,
      editLikeThisQuality: null,
      editLikeThisWarnings: [],
    });
  },
}));
