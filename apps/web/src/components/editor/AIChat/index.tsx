"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useAIStore } from "@/stores/ai.store";
import { EditLikeThis } from "@/components/editor/EditLikeThis";
import { EditPlanPanel } from "@/components/editor/EditPlan";
import type { AIMessage, AIMessagePart } from "@tempo/types";
import { ensureMessageParts } from "@tempo/editor-core";

const QUICK_ACTIONS = [
  { label: "Add title card", message: "Add a centered white title text 'My Video' at the start for 3 seconds" },
  { label: "Color grade warm", message: "Apply a warm color grade to all video clips — increase brightness slightly, add warmth via hue-rotate, and boost saturation" },
  { label: "Speed ramp 2x", message: "Speed up the selected clip to 2x playback speed" },
  { label: "Add lower third", message: "Add a lower-third text overlay with the text 'John Doe - Director' starting at 2 seconds for 4 seconds" },
  { label: "Fade to black", message: "Add a black shape clip at the end of the timeline as a fade-to-black" },
  {
    label: "Fix critique issues",
    message:
      "Run the refine phase: reopen any failed plan steps, fix critique_preview issues with tools, validate_timeline, then re-critique once if needed. Do not claim done while failed steps remain.",
  },
];

function parseScorecard(result: unknown): {
  overall?: number;
  dims?: { visual?: number; pacing?: number; typography?: number };
  issues: Array<{
    severity: string;
    time: number;
    code: string;
    message: string;
    fixHint?: string;
  }>;
} | null {
  if (typeof result !== "string" || !result.includes("SCORECARD_JSON:")) return null;
  const idx = result.indexOf("SCORECARD_JSON:");
  try {
    const json = JSON.parse(result.slice(idx + "SCORECARD_JSON:".length));
    if (!json || !Array.isArray(json.issues)) return null;
    return json;
  } catch {
    return null;
  }
}

