/**
 * Structured agent tool results — models must read ids from JSON, never invent UUIDs.
 * Chat UI can still show `summary`; harness stores the full string.
 */

export type ToolResultOk = {
  ok: true;
  summary: string;
  clipId?: string;
  trackId?: string;
  transitionId?: string;
  effectId?: string;
  sequenceId?: string;
  [key: string]: unknown;
};

export type ToolResultErr = {
  ok: false;
  error: string;
  code?: string;
  summary?: string;
  fixHint?: string;
  nearestClipIds?: string[];
  clipLocations?: Array<{ clipId: string; trackId: string; trackName?: string }>;
  suggestedPairs?: Array<{ clipAId: string; clipBId: string; trackId: string }>;
  [key: string]: unknown;
};

export type ToolResultPayload = ToolResultOk | ToolResultErr;

export type ToolResultOkExtras = {
  clipId?: string;
  trackId?: string;
  transitionId?: string;
  effectId?: string;
  sequenceId?: string;
  [key: string]: unknown;
};

export type ToolResultErrExtras = {
  code?: string;
  summary?: string;
  fixHint?: string;
  nearestClipIds?: string[];
  clipLocations?: Array<{ clipId: string; trackId: string; trackName?: string }>;
  suggestedPairs?: Array<{ clipAId: string; clipBId: string; trackId: string }>;
  [key: string]: unknown;
};

/** Serialize a structured tool result (JSON string for Gemini + SSE). */
export function formatToolResult(payload: ToolResultPayload): string {
  return JSON.stringify(payload);
}

export function toolOk(
  summary: string,
  ids: ToolResultOkExtras = {}
): string {
  return formatToolResult({ ...ids, ok: true, summary });
}

export function toolErr(
  error: string,
  extra: ToolResultErrExtras = {}
): string {
  return formatToolResult({
    ...extra,
    ok: false,
    error,
    summary: extra.summary ?? error,
  });
}
