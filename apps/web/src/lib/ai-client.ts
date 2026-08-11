import type { AgentRunEvent, EditLikeThisAudioPolicy } from "@tempo/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
  id?: string;
}

function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("tempo_access_token");
}

async function* streamSSE(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): AsyncGenerator<SSEEvent> {
  const token = getAccessToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    yield { event: "error", data: { message: text || `HTTP ${res.status}` } };
    return;
  }

  if (!res.body) {
    yield { event: "error", data: { message: "No response body" } };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const raw of events) {
      if (!raw.trim()) continue;

      let eventName = "message";
      const dataLines: string[] = [];
      let eventId: string | undefined;

      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) {
          eventName = line.slice(7).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        } else if (line.startsWith("id:")) {
          eventId = line.slice(3).trim();
        }
      }

      const dataStr = dataLines.join("\n");
      if (dataStr) {
        try {
          const data = JSON.parse(dataStr);
          yield { event: eventName, data, id: eventId };
        } catch {
          yield { event: eventName, data: { raw: dataStr }, id: eventId };
        }
      }
    }
  }

  if (buffer.trim()) {
    let eventName = "message";
    const dataLines: string[] = [];
    let eventId: string | undefined;
    for (const line of buffer.split("\n")) {
      if (line.startsWith("event: ")) eventName = line.slice(7).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      else if (line.startsWith("id:")) eventId = line.slice(3).trim();
    }
    const dataStr = dataLines.join("\n");
    if (dataStr) {
      try {
        yield { event: eventName, data: JSON.parse(dataStr), id: eventId };
      } catch {
        yield { event: eventName, data: { raw: dataStr }, id: eventId };
      }
    }
  }
}

/**
 * Stream AI chat responses via POST + ReadableStream SSE parsing.
 * EventSource doesn't support POST, so we use fetch with streaming body.
 */
export async function* streamAIChat(
  projectId: string,
  message: string,
  signal?: AbortSignal
): AsyncGenerator<AgentRunEvent> {
  let lastSequence = 0;
  for await (const event of streamSSE(`/api/projects/${projectId}/ai/chat`, { message }, signal)) {
    const value = event.data as unknown as AgentRunEvent;
    if (!value || value.protocolVersion !== 1 || value.event !== event.event) {
      throw new Error(`Unsupported agent stream event: ${event.event}`);
    }
    if (value.sequence <= lastSequence) {
      throw new Error(`Out-of-order agent event ${value.sequence} after ${lastSequence}`);
    }
    lastSequence = value.sequence;
    yield value;
  }
}

/**
 * Stream Edit-Like-This pipeline progress and results.
 */
export async function* streamEditLikeThis(
  projectId: string,
  url: string,
  audioPolicy: EditLikeThisAudioPolicy,
  signal?: AbortSignal
): AsyncGenerator<SSEEvent> {
  yield* streamSSE(
    `/api/projects/${projectId}/ai/edit-like-this`,
    { url, audioPolicy },
    signal
  );
}
