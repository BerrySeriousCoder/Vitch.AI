"use client";

import { useEffect, useRef, useState } from "react";
import { createCompositor, type TempoCompositor } from "@/engine/compositor";
import { useMediaStore } from "@/stores/media.store";
import { registerFontAsset, loadFontById, ensureFontReady } from "@/lib/fonts";
import { registerLutAsset, loadLutById } from "@/lib/luts";
import type { MediaAsset, MediaMetadata, Track, Transition, FontAsset, LutAsset, Sequence, Camera3D, Light3D, DeliveryProfile, ExportBitDepth } from "@tempo/types";
import type { CompositorBackendInfo } from "@/engine/compositor/types";

export interface TempoExportPayload {
  jobId: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  backgroundColor?: string;
  deliveryProfile?: DeliveryProfile;
  exportBitDepth?: ExportBitDepth;
  allowSoftwareWebGpu?: boolean;
  apiBaseUrl: string;
  tracks: Track[];
  transitions: Transition[];
  sequences?: Sequence[];
  cameras?: Camera3D[];
  lights?: Light3D[];
  mediaAssets: Array<{
    id: string;
    type: string;
    url: string;
    name?: string;
    duration?: number | null;
    metadata?: MediaMetadata;
  }>;
  fonts: Array<{
    id: string;
    familyName: string;
    url: string;
    format: string;
  }>;
  luts: Array<{
    id: string;
    name: string;
    url: string;
    format: string;
  }>;
}

declare global {
  interface Window {
    __tempoExport?: {
      ready: boolean;
      init: (payload: TempoExportPayload) => Promise<{ ok: boolean; error?: string; backendInfo?: CompositorBackendInfo }>;
      renderAt: (t: number) => Promise<string>;
      renderRaw16At: (t: number) => Promise<string>;
      dispose: () => Promise<void>;
    };
  }
}

function absolutizeUrl(apiBase: string, url: string): string {
  if (!url) return url;
  const base = apiBase.replace(/\/$/, "");
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const parsed = new URL(url);
      if (/^(?:your-public-api-domain\.com|api\.example\.com)$/i.test(parsed.hostname)) {
        return `${base}${parsed.pathname}${parsed.search}`;
      }
    } catch {
      // Fall through to the original URL.
    }
    return url;
  }
  return url.startsWith("/") ? `${base}${url}` : `${base}/${url}`;
}

function collectTextFontTargets(tracks: Track[]): {
  fontIds: Set<string>;
  families: Set<string>;
} {
  const fontIds = new Set<string>();
  const families = new Set<string>();
  for (const track of tracks) {
    for (const clip of track.clips || []) {
      const tp = clip.textParams;
      if (!tp) continue;
      if (tp.fontId) fontIds.add(tp.fontId);
      if (tp.fontFamily) families.add(tp.fontFamily.split(",")[0]!.replace(/["']/g, "").trim());
    }
  }
  return { fontIds, families };
}

function bytesToRaw16DataUrl(bytes: Uint8Array): string {
  // 24 KiB is divisible by three, so independently encoded chunks can be
  // concatenated without intermediate base64 padding.
  const chunkSize = 24 * 1024;
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    let binary = "";
    for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]!);
    encoded += btoa(binary);
  }
  return `data:application/x-tempo-rgba64le;base64,${encoded}`;
}

/**
 * Headless export host: Playwright drives this page to capture WebGPU frames.
 * Not linked from the editor UI.
 */
