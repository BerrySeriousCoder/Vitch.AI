import type { Track, Transition, Sequence, Camera3D, Light3D, DeliveryProfile } from "@tempo/types";

export interface Scene3DState {
  cameras?: Camera3D[];
  lights?: Light3D[];
  /** Frozen composition contract used by format-aware graphic layout. */
  deliveryProfile?: DeliveryProfile;
}

export interface CompositorBackendInfo {
  vendor: string;
  architecture: string;
  device: string;
  isFallbackAdapter: boolean;
}

/** Preview compositor contract — WebGPU is the only engine. */
export interface TempoCompositor {
  readonly canvas: HTMLCanvasElement;
  readonly backendInfo: CompositorBackendInfo;
  /** Subscribe to an unrecoverable browser GPU-device loss. */
  onDeviceLost(listener: (message: string) => void): () => void;
  invalidate(): void;
  /** Drop cached 3D LUT GPU textures (call after LUT upload/delete). */
  clearLutTextureCache(lutId?: string): void;
  /** Drop decoded media frames held for paused scrubbing/playback look-ahead. */
  clearMediaCache(): void;
  pauseMedia(): void;
  /**
   * Render one frame. `pending` is true when media decode/layers were not ready
   * (caller should retry before capturing for export).
   */
  renderFrame(
    currentTime: number,
    tracks: Track[],
    playing?: boolean,
    transitions?: Transition[],
    sequences?: Sequence[],
    scene3D?: Scene3DState
  ): Promise<{ pending: boolean }>;
  /** Predecode a short source-media look-ahead window without changing the visible frame. */
  prewarmFrames(currentTime: number, tracks: Track[], windowSec?: number): Promise<number>;
  /** Wait until submitted GPU work has completed (safe canvas readback). */
  flushGpu(): Promise<void>;
  /**
   * Read the last composed frame as little-endian 16-bit normalized RGBA.
   * Available to the offline export host; preview callers normally use canvas.
   */
  readFrameRgba16(): Promise<Uint8Array>;
  dispose(): void;
}

export type CompositorInitResult =
  | { ok: true; compositor: TempoCompositor }
  | { ok: false; reason: string };
