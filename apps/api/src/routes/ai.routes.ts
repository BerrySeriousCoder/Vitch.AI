import { Router, type Request, type Response, type Router as RouterType } from "express";
import { eq } from "drizzle-orm";
import { db, projects, mediaAssets } from "@tempo/db";
import { authMiddleware, AppError } from "../middleware/index.js";
import { runAgentLoop, serializeConversation } from "../services/ai/agent.service.js";
import { generateBlueprint } from "../services/reference/blueprint.service.js";
import { matchAssets } from "../services/reference/asset-matching.service.js";
import { recreateEdit, repairVerifiedRecreation } from "../services/reference/recreation.service.js";
import { verifyRecreationAgainstReference } from "../services/reference/recreation-verification.service.js";
import { evaluateKnownReferenceBlueprint } from "../services/reference/reference-blueprint-benchmark.service.js";
import {
  compileRecreationDraft,
  validateRecreationConformance,
} from "../services/reference/recreation-compiler.service.js";
import { referenceVideoSchema } from "@tempo/validators";
import { extractStyleDnaFromBlueprint, applyStyleDnaHints } from "@tempo/editor-core";
import { logger } from "../utils/logger.js";
import type { Content } from "@google/genai";
import type { AgentRunEvent, AIMessage, AIMessagePart, EditBlueprint, StyleDNA } from "@tempo/types";
import {
  appendTextPart,
  applyAgentEventToParts,
  mirrorsFromParts,
} from "@tempo/editor-core";
import { randomUUID } from "crypto";
import {
  discardStagedReferenceAudio,
  stageReferenceAudioAsset,
  type StagedReferenceAudioAsset,
} from "../services/reference/reference-audio.service.js";
import {
  discardStagedReferenceVideo,
  stageReferenceVideoAsset,
  type StagedReferenceVideoAsset,
} from "../services/reference/reference-video.service.js";
import { toClientMediaAsset } from "../services/ai/tools/media-assets.js";

const router: RouterType = Router();

router.use(authMiddleware);

function nextMsgId() {
  return `ai-msg-${randomUUID()}`;
}