function CritiqueScorecardCard({
  card,
}: {
  card: NonNullable<ReturnType<typeof parseScorecard>>;
}) {
  if (card.issues.length === 0) {
    return (
      <div className="mt-1.5 rounded-md border border-emerald-800/40 bg-emerald-950/25 px-2.5 py-1.5 text-[11px] text-emerald-300">
        Critique clean
        {card.overall != null ? ` · overall ${card.overall}` : ""}
      </div>
    );
  }
  return (
    <div className="mt-1.5 rounded-md border border-amber-800/35 bg-amber-950/15 px-2.5 py-1.5 text-[11px] text-zinc-300 space-y-1">
      <div className="font-medium text-amber-300">
        Critique · {card.issues.length} issue{card.issues.length === 1 ? "" : "s"}
        {card.overall != null ? ` · ${card.overall}` : ""}
      </div>
      {card.issues.slice(0, 6).map((issue, i) => (
        <div key={`${issue.code}-${i}`} className="text-[10px] text-zinc-400 leading-snug">
          <span
            className={
              issue.severity === "error"
                ? "text-red-400"
                : issue.severity === "warn"
                  ? "text-amber-400"
                  : "text-zinc-500"
            }
          >
            [{issue.severity}]
          </span>{" "}
          t={Number(issue.time).toFixed(1)}s {issue.code}: {issue.message}
          {issue.fixHint ? (
            <span className="text-zinc-500"> → {issue.fixHint}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function formatJson(value: unknown, max = 1200): string {
  try {
    const text =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (!text) return "";
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return String(value);
  }
}

function truncateOneLine(value: unknown, max = 72): string {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as {
        ok?: boolean;
        summary?: string;
        error?: string;
      };
      if (parsed && typeof parsed === "object") {
        if (parsed.ok === false && parsed.error) text = parsed.error;
        else if (parsed.summary) text = parsed.summary;
      }
    } catch {
      /* keep raw */
    }
  }
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function ToolPartCard({
  part,
}: {
  part: Extract<AIMessagePart, { type: "tool" }>;
}) {
  const [open, setOpen] = useState(false);
  const running = part.status === "running";
  const errored = part.status === "error";
  const scorecard =
    part.name === "critique_preview" && part.result != null
      ? parseScorecard(part.result)
      : null;
  const preview =
    part.result != null
      ? truncateOneLine(part.result)
      : running
        ? "Running…"
        : "";

  return (
    <div
      className={`rounded-lg border text-[11px] ${
        running
          ? "border-sky-500/35 bg-sky-500/10"
          : errored
            ? "border-red-500/30 bg-red-950/20"
            : "border-zinc-700/70 bg-zinc-900/70"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        {running ? (
          <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border border-sky-400 border-t-transparent" />
        ) : errored ? (
          <span className="flex h-3 w-3 shrink-0 items-center justify-center rounded-full bg-red-500/20 text-[9px] text-red-400">
            !
          </span>
        ) : (
          <span className="flex h-3 w-3 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-[9px] text-emerald-400">
            ✓
          </span>
        )}
        <span
          className={`min-w-0 flex-1 truncate font-medium ${
            running ? "text-sky-300" : errored ? "text-red-300" : "text-zinc-300"
          }`}
        >
          {running ? `Running ${part.name}` : part.name}
        </span>
        {!running && preview ? (
          <span className="hidden max-w-[40%] truncate text-[10px] text-zinc-500 sm:inline">
            {preview}
          </span>
        ) : null}
        <span className="shrink-0 text-zinc-600">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-zinc-800/80 px-2.5 py-2">
          <div>
            <div className="mb-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
              Arguments
            </div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-zinc-400">
              {formatJson(part.arguments)}
            </pre>
          </div>
          {part.result != null && (
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
                Result
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-zinc-400">
                {formatJson(part.result)}
              </pre>
            </div>
          )}
        </div>
      )}

      {scorecard ? (
        <div className="px-2.5 pb-2">
          <CritiqueScorecardCard card={scorecard} />
        </div>
      ) : null}
    </div>
  );
}

function TextPartBlock({
  text,
  variant,
  streaming = false,
}: {
  text: string;
  variant: "thinking" | "reply";
  streaming?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(variant === "thinking" && text.length > 280);
  const showToggle = variant === "thinking" && text.length > 280;
  const display =
    collapsed && showToggle ? `${text.slice(0, 220).trimEnd()}…` : text;

  if (variant === "thinking") {
    return (
      <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/40 px-2.5 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
          <span className="inline-block h-1 w-1 rounded-full bg-zinc-500" />
          Reasoning summary{streaming ? "…" : ""}
        </div>
        <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-400">
          {display}
        </div>
        {showToggle ? (
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="mt-1.5 text-[10px] text-zinc-500 hover:text-zinc-300"
          >
            {collapsed ? "Show more" : "Show less"}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-zinc-200">
      {text}
    </div>
  );
}

function AssistantTimeline({
  msg,
  isStreamingMessage,
}: {
  msg: AIMessage;
  isStreamingMessage: boolean;
}) {
  let partSeq = 0;
  const parts = ensureMessageParts(msg, () => `${msg.id}-ui-${++partSeq}`);
  const showIdle = isStreamingMessage && parts.length === 0;

  return (
    <div className="flex max-w-[92%] flex-col gap-2">
      {showIdle ? (
        <div className="flex items-center gap-2 rounded-lg border border-zinc-800/80 bg-zinc-950/40 px-2.5 py-2 text-[12px] text-zinc-400">
          <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-zinc-400 border-t-transparent" />
          Planning…
        </div>
      ) : null}

      {parts.map((part) => {
        if (part.type === "tool") {
          return <ToolPartCard key={part.id} part={part} />;
        }

        if (part.type === "phase") {
          return (
            <div key={part.id} className="flex items-center gap-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
              <span className="h-px flex-1 bg-zinc-800" />
              <span>{part.title}</span>
              <span className="h-px flex-1 bg-zinc-800" />
            </div>
          );
        }

        const variant = part.type === "reasoning" ? "thinking" : "reply";
        const streaming =
          (part.type === "reasoning" || part.type === "reply") &&
          part.status === "streaming";

        return (
          <TextPartBlock
            key={part.id}
            text={part.text}
            variant={variant}
            streaming={streaming}
          />
        );
      })}

      {isStreamingMessage &&
      parts.length > 0 &&
      (parts[parts.length - 1]?.type === "text" ||
        parts[parts.length - 1]?.type === "reply") ? (
        <span
          className="inline-block h-3 w-0.5 animate-pulse bg-zinc-400/70"
          aria-hidden
        />
      ) : null}
    </div>
  );
}

function MessageBubble({
  msg,
  isStreamingMessage,
}: {
  msg: AIMessage;
  isStreamingMessage: boolean;
}) {
  const isUser = msg.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-blue-600 px-3 py-2 text-[13px] leading-relaxed text-white whitespace-pre-wrap">
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <AssistantTimeline msg={msg} isStreamingMessage={isStreamingMessage} />
    </div>
  );
}

export default function AIChat() {
  const {
    messages,
    isStreaming,
    isEditLikeThisRunning,
    editLikeThisDetail,
    currentPhase,
    runUsage,
    sendMessage,
    cancelRun,
  } = useAIStore();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = isStreaming || isEditLikeThisRunning;

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, busy, scrollToBottom]);

  const handleSubmit = async () => {
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    await sendMessage(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleTextareaInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  };

  return (
    <div className="flex h-full flex-col bg-zinc-900">
      <EditLikeThis />
      <EditPlanPanel />

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <div className="mb-2 text-2xl">&#10024;</div>
            <h3 className="mb-1 text-sm font-medium text-zinc-300">Tempo AI</h3>
            <p className="max-w-[200px] text-xs text-zinc-500">
              Your AI video editing assistant. Ask me to edit your timeline, add effects, text, or shapes.
            </p>
          </div>
        )}

        {messages.map((msg, index) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            isStreamingMessage={
              busy && index === messages.length - 1 && msg.role === "assistant"
            }
          />
        ))}

        <div ref={messagesEndRef} />
      </div>

      {messages.length === 0 && (
        <div className="border-t border-zinc-800 px-3 py-2">
          <p className="mb-1.5 text-[10px] uppercase tracking-wide text-zinc-500">Quick Actions</p>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_ACTIONS.map((qa) => (
              <button
                key={qa.label}
                onClick={() => sendMessage(qa.message)}
                disabled={busy}
                className="rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white disabled:opacity-50"
              >
                {qa.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-zinc-800 px-3 py-2">
        {busy ? (
          <div className="mb-2 flex items-center justify-between gap-2 text-[10px] text-zinc-500">
            <span className="min-w-0 truncate">{currentPhase || (isEditLikeThisRunning ? editLikeThisDetail : "Working") || "Working"}</span>
            {runUsage?.totalTokens != null ? (
              <span className="shrink-0">{runUsage.totalTokens.toLocaleString()} tokens</span>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleTextareaInput}
            placeholder={busy ? "AI is working..." : "Ask Tempo AI to edit your video..."}
            disabled={busy}
            rows={1}
            className="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-[13px] text-zinc-200 placeholder-zinc-500 outline-none transition-colors focus:border-blue-500 disabled:opacity-60"
          />
          {busy ? (
            <button
              type="button"
              onClick={cancelRun}
              aria-label="Stop agent"
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-700 text-white transition-colors hover:bg-zinc-600"
            >
              <span className="h-3 w-3 rounded-sm bg-white" />
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!input.trim() || busy}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