export default function ExportFramePage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositorRef = useRef<TempoCompositor | null>(null);
  const tracksRef = useRef<Track[]>([]);
  const transitionsRef = useRef<Transition[]>([]);
  const sequencesRef = useRef<Sequence[]>([]);
  const camerasRef = useRef<Camera3D[]>([]);
  const lightsRef = useRef<Light3D[]>([]);
  const deliveryProfileRef = useRef<DeliveryProfile | undefined>(undefined);
  const [status, setStatus] = useState("waiting");

  useEffect(() => {
    let disposed = false;

    const renderStableFrame = async (t: number) => {
      const comp = compositorRef.current;
      if (!comp) throw new Error("Compositor not initialized");
      const maxAttempts = 40;
      let lastPending = true;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        comp.invalidate();
        const { pending } = await comp.renderFrame(
          Math.max(0, t),
          tracksRef.current,
          false,
          transitionsRef.current,
          sequencesRef.current,
          { cameras: camerasRef.current, lights: lightsRef.current, deliveryProfile: deliveryProfileRef.current }
        );
        lastPending = pending;
        if (!pending) break;
        await new Promise((resolve) => setTimeout(resolve, 40 + attempt * 15));
      }
      if (lastPending) throw new Error(`Export frame still pending at t=${t}`);
      await comp.flushGpu();
      return comp;
    };

    window.__tempoExport = {
      ready: true,
      init: async (payload) => {
        try {
          setStatus("init");
          const canvas = canvasRef.current;
          if (!canvas) return { ok: false, error: "Canvas missing" };

          if (payload.apiBaseUrl) {
            (window as unknown as { __TEMPO_API_BASE?: string }).__TEMPO_API_BASE =
              payload.apiBaseUrl;
          }

          canvas.width = payload.width;
          canvas.height = payload.height;
          if (payload.backgroundColor) {
            canvas.style.background = payload.backgroundColor;
          }

          const assets: MediaAsset[] = payload.mediaAssets.map((a) => ({
            id: a.id,
            projectId: "export",
            name: a.name || a.id,
            type: (a.type === "audio" || a.type === "image" ? a.type : "video") as MediaAsset["type"],
            url: absolutizeUrl(payload.apiBaseUrl, a.url),
            thumbnailUrl: null,
            proxyUrl: null,
            waveformUrl: null,
            duration: a.duration ?? a.metadata?.duration ?? null,
            metadata: a.metadata || { fileSize: 0, mimeType: "application/octet-stream" },
            status: "ready",
            createdAt: new Date().toISOString(),
          }));
          useMediaStore.setState({ assets });

          for (const f of payload.fonts) {
            const font: FontAsset = {
              id: f.id,
              familyName: f.familyName,
              fileName: f.familyName,
              url: absolutizeUrl(payload.apiBaseUrl, f.url),
              format: f.format as FontAsset["format"],
              createdAt: new Date().toISOString(),
            };
            registerFontAsset(font);
            await loadFontById(font.id);
          }

          const { fontIds, families } = collectTextFontTargets(payload.tracks || []);
          for (const id of fontIds) {
            await loadFontById(id);
          }
          for (const family of families) {
            await ensureFontReady(family);
          }

          for (const l of payload.luts) {
            const lut: LutAsset = {
              id: l.id,
              name: l.name,
              fileName: l.name,
              url: absolutizeUrl(payload.apiBaseUrl, l.url),
              format: "cube",
              createdAt: new Date().toISOString(),
            };
            registerLutAsset(lut);
            await loadLutById(lut.id);
          }

          tracksRef.current = payload.tracks || [];
          transitionsRef.current = payload.transitions || [];
          sequencesRef.current = payload.sequences || [];
          camerasRef.current = payload.cameras || [];
          lightsRef.current = payload.lights || [];
          deliveryProfileRef.current = payload.deliveryProfile;

          compositorRef.current?.dispose();
          const result = await createCompositor(
            canvas,
            payload.width,
            payload.height,
            payload.width,
            payload.height,
            {
              allowSoftwareFallback: payload.allowSoftwareWebGpu === true,
              workingPrecision: payload.exportBitDepth === 10 ? "float16" : "unorm8",
            }
          );
          if (disposed) return { ok: false, error: "Disposed during init" };
          if (!result.ok) return { ok: false, error: result.reason };

          compositorRef.current = result.compositor;
          setStatus("ready");
          return { ok: true, backendInfo: result.compositor.backendInfo };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setStatus(`error: ${message}`);
          return { ok: false, error: message };
        }
      },
      renderAt: async (t: number) => {
        const canvas = canvasRef.current;
        if (!canvas) throw new Error("Canvas missing");
        await renderStableFrame(t);
        return canvas.toDataURL("image/png");
      },
      renderRaw16At: async (t: number) => {
        const comp = await renderStableFrame(t);
        return bytesToRaw16DataUrl(await comp.readFrameRgba16());
      },
      dispose: async () => {
        compositorRef.current?.dispose();
        compositorRef.current = null;
        setStatus("disposed");
      },
    };

    return () => {
      disposed = true;
      compositorRef.current?.dispose();
      delete window.__tempoExport;
    };
  }, []);

  return (
    <div
      style={{
        margin: 0,
        background: "#000",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
      }}
    >
      <canvas ref={canvasRef} style={{ display: "block" }} />
      <div
        data-export-status={status}
        style={{
          position: "fixed",
          left: 0,
          bottom: 0,
          color: "#666",
          fontSize: 10,
          fontFamily: "monospace",
          padding: 4,
        }}
      >
        tempo export-frame: {status}
      </div>
    </div>
  );
}