// ─── AI Chat (SSE streaming) ──────────────────────────────
router.post("/:projectId/ai/chat", async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { message } = req.body;

  if (!message || typeof message !== "string") {
    throw new AppError(400, "message is required");
  }

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId as string),
  });
  if (!project) throw new AppError(404, "Project not found");
  if (project.userId !== req.user!.userId) throw new AppError(403, "Access denied");

  const assets = await db.query.mediaAssets.findMany({
    where: eq(mediaAssets.projectId, projectId as string),
  });

  const projectData = (project.data || {}) as Record<string, any>;
  const conversationHistory: Content[] = projectData.aiConversation || [];
  const historyLengthAtStart = conversationHistory.length;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendSSE = (event: string, data: unknown, id?: number) => {
    if (res.destroyed || res.writableEnded) return;
    res.write(`${id != null ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(": heartbeat\n\n");
  }, 15_000);

  let updatedTracks: any[] | null = null;
  let updatedMixer: any | null = null;
  let updatedTransitions: any[] | null = null;
  let updatedSequences: any[] | null = null;
  let updatedStyleDna: any | null = null;
  let updatedEditPlan: any | undefined = undefined;
  let updatedStyleDnaLibrary: any | undefined = undefined;
  let updatedCameras: any[] | undefined = undefined;
  let updatedLights: any[] | undefined = undefined;
  let updatedMarkers: any[] | undefined = undefined;
  let updatedBrandKit: any | undefined = undefined;
  let updatedGraphicTemplates: any[] | undefined = undefined;
  let latestInteractionId: string | undefined;
  let terminalStatus: "completed" | "incomplete" | "failed" | "cancelled" = "completed";
  let parts: AIMessagePart[] = [];
  let partSeq = 0;
  const nextPartId = () => `part-${Date.now()}-${++partSeq}`;
  let streamStarted = false;
  let lastWireSequence = 0;
  let wireRunId = `run-${randomUUID()}`;
  let wireTurnId = `turn-${randomUUID()}`;

  try {
    streamStarted = true;
    const agentLoop = runAgentLoop(
      {
        id: project.id,
        name: project.name,
        settings: project.settings as Record<string, any>,
        tracks: projectData.tracks || [],
        transitions: projectData.transitions || [],
        sequences: projectData.sequences || [],
        cameras: projectData.cameras || [],
        lights: projectData.lights || [],
        markers: projectData.markers || [],
        brandKit: projectData.brandKit || null,
        graphicTemplates: projectData.graphicTemplates || [],
        audioMixer: projectData.audioMixer,
        editBlueprint: projectData.editBlueprint || null,
        styleDna: projectData.styleDna || null,
        editPlan: projectData.editPlan || null,
        styleDnaLibrary: projectData.styleDnaLibrary || [],
        previousInteractionId: projectData.aiPreviousInteractionId || null,
      },
      assets as any[],
      message,
      conversationHistory,
      { signal: abortController.signal }
    );

    for await (const agentEvent of agentLoop) {
      lastWireSequence = agentEvent.sequence;
      wireRunId = agentEvent.runId;
      wireTurnId = agentEvent.turnId;
      sendSSE(agentEvent.event, agentEvent, agentEvent.sequence);
      parts = applyAgentEventToParts(parts, agentEvent, nextPartId);

      if (agentEvent.event === "project.patch" || agentEvent.event === "run.completed") {
        const snapshot = agentEvent.event === "project.patch" ? agentEvent.project : agentEvent.project;
        updatedTracks = Array.isArray(snapshot.tracks) ? snapshot.tracks as any[] : updatedTracks;
        if (snapshot.audioMixer) updatedMixer = snapshot.audioMixer;
        if (Array.isArray(snapshot.transitions)) updatedTransitions = snapshot.transitions as any[];
        if (Array.isArray(snapshot.sequences)) updatedSequences = snapshot.sequences as any[];
        if (snapshot.styleDna !== undefined) updatedStyleDna = snapshot.styleDna;
        if (snapshot.editPlan !== undefined) updatedEditPlan = snapshot.editPlan;
        if (snapshot.styleDnaLibrary !== undefined) updatedStyleDnaLibrary = snapshot.styleDnaLibrary;
        if (Array.isArray(snapshot.cameras)) updatedCameras = snapshot.cameras as any[];
        if (Array.isArray(snapshot.lights)) updatedLights = snapshot.lights as any[];
        if (Array.isArray(snapshot.markers)) updatedMarkers = snapshot.markers as any[];
        if (snapshot.brandKit !== undefined) updatedBrandKit = snapshot.brandKit;
        if (Array.isArray(snapshot.graphicTemplates)) updatedGraphicTemplates = snapshot.graphicTemplates as any[];
      }
      if (agentEvent.event === "run.completed") {
        latestInteractionId = agentEvent.interactionId;
        terminalStatus = agentEvent.status === "incomplete" ? "incomplete" : "completed";
      } else if (agentEvent.event === "run.failed") {
        terminalStatus = "failed";
        parts = appendTextPart(parts, `\n\n*Error: ${agentEvent.message}*`, nextPartId);
      } else if (agentEvent.event === "run.cancelled") {
        terminalStatus = "cancelled";
        latestInteractionId = agentEvent.interactionId;
      }
    }
  } catch (err: any) {
    logger.error({ err: err.message }, "AI chat error");
    try {
      const fallbackEvent: AgentRunEvent = {
        protocolVersion: 1,
        event: "run.failed",
        runId: wireRunId,
        turnId: wireTurnId,
        sequence: lastWireSequence + 1,
        timestamp: new Date().toISOString(),
        status: "failed",
        message: err.message || "Internal error",
        recoverable: true,
      };
      sendSSE(fallbackEvent.event, fallbackEvent, fallbackEvent.sequence);
      terminalStatus = "failed";
    } catch {
      // response may already be closed
    }
  }

  // Always persist after stream when we started — re-read project to avoid
  // concurrent chat overwrites (last writer must append onto latest messages).
  if (streamStarted) {
    try {
      const fresh = await db.query.projects.findFirst({
        where: eq(projects.id, project.id),
      });
      const freshData = ((fresh?.data || projectData) || {}) as Record<string, any>;
      const latestMessages: AIMessage[] = Array.isArray(freshData.aiMessages)
        ? freshData.aiMessages
        : [];
      const freshConvo: Content[] = Array.isArray(freshData.aiConversation)
        ? freshData.aiConversation
        : [];

      const mirrors = mirrorsFromParts(parts);
      const assistantContent = mirrors.content;

      const userMsg: AIMessage = {
        id: nextMsgId(),
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      };
      const assistantMsg: AIMessage = {
        id: nextMsgId(),
        role: "assistant",
        content: assistantContent,
        parts: parts.length ? parts : undefined,
        toolCalls: mirrors.toolCalls.length ? mirrors.toolCalls : undefined,
        toolResults: mirrors.toolResults.length ? mirrors.toolResults : undefined,
        timestamp: new Date().toISOString(),
      };

      const nextConversation: Content[] = [
        ...(freshConvo.length > historyLengthAtStart ? freshConvo : conversationHistory),
        { role: "user", parts: [{ text: message }] },
        { role: "model", parts: [{ text: assistantContent || `[Agent run ${terminalStatus}]` }] },
      ];

      const nextData: Record<string, any> = {
        ...freshData,
        aiMessages: [...latestMessages, userMsg, assistantMsg],
        aiConversation: serializeConversation(nextConversation),
      };
      if (latestInteractionId) nextData.aiPreviousInteractionId = latestInteractionId;

      if (updatedTracks) nextData.tracks = updatedTracks;
      if (updatedMixer) nextData.audioMixer = updatedMixer;
      if (updatedTransitions) nextData.transitions = updatedTransitions;
      if (updatedSequences) nextData.sequences = updatedSequences;
      if (updatedStyleDna) nextData.styleDna = updatedStyleDna;
      else if (!nextData.styleDna && nextData.editBlueprint) {
        try {
          nextData.styleDna = extractStyleDnaFromBlueprint(nextData.editBlueprint);
        } catch {
          /* ignore */
        }
      }
      if (updatedEditPlan !== undefined) nextData.editPlan = updatedEditPlan;
      if (updatedStyleDnaLibrary !== undefined) {
        nextData.styleDnaLibrary = updatedStyleDnaLibrary;
      }
      if (updatedCameras !== undefined) nextData.cameras = updatedCameras;
      if (updatedLights !== undefined) nextData.lights = updatedLights;
      if (updatedMarkers !== undefined) nextData.markers = updatedMarkers;
      if (updatedBrandKit !== undefined) nextData.brandKit = updatedBrandKit;
      if (updatedGraphicTemplates !== undefined) nextData.graphicTemplates = updatedGraphicTemplates;

      await db
        .update(projects)
        .set({ data: nextData })
        .where(eq(projects.id, project.id));
    } catch (persistErr: any) {
      logger.error({ err: persistErr.message }, "AI chat persist error");
    }
  }

  clearInterval(heartbeat);
  res.end();
});

// ─── AI Edit-Like-This (SSE streaming pipeline) ──────────
router.post("/:projectId/ai/edit-like-this", async (req: Request, res: Response) => {
  const { projectId } = req.params;

  const parsed = referenceVideoSchema.safeParse({
    url: req.body?.url,
    projectId,
    audioPolicy: req.body?.audioPolicy,
  });
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues[0]?.message || "Invalid reference URL");
  }
  const { url, audioPolicy } = parsed.data;

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId as string),
  });
  if (!project) throw new AppError(404, "Project not found");
  if (project.userId !== req.user!.userId) throw new AppError(403, "Access denied");

  const assetRows = await db.query.mediaAssets.findMany({
    where: eq(mediaAssets.projectId, projectId as string),
  });
  let assets = assetRows.map(toClientMediaAsset);
  let soundtrackAssetId = audioPolicy.uploadedAudioAssetId;
  let stagedReferenceAudio: StagedReferenceAudioAsset | null = null;
  let stagedReferenceVideo: StagedReferenceVideoAsset | null = null;
  let referenceAssetsCommitted = false;

  if (audioPolicy.soundtrack === "uploaded") {
    const selected = assets.find((asset) => asset.id === audioPolicy.uploadedAudioAssetId);
    if (!selected || selected.type !== "audio") {
      throw new AppError(400, "The selected uploaded soundtrack is unavailable or is not audio");
    }
  }

  const projectData = (project.data || {}) as Record<string, any>;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendSSE = (event: string, data: unknown, id?: number) => {
    if (res.destroyed || res.writableEnded) return;
    res.write(`${id != null ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(": heartbeat\n\n");
  }, 15_000);
  let eltParts: AIMessagePart[] = [];
  let eltPartSequence = 0;
  const nextEltPartId = () => `elt-part-${Date.now()}-${++eltPartSequence}`;

  try {
    let blueprint: EditBlueprint | null = null;
    let candidateBenchmark: Awaited<ReturnType<typeof evaluateKnownReferenceBlueprint>>;

    for await (const event of generateBlueprint(url, { signal: abortController.signal })) {
      if (event.step === "complete") {
        blueprint = event.blueprint;
        sendSSE("progress", {
          step: "saving_reference",
          detail: "Saving the reference video and transcript for follow-up checks...",
        });
        stagedReferenceVideo = await stageReferenceVideoAsset({
          projectId: project.id,
          userId: req.user!.userId,
          sourceUrl: url,
          videoPath: event.referenceVideoPath,
          blueprint: event.blueprint,
          transcript: event.referenceTranscript,
        });
        blueprint.referenceAssetId = stagedReferenceVideo.asset.id;
        assets = [
          ...assets.filter((asset) => asset.id !== stagedReferenceVideo!.asset.id),
          stagedReferenceVideo.asset,
        ];
        if (audioPolicy.soundtrack === "reference") {
          if (!event.referenceAudioPath) {
            throw new Error("This reference video has no downloadable audio track");
          }
          sendSSE("progress", {
            step: "importing_audio",
            detail: "Importing the authorized reference soundtrack...",
          });
          stagedReferenceAudio = await stageReferenceAudioAsset({
            projectId: project.id,
            userId: req.user!.userId,
            sourceUrl: url,
            blueprintId: event.blueprint.id,
            audioPath: event.referenceAudioPath,
            duration: event.blueprint.totalDuration,
            analysis: event.blueprint.audioAnalysis,
            transcript: event.referenceTranscript,
          });
          soundtrackAssetId = stagedReferenceAudio.asset.id;
          assets = [
            ...assets.filter((asset) => asset.id !== stagedReferenceAudio!.asset.id),
            stagedReferenceAudio.asset,
          ];
        }
        sendSSE("blueprint", { blueprint: event.blueprint });
      } else {
        sendSSE("progress", { step: event.step, detail: event.detail });
      }
    }

    if (!blueprint) {
      sendSSE("error", { message: "Failed to generate blueprint" });
      return;
    }

    candidateBenchmark = await evaluateKnownReferenceBlueprint(blueprint);
    if (candidateBenchmark) {
      sendSSE("benchmark", candidateBenchmark.report);
      sendSSE("progress", {
        step: "benchmarking_reference",
        detail: candidateBenchmark.report.passed
          ? `Reference benchmark passed (${candidateBenchmark.report.score}/100).`
          : `Reference benchmark found ${candidateBenchmark.report.issues.length} mismatch(es) (${candidateBenchmark.report.score}/100).`,
      });
    }

    sendSSE("progress", {
      step: "style_dna",
      detail: "Extracting Style DNA from reference...",
    });
    const styleDna: StyleDNA = extractStyleDnaFromBlueprint(blueprint);
    sendSSE("style_dna", { styleDna });

    sendSSE("progress", {
      step: "matching_assets",
      detail: `Matching source assets to ${blueprint.segments.length} segments...`,
    });
    const sourceAssets = assets.filter(
      (asset) => !asset.metadata?.referenceVideo && !asset.metadata?.referenceAudio
    );
    const projectSettings = project.settings as Record<string, any>;
    const mappings = await matchAssets(
      blueprint.segments,
      sourceAssets as any[],
      styleDna,
      {
        targetWidth: Number(projectSettings.width) || undefined,
        targetHeight: Number(projectSettings.height) || undefined,
        orientationPolicy: "prefer",
      }
    );
    sendSSE("mappings", { mappings });

    if (mappings.length === 0) {
      await db.transaction(async (tx) => {
        if (stagedReferenceVideo?.created && stagedReferenceVideo.insertValues) {
          await tx.insert(mediaAssets).values(stagedReferenceVideo.insertValues);
        }
        if (stagedReferenceAudio?.created && stagedReferenceAudio.insertValues) {
          await tx.insert(mediaAssets).values(stagedReferenceAudio.insertValues);
        }
        await tx
          .update(projects)
          .set({ data: { ...projectData, editBlueprint: blueprint, styleDna } })
          .where(eq(projects.id, project.id));
      });
      referenceAssetsCommitted = true;

      sendSSE("error", {
        code: "NO_MATCHABLE_MEDIA",
        message: "No video or image assets can satisfy the reference. Upload footage, then run Edit Like This again.",
      });
      return;
    }

    sendSSE("progress", { step: "recreating", detail: "Compiling a source-safe reference cut..." });
    const context = {
      id: project.id,
      name: project.name,
      settings: project.settings as import("@tempo/types").ProjectSettings,
      tracks: projectData.tracks || [],
      transitions: projectData.transitions || [],
      sequences: projectData.sequences || [],
      cameras: projectData.cameras || [],
      lights: projectData.lights || [],
      markers: projectData.markers || [],
      brandKit: projectData.brandKit || null,
      graphicTemplates: projectData.graphicTemplates || [],
      audioMixer: projectData.audioMixer,
      editBlueprint: blueprint,
      styleDna,
      editPlan: projectData.editPlan || null,
      styleDnaLibrary: projectData.styleDnaLibrary || [],
    };
    const draft = await compileRecreationDraft(
      context,
      assets,
      blueprint,
      mappings,
      { policy: audioPolicy, soundtrackAssetId }
    );
    const styleDnaClipIds = draft.manifest.entries.filter((entry) => {
      if (entry.binding.kind === "segment") return true;
      if (entry.binding.kind !== "composition-layer") return false;
      const segment = blueprint.segments.find((candidate) => candidate.index === entry.binding.segmentIndex);
      return segment?.composition?.layers.find((layer) => layer.id === entry.binding.layerId)?.role !== "matte-fill";
    }).map((entry) => entry.clipId);
    draft.state.tracks = applyStyleDnaHints(draft.state.tracks, styleDna, {
      clipIds: styleDnaClipIds,
    });

    const draftSnapshot: Record<string, any> = {
      settings: draft.settings,
      tracks: draft.state.tracks,
      audioMixer: draft.state.audioMixer,
      transitions: draft.state.transitions || [],
      sequences: draft.state.sequences || [],
      cameras: draft.state.cameras || [],
      lights: draft.state.lights || [],
      markers: draft.state.markers || [],
      brandKit: draft.state.brandKit || null,
      graphicTemplates: draft.state.graphicTemplates || [],
      styleDna,
      editPlan: draft.state.editPlan || null,
      styleDnaLibrary: draft.state.styleDnaLibrary || [],
    };
    sendSSE("project_update", draftSnapshot);
    sendSSE("progress", {
      step: "recreating",
      detail: `Compiled ${blueprint.segments.length} source-safe segments. Creative director is polishing the draft...`,
    });

    let latestSnapshot: Record<string, any> = draftSnapshot;
    let agentStatus: "completed" | "incomplete" | "failed" | "cancelled" = "completed";
    let agentFailureMessage: string | undefined;

    for await (const agentEvent of recreateEdit(
      {
        ...context,
        settings: draft.settings,
        tracks: draft.state.tracks,
        transitions: draft.state.transitions || [],
        sequences: draft.state.sequences || [],
        cameras: draft.state.cameras || [],
        lights: draft.state.lights || [],
        markers: draft.state.markers || [],
        brandKit: draft.state.brandKit || null,
        graphicTemplates: draft.state.graphicTemplates || [],
        audioMixer: draft.state.audioMixer,
      },
      assets,
      blueprint,
      mappings,
      draft.manifest,
      styleDna,
      { signal: abortController.signal }
    )) {
      eltParts = applyAgentEventToParts(eltParts, agentEvent, nextEltPartId);
      // Forward the versioned chronological agent protocol unchanged. The ELT
      // client can render reasoning/tool/reply parts exactly like normal chat.
      sendSSE(agentEvent.event, agentEvent, agentEvent.sequence);
      if (agentEvent.event === "project.patch" || agentEvent.event === "run.completed") {
        latestSnapshot = { ...latestSnapshot, ...agentEvent.project };
        sendSSE("project_update", latestSnapshot);
      }
      if (agentEvent.event === "run.completed") {
        agentStatus = agentEvent.status === "incomplete" ? "incomplete" : "completed";
      } else if (agentEvent.event === "run.failed") {
        agentStatus = "failed";
        agentFailureMessage = agentEvent.message;
      } else if (agentEvent.event === "run.cancelled") {
        agentStatus = "cancelled";
      } else if (agentEvent.event === "phase.started") {
        sendSSE("progress", { step: "recreating", detail: agentEvent.title });
      }
    }

    if (abortController.signal.aborted || agentStatus === "cancelled") return;

    const polishedState = {
      tracks: Array.isArray(latestSnapshot.tracks) ? latestSnapshot.tracks : draft.state.tracks,
      transitions: Array.isArray(latestSnapshot.transitions) ? latestSnapshot.transitions : draft.state.transitions || [],
      sequences: Array.isArray(latestSnapshot.sequences) ? latestSnapshot.sequences : draft.state.sequences || [],
      mediaAssets: assets as any[],
      settings: (latestSnapshot.settings || draft.settings) as import("@tempo/types").ProjectSettings,
      audioMixer: (latestSnapshot.audioMixer || draft.state.audioMixer) as import("@tempo/types").AudioMixer,
    };
    const polishedReport = validateRecreationConformance(
      polishedState,
      blueprint,
      draft.manifest
    );

    const warnings = [
      ...draft.warnings,
      ...(candidateBenchmark && !candidateBenchmark.report.passed
        ? [`Reference benchmark ${candidateBenchmark.spec.id} failed at ${candidateBenchmark.report.score}/100: ${candidateBenchmark.report.issues.slice(0, 6).map((issue) => issue.code).join(", ")}`]
        : []),
    ];
    let qualityStatus: "polished" | "draft" = candidateBenchmark && !candidateBenchmark.report.passed
      ? "draft"
      : "polished";
    let finalSnapshot = latestSnapshot;
    let conformance = polishedReport;
    if (agentStatus !== "completed" || !polishedReport.ok) {
      qualityStatus = "draft";
      finalSnapshot = draftSnapshot;
      conformance = validateRecreationConformance(
        {
          tracks: draft.state.tracks,
          transitions: draft.state.transitions || [],
          sequences: draft.state.sequences || [],
          mediaAssets: assets as any[],
          settings: draft.settings,
          audioMixer: draft.state.audioMixer,
        },
        blueprint,
        draft.manifest
      );
      const reason = agentFailureMessage ||
        (agentStatus === "incomplete"
          ? "Creative polish reached its safety limit"
          : !polishedReport.ok
            ? `Creative polish violated ${polishedReport.errors} recreation postcondition(s)`
            : "Creative polish did not complete");
      warnings.push(`${reason}; reverted the polish pass and kept the validated deterministic draft`);
    }

    if (!conformance.ok) {
      throw new Error(
        `Recreation conformance failed: ${conformance.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => issue.message)
          .join("; ")}`
      );
    }

    finalSnapshot = {
      ...finalSnapshot,
      settings: finalSnapshot.settings || draft.settings,
      tracks: applyStyleDnaHints(finalSnapshot.tracks || [], styleDna, {
        clipIds: styleDnaClipIds,
      }),
    };

    // Complex ranges must pass a paired render/reference comparison. One
    // bounded evidence-driven repair pass is allowed; persistent mismatch is
    // surfaced honestly instead of being labelled polished.
    let visualVerification: Awaited<ReturnType<typeof verifyRecreationAgainstReference>> | undefined;
    try {
      sendSSE("progress", { step: "verifying_reference", detail: "Comparing complex ranges with the retained reference..." });
      visualVerification = await verifyRecreationAgainstReference({
        projectId: project.id,
        referenceAssetUrl: stagedReferenceVideo?.asset.url || assets.find((asset) => asset.id === blueprint.referenceAssetId)?.url || "",
        blueprint,
        tracks: finalSnapshot.tracks || [],
        transitions: finalSnapshot.transitions || [],
        sequences: finalSnapshot.sequences || [],
        settings: finalSnapshot.settings || draft.settings,
        onCaptureProgress: (captured, total) => sendSSE("progress", {
          step: "verifying_reference",
          detail: `Rendering comparison frames ${captured}/${total}...`,
        }),
      });
      if (!visualVerification.ok) {
        sendSSE("progress", { step: "repairing_reference", detail: "Repairing measured visual mismatches..." });
        const preRepairSnapshot = finalSnapshot;
        const preRepairConformance = conformance;
        let repairedSnapshot = finalSnapshot;
        for await (const repairEvent of repairVerifiedRecreation(
          {
            ...context,
            settings: (finalSnapshot.settings || draft.settings) as import("@tempo/types").ProjectSettings,
            tracks: finalSnapshot.tracks || [],
            transitions: finalSnapshot.transitions || [],
            sequences: finalSnapshot.sequences || [],
            audioMixer: finalSnapshot.audioMixer || draft.state.audioMixer,
          },
          assets,
          blueprint,
          draft.manifest,
          visualVerification.comparisons,
          { signal: abortController.signal }
        )) {
          eltParts = applyAgentEventToParts(eltParts, repairEvent, nextEltPartId);
          sendSSE(repairEvent.event, repairEvent, repairEvent.sequence);
          if (repairEvent.event === "project.patch" || repairEvent.event === "run.completed") {
            repairedSnapshot = { ...repairedSnapshot, ...repairEvent.project };
            sendSSE("project_update", repairedSnapshot);
          }
        }
        const repairedConformance = validateRecreationConformance({
          tracks: repairedSnapshot.tracks || [],
          transitions: repairedSnapshot.transitions || [],
          sequences: repairedSnapshot.sequences || [],
          mediaAssets: assets as any[],
          settings: repairedSnapshot.settings || draft.settings,
          audioMixer: repairedSnapshot.audioMixer || draft.state.audioMixer,
        }, blueprint, draft.manifest);
        if (repairedConformance.ok) {
          const repairedVerification = await verifyRecreationAgainstReference({
            projectId: project.id,
            referenceAssetUrl: stagedReferenceVideo?.asset.url || assets.find((asset) => asset.id === blueprint.referenceAssetId)?.url || "",
            blueprint,
            tracks: repairedSnapshot.tracks || [],
            transitions: repairedSnapshot.transitions || [],
            sequences: repairedSnapshot.sequences || [],
            settings: repairedSnapshot.settings || draft.settings,
            onCaptureProgress: (captured, total) => sendSSE("progress", {
              step: "verifying_reference",
              detail: `Re-rendering repaired comparison frames ${captured}/${total}...`,
            }),
          });
          visualVerification = repairedVerification;
          if (repairedVerification.ok) {
            finalSnapshot = repairedSnapshot;
            conformance = repairedConformance;
          } else {
            finalSnapshot = preRepairSnapshot;
            conformance = preRepairConformance;
            warnings.push("Rejected the bounded repair because its rendered comparison still failed; retained the pre-repair deterministic edit");
          }
        }
        if (!visualVerification.ok) {
          qualityStatus = "draft";
          warnings.push("Automatic reference comparison still found visual mismatches after the bounded repair pass; the edit is saved as a draft, not claimed as a match");
        }
      }
    } catch (verificationError: any) {
      qualityStatus = "draft";
      warnings.push(`Automatic visual verification unavailable: ${verificationError?.message || "unknown error"}`);
    }

    const fresh = await db.query.projects.findFirst({
      where: eq(projects.id, project.id),
    });
    const freshData = ((fresh?.data || projectData) || {}) as Record<string, any>;

    const nextData: Record<string, any> = {
      ...freshData,
      tracks: finalSnapshot.tracks,
      audioMixer: finalSnapshot.audioMixer,
      transitions: finalSnapshot.transitions || [],
      sequences: finalSnapshot.sequences || [],
      cameras: finalSnapshot.cameras || [],
      lights: finalSnapshot.lights || [],
      markers: finalSnapshot.markers || [],
      brandKit: finalSnapshot.brandKit || null,
      graphicTemplates: finalSnapshot.graphicTemplates || [],
      editPlan: finalSnapshot.editPlan || null,
      styleDnaLibrary: finalSnapshot.styleDnaLibrary || [],
      editBlueprint: blueprint,
      styleDna,
      editLikeThisManifest: draft.manifest,
      editLikeThisConformance: conformance,
      editLikeThisWarnings: warnings,
      editLikeThisAudioPolicy: audioPolicy,
      editLikeThisVisualVerification: visualVerification,
      editLikeThisBenchmark: candidateBenchmark?.report,
    };
    const priorMessages: AIMessage[] = Array.isArray(freshData.aiMessages)
      ? freshData.aiMessages
      : [];
    const eltMirrors = mirrorsFromParts(eltParts);
    nextData.aiMessages = [
      ...priorMessages,
      {
        id: nextMsgId(),
        role: "user",
        content: `Edit like this: ${url}`,
        timestamp: new Date().toISOString(),
      },
      {
        id: nextMsgId(),
        role: "assistant",
        content: eltMirrors.content || `Created a ${qualityStatus} reference edit with ${conformance.checkedSegments} segments.`,
        parts: eltParts.length ? eltParts : undefined,
        toolCalls: eltMirrors.toolCalls.length ? eltMirrors.toolCalls : undefined,
        toolResults: eltMirrors.toolResults.length ? eltMirrors.toolResults : undefined,
        timestamp: new Date().toISOString(),
      },
    ];

    await db.transaction(async (tx) => {
      if (stagedReferenceVideo?.created && stagedReferenceVideo.insertValues) {
        await tx.insert(mediaAssets).values(stagedReferenceVideo.insertValues);
      }
      if (stagedReferenceAudio?.created && stagedReferenceAudio.insertValues) {
        await tx.insert(mediaAssets).values(stagedReferenceAudio.insertValues);
      }
      await tx
        .update(projects)
        .set({ data: nextData, settings: finalSnapshot.settings })
        .where(eq(projects.id, project.id));
    });
    referenceAssetsCommitted = true;

    sendSSE("project_update", finalSnapshot);
    sendSSE("done", {
      blueprint,
      styleDna,
      mappings,
      ...finalSnapshot,
      qualityStatus,
      warnings,
      conformance,
      visualVerification,
      benchmark: candidateBenchmark?.report,
      audioPolicy,
      ...(stagedReferenceAudio ? { referenceAudioAsset: stagedReferenceAudio.asset } : {}),
      ...(stagedReferenceVideo ? { referenceVideoAsset: stagedReferenceVideo.asset } : {}),
    });
  } catch (err: any) {
    logger.error({ err: err.message }, "Edit-like-this error");
    sendSSE("error", { message: err.message || "Internal error" });
  } finally {
    if (stagedReferenceAudio?.created && !referenceAssetsCommitted) {
      await discardStagedReferenceAudio(stagedReferenceAudio).catch((cleanupError) => {
        logger.warn({ err: cleanupError?.message }, "Failed to discard staged reference audio");
      });
    }
    if (stagedReferenceVideo?.created && !referenceAssetsCommitted) {
      await discardStagedReferenceVideo(stagedReferenceVideo).catch((cleanupError) => {
        logger.warn({ err: cleanupError?.message }, "Failed to discard staged reference video");
      });
    }
    clearInterval(heartbeat);
    res.end();
  }
});

export default router;
