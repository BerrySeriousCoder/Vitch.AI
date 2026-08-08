import lottie, { type AnimationItem } from "lottie-web";

interface CachedLottie {
  animation: AnimationItem;
  canvas: HTMLCanvasElement;
  ready: Promise<void>;
}

const cache = new Map<string, CachedLottie>();

async function load(url: string, width: number, height: number, loop: boolean): Promise<CachedLottie> {
  const existing = cache.get(url);
  if (existing) return existing;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Lottie asset could not be loaded (${response.status})`);
  const animationData = await response.json();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("Lottie canvas context unavailable");
  const animation = lottie.loadAnimation({
    container: document.createElement("div"),
    renderer: "canvas",
    loop,
    autoplay: false,
    animationData,
    rendererSettings: { context, clearCanvas: true, preserveAspectRatio: "xMidYMid meet" },
  });
  const ready = new Promise<void>((resolve, reject) => {
    animation.addEventListener("DOMLoaded", () => resolve());
    animation.addEventListener("data_failed", () => reject(new Error("Invalid Lottie JSON")));
  });
  const entry = { animation, canvas, ready };
  cache.set(url, entry);
  return entry;
}

/** Rasterize a Lottie JSON frame for the shared WebGPU compositor/export host. */
export async function renderLottie(
  ctx: CanvasRenderingContext2D,
  url: string,
  timeSec: number,
  width: number,
  height: number,
  options: { loop?: boolean; speed?: number } = {}
): Promise<void> {
  const entry = await load(url, width, height, options.loop !== false);
  await entry.ready;
  const frameRate = entry.animation.frameRate || 30;
  const total = entry.animation.totalFrames || 1;
  const rawFrame = timeSec * frameRate * Math.max(0.01, options.speed ?? 1);
  const frame = options.loop === false ? Math.min(total - 1, rawFrame) : rawFrame % total;
  entry.animation.goToAndStop(frame, true);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(entry.canvas, 0, 0, width, height);
}

export function disposeLotties(): void {
  for (const entry of cache.values()) entry.animation.destroy();
  cache.clear();
}
