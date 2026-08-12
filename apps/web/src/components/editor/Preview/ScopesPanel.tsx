"use client";

import { useEffect, useRef, useState } from "react";

type ScopeMode = "waveform" | "parade" | "vectorscope";

const SCOPE_SIZE = { width: 320, height: 150 };

function luminance(red: number, green: number, blue: number): number {
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function clear(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.fillStyle = "#09090b";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(161,161,170,0.18)";
  ctx.lineWidth = 1;
}

function drawWaveform(ctx: CanvasRenderingContext2D, image: ImageData) {
  const { width, height } = ctx.canvas;
  clear(ctx, width, height);
  for (let row = 0; row <= 4; row++) {
    const y = (row / 4) * (height - 1);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  const stride = Math.max(1, Math.floor(image.width / 180));
  ctx.fillStyle = "rgba(236, 253, 245, 0.11)";
  for (let y = 0; y < image.height; y += stride) {
    for (let x = 0; x < image.width; x += stride) {
      const i = (y * image.width + x) * 4;
      const luma = luminance(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!);
      const px = (x / image.width) * width;
      const py = (1 - luma / 255) * (height - 1);
      ctx.fillRect(px, py, 1.25, 1.25);
    }
  }
}

function drawParade(ctx: CanvasRenderingContext2D, image: ImageData) {
  const { width, height } = ctx.canvas;
  clear(ctx, width, height);
  const channelColors = ["rgba(248,113,113,0.10)", "rgba(74,222,128,0.10)", "rgba(96,165,250,0.10)"];
  for (let column = 1; column < 3; column++) {
    const x = (column / 3) * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let row = 0; row <= 4; row++) {
    const y = (row / 4) * (height - 1);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  const stride = Math.max(1, Math.floor(image.width / 180));
  for (let channel = 0; channel < 3; channel++) {
    ctx.fillStyle = channelColors[channel]!;
    for (let y = 0; y < image.height; y += stride) {
      for (let x = 0; x < image.width; x += stride) {
        const value = image.data[(y * image.width + x) * 4 + channel]!;
        const px = channel * (width / 3) + (x / image.width) * (width / 3);
        const py = (1 - value / 255) * (height - 1);
        ctx.fillRect(px, py, 1.25, 1.25);
      }
    }
  }
}

function drawVectorscope(ctx: CanvasRenderingContext2D, image: ImageData) {
  const { width, height } = ctx.canvas;
  clear(ctx, width, height);
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.42;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.stroke();
  const labels = [["R", 0], ["Mg", Math.PI / 3], ["B", (Math.PI * 2) / 3], ["Cy", Math.PI], ["G", (Math.PI * 4) / 3], ["Yl", (Math.PI * 5) / 3]] as const;
  ctx.font = "9px ui-monospace";
  ctx.fillStyle = "rgba(212,212,216,0.6)";
  labels.forEach(([label, angle]) => ctx.fillText(label, cx + Math.cos(angle) * (radius + 5) - 5, cy - Math.sin(angle) * (radius + 5) + 3));
  const stride = Math.max(2, Math.floor(image.width / 120));
  for (let y = 0; y < image.height; y += stride) {
    for (let x = 0; x < image.width; x += stride) {
      const i = (y * image.width + x) * 4;
      const red = image.data[i]! / 255;
      const green = image.data[i + 1]! / 255;
      const blue = image.data[i + 2]! / 255;
      const luma = luminance(red, green, blue);
      const cb = 0.564 * (blue - luma);
      const cr = 0.713 * (red - luma);
      const px = cx + cb * radius * 2.2;
      const py = cy - cr * radius * 2.2;
      ctx.fillStyle = `rgba(${Math.round(red * 255)},${Math.round(green * 255)},${Math.round(blue * 255)},0.12)`;
      ctx.fillRect(px, py, 1.5, 1.5);
    }
  }
}

function renderScope(canvas: HTMLCanvasElement, mode: ScopeMode, image: ImageData) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (mode === "waveform") drawWaveform(ctx, image);
  else if (mode === "parade") drawParade(ctx, image);
  else drawVectorscope(ctx, image);
}

/**
 * Analysis-only Canvas2D usage: samples the already rendered WebGPU preview.
 * It never participates in video compositing or export.
 */
export function ScopesPanel({ sourceCanvas, frameKey }: { sourceCanvas: HTMLCanvasElement | null; frameKey: number }) {
  const [mode, setMode] = useState<ScopeMode>("waveform");
  const [unavailable, setUnavailable] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!sourceCanvas || !canvasRef.current) return;
    let cancelled = false;
    const scopeCanvas = canvasRef.current;
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = 192;
    sampleCanvas.height = 108;
    const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!sampleCtx) return;

    void createImageBitmap(sourceCanvas)
      .then((bitmap) => {
        if (cancelled) {
          bitmap.close();
          return;
        }
        sampleCtx.drawImage(bitmap, 0, 0, sampleCanvas.width, sampleCanvas.height);
        bitmap.close();
        renderScope(scopeCanvas, mode, sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height));
        setUnavailable(false);
      })
      .catch(() => setUnavailable(true));
    return () => { cancelled = true; };
  }, [sourceCanvas, frameKey, mode]);

  return (
    <aside className="absolute bottom-2 right-2 z-10 w-80 overflow-hidden rounded border border-zinc-700/80 bg-zinc-950/95 shadow-xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-zinc-800 px-2 py-1">
        <span className="text-[9px] font-mono font-semibold uppercase tracking-wider text-zinc-300">Scopes</span>
        <div className="flex gap-1">
          {(["waveform", "parade", "vectorscope"] as ScopeMode[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setMode(item)}
              className={`rounded px-1 py-0.5 text-[9px] capitalize ${mode === item ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              {item === "vectorscope" ? "Vector" : item}
            </button>
          ))}
        </div>
      </div>
      {unavailable ? (
        <div className="flex h-[150px] items-center justify-center px-4 text-center text-[10px] text-zinc-500">Scopes are unavailable for this preview frame.</div>
      ) : (
        <canvas ref={canvasRef} width={SCOPE_SIZE.width} height={SCOPE_SIZE.height} className="block h-[150px] w-full" />
      )}
    </aside>
  );
}
