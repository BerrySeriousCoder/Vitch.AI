import type { Track, Clip, BlendMode, ColorCurves, CurvePoint, Effect, Levels, MediaAsset, Transition, Mask, ChromaKey, Crop, MediaLayout, HslSecondary, LiftGammaGain, PrimaryColorGrade, Sequence, TrackMatte, TrackMatteType, Transform3D, Camera3D, Light3D, PlanarTrackSample } from "@tempo/types";
import {
  findActiveTransition,
  getTransitionClipOpacity,
  getTransitionMix,
  normalizeChromaKey,
  parseKeyColorRgb,
  resolveEffectParamsAtTime,
  sourceTimeAt,
  normalizeRetimeSettings,
  isNestClip,
  isAdjustmentClip,
  resolveCropAtTime,
  sequenceLocalTime,
  normalizePrimaryColorGrade,
  normalizeHslSecondary,
  normalizeLiftGammaGain,
  normalizeLevels,
  normalizeColorCurves,
  normalizeCurvePoints,
  resolveCompositingStates,
  resolveMotionTrackAtTime,
  resolvePlanarTrackAtTime,
  normalizeRotoMatteRefinement,
  normalizeMotionBlur,
  normalizeTransform3D,
  evaluateMotionGraph,
  resolveStabilizationAtTime,
  resolveMulticamAngleAtTime,
  resolveMediaGeometry,
  resolveMediaLayoutAtTime,
  type AffineTransform,
  type ParsedCubeLut,
} from "@tempo/editor-core";
import { FrameCache } from "../../frame-cache";
import { VideoDecoder } from "../../decoder";
import { renderText } from "../../text-renderer";
import { renderShape } from "../../shape-renderer";
import { renderLottie } from "../../lottie-renderer";
import { useMediaStore } from "@/stores/media.store";
import { useUIStore } from "@/stores/ui.store";
import { resolveMediaUrl } from "@/lib/media-url";
import { resolveKeyframeValues } from "@/lib/keyframes/interpolation";
import type { TempoCompositor, Scene3DState, CompositorBackendInfo } from "../types";
import { isSoftwareWebGPUAdapter, requestWebGPUDevice } from "../webgpu-available";
import {
  LAYER_SHADER,
  BLUR_SHADER,
  COMPOSITE_SHADER,
  PRESENT_SHADER,
  GLOW_EXTRACT_SHADER,
  GLOW_COMPOSITE_SHADER,
  LUT3D_SHADER,
  POST_FX_SHADER,
  TRANSITION_MIX_SHADER,
  MASK_SHADER,
  TRACK_MATTE_SHADER,
} from "./shaders";
import { loadLutById } from "@/lib/luts";

const BLEND_MODE_INDEX: Record<BlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  difference: 6,
  exclusion: 7,
  "color-dodge": 8,
  "color-burn": 9,
  "hard-light": 10,
  "soft-light": 11,
};

function effectParams(effects: Effect[], timeInClip: number): {
  brightness: number;
  contrast: number;
  saturate: number;
  hue: number;
  grayscale: number;
  sepia: number;
  invert: number;
  blur: number;
  vignetteAmount: number;
  vignetteSoftness: number;
  grainAmount: number;
  grainSize: number;
  glowIntensity: number;
  glowThreshold: number;
  glowRadius: number;
  clarityAmount: number;
  dehazeAmount: number;
  sharpenAmount: number;
  posterizeLevels: number;
  chromaticAberration: number;
  lightLeakAmount: number;
  lightLeakPosition: number;
  lutId: string;
  lutIntensity: number;
  gradeExposure: number;
  gradeContrast: number;
  gradeSaturation: number;
  gradeTemperature: number;
  gradeTint: number;
  gradeShadows: number;
  gradeHighlights: number;
  gradeBlacks: number;
  gradeWhites: number;
  gradeVibrance: number;
  curves: ColorCurves;
  secondary: HslSecondary;
  wheels: LiftGammaGain;
  levels: Levels;
  inputColorProfile: number;
  inputExposureCompensation: number;
} {
  let brightness = 1;
  let contrast = 1;
  let saturate = 1;
  let hue = 0;
  let grayscale = 0;
  let sepia = 0;
  let invert = 0;
  let blur = 0;
  let vignetteAmount = 0;
  let vignetteSoftness = 0.5;
  let grainAmount = 0;
  let grainSize = 1;
  let glowIntensity = 0;
  let glowThreshold = 0.55;
  let glowRadius = 8;
  let clarityAmount = 0;
  let dehazeAmount = 0;
  let sharpenAmount = 0;
  let posterizeLevels = 0;
  let chromaticAberration = 0;
  let lightLeakAmount = 0;
  let lightLeakPosition = 0.2;
  let lutId = "";
  let lutIntensity = 0;
  let grade = normalizePrimaryColorGrade();
  let curves = normalizeColorCurves();
  let secondary = normalizeHslSecondary();
  let wheels = normalizeLiftGammaGain();
  let levels = normalizeLevels();
  let inputColorProfile = 0;
  let inputExposureCompensation = 0;
  for (const fx of effects) {
    if (!fx.enabled) continue;
    const params = resolveEffectParamsAtTime(fx, timeInClip);
    const v = Number(params.value ?? 0);
    switch (fx.type) {
      case "input-color-transform": {
        const profile = String(params.profile ?? "rec709");
        inputColorProfile = profile === "slog3" ? 1 : profile === "hlg" ? 2 : 0;
        inputExposureCompensation = Number(params.exposureCompensation ?? 0);
        break;
      }
      case "brightness":
        brightness = Number(params.value ?? 1);
        break;
      case "contrast":
        contrast = Number(params.value ?? 1);
        break;
      case "saturate":
        saturate = Number(params.value ?? 1);
        break;
      case "hue-rotate":
        hue = v;
        break;
      case "grayscale":
        grayscale = v;
        break;
      case "sepia":
        sepia = v;
        break;
      case "invert":
        invert = v;
        break;
      case "blur":
        blur = v;
        break;
      case "vignette":
        vignetteAmount = Number(params.amount ?? 0);
        vignetteSoftness = Number(params.softness ?? 0.5);
        break;
      case "grain":
        grainAmount = Number(params.amount ?? 0);
        grainSize = Number(params.size ?? 1);
        break;
      case "glow":
        glowIntensity = Number(params.intensity ?? 0);
        glowThreshold = Number(params.threshold ?? 0.55);
        glowRadius = Number(params.radius ?? 8);
        break;
      case "clarity":
        clarityAmount = Number(params.amount ?? 0);
        break;
      case "dehaze":
        dehazeAmount = Number(params.amount ?? 0);
        break;
      case "sharpen":
        sharpenAmount = Number(params.amount ?? 0);
        break;
      case "posterize":
        posterizeLevels = Number(params.levels ?? 8);
        break;
      case "chromatic-aberration":
        chromaticAberration = Number(params.amount ?? 0);
        break;
      case "light-leak":
        lightLeakAmount = Number(params.amount ?? 0);
        lightLeakPosition = Number(params.position ?? 0.2);
        break;
      case "lut":
        lutId = String(params.lutId ?? "");
        lutIntensity = Number(params.intensity ?? 1);
        break;
      case "color-grade":
        grade = normalizePrimaryColorGrade(params as Partial<PrimaryColorGrade>);
        break;
      case "color-curves":
        curves = normalizeColorCurves(params);
        break;
      case "hsl-secondary":
        secondary = normalizeHslSecondary(params as Partial<HslSecondary>);
        break;
      case "lift-gamma-gain":
        wheels = normalizeLiftGammaGain(params as Partial<LiftGammaGain>);
        break;
      case "levels":
        levels = normalizeLevels(params as Partial<Levels>);
        break;
    }
  }
  return {
    brightness,
    contrast,
    saturate,
    hue,
    grayscale,
    sepia,
    invert,
    blur,
    vignetteAmount,
    vignetteSoftness,
    grainAmount,
    grainSize,
    glowIntensity,
    glowThreshold,
    glowRadius,
    clarityAmount,
    dehazeAmount,
    sharpenAmount,
    posterizeLevels,
    chromaticAberration,
    lightLeakAmount,
    lightLeakPosition,
    lutId,
    lutIntensity,
    gradeExposure: grade.exposure,
    gradeContrast: grade.contrast,
    gradeSaturation: grade.saturation,
    gradeTemperature: grade.temperature,
    gradeTint: grade.tint,
    gradeShadows: grade.shadows,
    gradeHighlights: grade.highlights,
    gradeBlacks: grade.blacks,
    gradeWhites: grade.whites,
    gradeVibrance: grade.vibrance,
    curves,
    secondary,
    wheels,
    levels,
    inputColorProfile,
    inputExposureCompensation,
  };
}

/** Packs up to eight (x,y) control points into four vec4 uniform slots. */
function packCurvePoints(points: readonly CurvePoint[]): Float32Array {
  const curve = normalizeCurvePoints(points);
  const packed = new Float32Array(16);
  for (let index = 0; index < 8; index++) {
    const point = curve[Math.min(index, curve.length - 1)]!;
    packed[index * 2] = point.x;
    packed[index * 2 + 1] = point.y;
  }
  return packed;
}

function floatToHalf(value: number): number {
  const f = Math.min(Math.max(value, 0), 65504);
  const floatView = new Float32Array(1);
  const int32View = new Int32Array(floatView.buffer);
  floatView[0] = f;
  const x = int32View[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  const mant = (x >>> 13) & 0x3ff;
  if (exp <= 0) {
    return sign;
  }
  if (exp >= 31) {
    return sign | 0x7c00;
  }
  return sign | (exp << 10) | mant;
}

function lutToRgbaBytes(
  lut: ParsedCubeLut,
  format: GPUTextureFormat
): { data: ArrayBuffer; bytesPerRow: number; size: number } {
  const size = lut.size;
  if (format === "rgba16float") {
    const bytesPerPixel = 8;
    const bytesPerRow = Math.ceil((size * bytesPerPixel) / 256) * 256;
    const u16 = new Uint16Array((bytesPerRow * size * size) / 2);
    for (let b = 0; b < size; b++) {
      for (let g = 0; g < size; g++) {
        for (let r = 0; r < size; r++) {
          const src = ((b * size + g) * size + r) * 3;
          const dst = (b * size * bytesPerRow + g * bytesPerRow) / 2 + r * 4;
          u16[dst] = floatToHalf(lut.data[src]!);
          u16[dst + 1] = floatToHalf(lut.data[src + 1]!);
          u16[dst + 2] = floatToHalf(lut.data[src + 2]!);
          u16[dst + 3] = floatToHalf(1);
        }
      }
    }
    return { data: u16.buffer, bytesPerRow, size };
  }

  const bytesPerPixel = 4;
  const bytesPerRow = Math.ceil((size * bytesPerPixel) / 256) * 256;
  const data = new Uint8Array(bytesPerRow * size * size);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const src = ((b * size + g) * size + r) * 3;
        const dst = b * size * bytesPerRow + g * bytesPerRow + r * 4;
        data[dst] = Math.round(Math.min(1, Math.max(0, lut.data[src]!)) * 255);
        data[dst + 1] = Math.round(Math.min(1, Math.max(0, lut.data[src + 1]!)) * 255);
        data[dst + 2] = Math.round(Math.min(1, Math.max(0, lut.data[src + 2]!)) * 255);
        data[dst + 3] = 255;
      }
    }
  }
  return { data: data.buffer, bytesPerRow, size };
}

/** Projective W values for a source unit square mapped to a destination quad. */
function planarPerspectiveWeights(corners: PlanarTrackSample["corners"]): [number, number, number, number] | null {
  const [p0, p1, p2, p3] = corners;
  const ax = p1.x - p2.x, ay = p1.y - p2.y;
  const bx = p3.x - p2.x, by = p3.y - p2.y;
  const cx = p0.x - p2.x, cy = p0.y - p2.y;
  const determinant = ax * by - ay * bx;
  if (Math.abs(determinant) < 0.000001) return null;
  const q1 = (cx * by - cy * bx) / determinant;
  const q3 = (ax * cy - ay * cx) / determinant;
  const q2 = q1 + q3 - 1;
  const weights: [number, number, number, number] = [1, q1, q2, q3];
  return weights.every((weight) => Number.isFinite(weight) && weight > 0.0001 && weight < 10000) ? weights : null;
}

function mat4Ortho(w: number, h: number): Float32Array {
  // Maps pixel coords (0..w, 0..h) to NDC; Y flipped for top-left origin
  return new Float32Array([
    2 / w, 0, 0, 0,
    0, -2 / h, 0, 0,
    0, 0, 1, 0,
    -1, 1, 0, 1,
  ]);
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r]! * b[c * 4 + 0]! +
        a[1 * 4 + r]! * b[c * 4 + 1]! +
        a[2 * 4 + r]! * b[c * 4 + 2]! +
        a[3 * 4 + r]! * b[c * 4 + 3]!;
    }
  }
  return o;
}

function mat4Translate(x: number, y: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]);
}

function mat4Translate3(x: number, y: number, z: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

function mat4Scale(sx: number, sy: number): Float32Array {
  return new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function mat4Scale3(sx: number, sy: number, sz: number): Float32Array {
  return new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]);
}

function mat4RotateX(deg: number): Float32Array {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r); const s = Math.sin(r);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

function mat4RotateY(deg: number): Float32Array {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r); const s = Math.sin(r);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

function mat4RotateZ(deg: number): Float32Array {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function mat4FromAffine([a, b, c, d, tx, ty]: AffineTransform): Float32Array {
  return new Float32Array([a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1]);
}

/** Pixel-space perspective projection. Positive Z moves a layer toward camera. */
function mat4PixelPerspective(width: number, height: number, distance = 1600): Float32Array {
  const d = Math.max(100, distance);
  return new Float32Array([
    2 / width, 0, 0, 0,
    0, -2 / height, 0, 0,
    1 / d, -1 / d, 1, -1 / d,
    -1, 1, 0, 1,
  ]);
}

function rgbFromHex(hex: string): [number, number, number] {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] || "ffffff";
  return [parseInt(value.slice(0, 2), 16) / 255, parseInt(value.slice(2, 4), 16) / 255, parseInt(value.slice(4, 6), 16) / 255];
}

function directionFromRotation(rotation: [number, number, number]): [number, number, number] {
  const x = rotation[0] * Math.PI / 180;
  const y = rotation[1] * Math.PI / 180;
  return [-Math.sin(y), Math.sin(x) * Math.cos(y), Math.cos(x) * Math.cos(y)];
}

function halfFloatToNumber(bits: number): number {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x03ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

export class WebGPUCompositor implements TempoCompositor {
  private static canvasInitGeneration = new WeakMap<HTMLCanvasElement, number>();

  canvas: HTMLCanvasElement;
  readonly backendInfo: CompositorBackendInfo;
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private sceneFormat: GPUTextureFormat;
  private sourceTextureFormat: GPUTextureFormat;
  private width: number;
  private height: number;
  private renderWidth: number;
  private renderHeight: number;
  private frameCache: FrameCache;
  private decoder: VideoDecoder;
  private lastRenderedTime = -1;
  private lastTrackHash = "";
  private lastPlaying = false;
  private renderToken = 0;
  private disposed = false;
  private deviceLossMessage: string | null = null;
  private deviceLossListeners = new Set<(message: string) => void>();
  private renderChain: Promise<void> = Promise.resolve();
  private hasEverPresented = false;
  private lastPresentedScene: GPUTexture | null = null;

  private sampler: GPUSampler;
  private layerPipeline!: GPURenderPipeline;
  private blurPipeline!: GPURenderPipeline;
  private compositePipeline!: GPURenderPipeline;
  private presentPipeline!: GPURenderPipeline;
  private glowExtractPipeline!: GPURenderPipeline;
  private glowCompositePipeline!: GPURenderPipeline;
  private lutPipeline!: GPURenderPipeline;
  private postFxPipeline!: GPURenderPipeline;
  private transitionMixPipeline!: GPURenderPipeline;
  private maskPipeline!: GPURenderPipeline;
  private trackMattePipeline!: GPURenderPipeline;

  private quadBuffer!: GPUBuffer;
  private layerUniformBuffer!: GPUBuffer;
  private blurUniformBuffer!: GPUBuffer;
  private compUniformBuffer!: GPUBuffer;
  private glowUniformBuffer!: GPUBuffer;
  private lutUniformBuffer!: GPUBuffer;
  private postFxUniformBuffer!: GPUBuffer;
  private transitionMixUniformBuffer!: GPUBuffer;
  private maskUniformBuffer!: GPUBuffer;
  private trackMatteUniformBuffer!: GPUBuffer;

  private sceneTextures: GPUTexture[] = [];
  private nestSceneTextures: GPUTexture[] = [];
  private layerTexture!: GPUTexture;
  private blurTexture!: GPUTexture;
  private fxTempTexture!: GPUTexture;
  private mixATexture!: GPUTexture;
  private mixBTexture!: GPUTexture;
  private resolvedCompositing = new Map<string, { matrix: AffineTransform; opacity: number }>();
  private sequences: Sequence[] = [];
  private renderDepth = 0;
  private scene3D: Scene3DState = {};
  private lutTextureCache = new Map<string, GPUTexture>();
  private lutTextureFormat: GPUTextureFormat = "rgba8unorm";
  private missingLutWarned = new Set<string>();
  private grainTimeSec = 0;
  private rasterCanvas: OffscreenCanvas | HTMLCanvasElement;
  private rasterCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private retimeCanvas: OffscreenCanvas | HTMLCanvasElement;
  private retimeCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private orientationCanvas: OffscreenCanvas | HTMLCanvasElement;
  private orientationCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private reusableSourceTextures = new WeakMap<object, { texture: GPUTexture; width: number; height: number }>();
  private reusableSourceTextureResources = new Set<GPUTexture>();

  private constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    width: number,
    height: number,
    renderWidth: number,
    renderHeight: number,
    backendInfo: CompositorBackendInfo,
    sceneFormat: GPUTextureFormat
  ) {
    this.canvas = canvas;
    this.backendInfo = backendInfo;
    this.device = device;
    this.context = context;
    this.format = format;
    this.sceneFormat = sceneFormat;
    // Browser external-image copies are consistently supported for RGBA8.
    // High precision starts at the layer render target and is retained through
    // every following composition/effect pass.
    this.sourceTextureFormat = "rgba8unorm";
    this.width = width;
    this.height = height;
    this.renderWidth = renderWidth;
    this.renderHeight = renderHeight;
    this.frameCache = new FrameCache(60);
    this.decoder = new VideoDecoder(this.frameCache);

    device.addEventListener("uncapturederror", (event) => {
      console.error("[Compositor] GPU uncaptured error:", (event as GPUUncapturedErrorEvent).error);
    });
    device.lost.then((info) => {
      if (this.disposed || info.reason === "destroyed") return;
      const detail = info.message || `reason: ${info.reason || "unknown"}`;
      this.deviceLossMessage = detail;
      console.error("[Compositor] GPU device lost:", detail, "reason:", info.reason);
      for (const listener of this.deviceLossListeners) listener(detail);
    });

    if (typeof OffscreenCanvas !== "undefined") {
      this.rasterCanvas = new OffscreenCanvas(renderWidth, renderHeight);
      this.retimeCanvas = new OffscreenCanvas(1, 1);
      this.orientationCanvas = new OffscreenCanvas(1, 1);
    } else {
      this.rasterCanvas = document.createElement("canvas");
      this.rasterCanvas.width = renderWidth;
      this.rasterCanvas.height = renderHeight;
      this.retimeCanvas = document.createElement("canvas");
      this.retimeCanvas.width = 1;
      this.retimeCanvas.height = 1;
      this.orientationCanvas = document.createElement("canvas");
      this.orientationCanvas.width = 1;
      this.orientationCanvas.height = 1;
    }
    this.rasterCtx = this.rasterCanvas.getContext("2d", {
      alpha: true,
    }) as OffscreenCanvasRenderingContext2D;
    this.retimeCtx = this.retimeCanvas.getContext("2d", {
      alpha: true,
    }) as OffscreenCanvasRenderingContext2D;
    this.orientationCtx = this.orientationCanvas.getContext("2d", {
      alpha: true,
    }) as OffscreenCanvasRenderingContext2D;

    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    });
    if (device.features.has("float16-filterable" as GPUFeatureName)) {
      this.lutTextureFormat = "rgba16float";
    }
  }

  static async create(
    canvas: HTMLCanvasElement,
    width = 1920,
    height = 1080,
    renderWidth = width,
    renderHeight = height,
    options: { allowSoftwareFallback?: boolean; workingPrecision?: "unorm8" | "float16" } = {}
  ): Promise<WebGPUCompositor> {
    const generation =
      (WebGPUCompositor.canvasInitGeneration.get(canvas) ?? 0) + 1;
    WebGPUCompositor.canvasInitGeneration.set(canvas, generation);

    const gpu = await requestWebGPUDevice(options);
    if (!gpu) {
      throw new Error("WebGPU is required for Tempo preview");
    }
    let sceneFormat: GPUTextureFormat = "rgba8unorm";
    if (options.workingPrecision === "float16") {
      if (gpu.device.features.has("float16-filterable" as GPUFeatureName)) {
        sceneFormat = "rgba16float";
      } else if (
        gpu.device.features.has("float32-filterable" as GPUFeatureName) &&
        gpu.device.features.has("float32-blendable" as GPUFeatureName)
      ) {
        // Chrome/Linux adapters commonly expose filterable+blendable float32
        // but not float16. Float32 is a higher-precision, standards-valid
        // maximum-depth fallback rather than silently returning to RGBA8.
        sceneFormat = "rgba32float";
      } else {
        gpu.device.destroy();
        throw new Error("Maximum-depth export requires filterable float16 or blendable/filterable float32 WebGPU textures");
      }
    }
    if (WebGPUCompositor.canvasInitGeneration.get(canvas) !== generation) {
      gpu.device.destroy();
      throw new DOMException(
        "Superseded WebGPU compositor initialization",
        "AbortError"
      );
    }

    canvas.width = renderWidth;
    canvas.height = renderHeight;
    const context = canvas.getContext("webgpu");
    if (!context) {
      throw new Error("Failed to get WebGPU canvas context");
    }

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
      device: gpu.device,
      format,
      alphaMode: "opaque",
    });

    const comp = new WebGPUCompositor(
      canvas,
      gpu.device,
      context,
      format,
      width,
      height,
      renderWidth,
      renderHeight,
      {
        vendor: String(gpu.adapter.info.vendor || "unknown"),
        architecture: String(gpu.adapter.info.architecture || "unknown"),
        device: String(gpu.adapter.info.device || ""),
        isFallbackAdapter: isSoftwareWebGPUAdapter(gpu.adapter.info),
      },
      sceneFormat
    );
    await comp.initPipelines();
    if (WebGPUCompositor.canvasInitGeneration.get(canvas) !== generation) {
      comp.dispose();
      throw new DOMException(
        "Superseded WebGPU compositor initialization",
        "AbortError"
      );
    }
    comp.allocTargets();
    return comp;
  }

  private async initPipelines(): Promise<void> {
    const device = this.device;

    const layerModule = device.createShaderModule({ code: LAYER_SHADER });
    const blurModule = device.createShaderModule({ code: BLUR_SHADER });
    const compModule = device.createShaderModule({ code: COMPOSITE_SHADER });
    const presentModule = device.createShaderModule({ code: PRESENT_SHADER });
    const glowExtractModule = device.createShaderModule({ code: GLOW_EXTRACT_SHADER });
    const glowCompModule = device.createShaderModule({ code: GLOW_COMPOSITE_SHADER });
    const lutModule = device.createShaderModule({ code: LUT3D_SHADER });
    const postModule = device.createShaderModule({ code: POST_FX_SHADER });
    const mixModule = device.createShaderModule({ code: TRANSITION_MIX_SHADER });
    const maskModule = device.createShaderModule({ code: MASK_SHADER });
    const trackMatteModule = device.createShaderModule({ code: TRACK_MATTE_SHADER });

    const shaderModules: Array<[string, GPUShaderModule]> = [
      ["layer", layerModule],
      ["blur", blurModule],
      ["composite", compModule],
      ["present", presentModule],
      ["glow-extract", glowExtractModule],
      ["glow-composite", glowCompModule],
      ["lut", lutModule],
      ["post-fx", postModule],
      ["transition-mix", mixModule],
      ["mask", maskModule],
      ["track-matte", trackMatteModule],
    ];
    await Promise.all(
      shaderModules.map(async ([label, module]) => {
        const info = await module.getCompilationInfo();
        const errors = info.messages.filter((message) => message.type === "error");
        if (errors.length === 0) return;
        const details = errors
          .map(
            (message) =>
              `${label}:${message.lineNum}:${message.linePos} ${message.message}`
          )
          .join("\n");
        throw new Error(`WebGPU shader compilation failed:\n${details}`);
      })
    );

    const texFormat: GPUTextureFormat = this.sceneFormat;

    this.layerPipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: {
        module: layerModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: 20,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "float32x2" },
              { shaderLocation: 2, offset: 16, format: "float32" },
            ],
          },
        ],
      },
      fragment: {
        module: layerModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: texFormat,
            blend: {
              color: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });

    this.blurPipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: blurModule, entryPoint: "vs_main" },
      fragment: {
        module: blurModule,
        entryPoint: "fs_main",
        targets: [{ format: texFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.compositePipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: compModule, entryPoint: "vs_main" },
      fragment: {
        module: compModule,
        entryPoint: "fs_main",
        targets: [{ format: texFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.trackMattePipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: trackMatteModule, entryPoint: "vs_main" },
      fragment: { module: trackMatteModule, entryPoint: "fs_main", targets: [{ format: texFormat }] },
      primitive: { topology: "triangle-list" },
    });

    this.presentPipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: presentModule, entryPoint: "vs_main" },
      fragment: {
        module: presentModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.glowExtractPipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: glowExtractModule, entryPoint: "vs_main" },
      fragment: {
        module: glowExtractModule,
        entryPoint: "fs_main",
        targets: [{ format: texFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.glowCompositePipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: glowCompModule, entryPoint: "vs_main" },
      fragment: {
        module: glowCompModule,
        entryPoint: "fs_main",
        targets: [{ format: texFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.lutPipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: lutModule, entryPoint: "vs_main" },
      fragment: {
        module: lutModule,
        entryPoint: "fs_main",
        targets: [{ format: texFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.postFxPipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: postModule, entryPoint: "vs_main" },
      fragment: {
        module: postModule,
        entryPoint: "fs_main",
        targets: [{ format: texFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.transitionMixPipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: mixModule, entryPoint: "vs_main" },
      fragment: {
        module: mixModule,
        entryPoint: "fs_main",
        targets: [{ format: texFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.maskPipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: maskModule, entryPoint: "vs_main" },
      fragment: {
        module: maskModule,
        entryPoint: "fs_main",
        targets: [{ format: texFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    // Pixel-space quad — rewritten each draw for cover rect or planar pin.
    this.quadBuffer = device.createBuffer({
      size: 6 * 5 * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.layerUniformBuffer = device.createBuffer({
      size: 768,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.blurUniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.compUniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.glowUniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.lutUniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.postFxUniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.transitionMixUniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.maskUniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.trackMatteUniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  onDeviceLost(listener: (message: string) => void): () => void {
    this.deviceLossListeners.add(listener);
    if (this.deviceLossMessage) listener(this.deviceLossMessage);
    return () => this.deviceLossListeners.delete(listener);
  }

  private allocTargets(): void {
    const { device, renderWidth: width, renderHeight: height } = this;
    for (const t of this.sceneTextures) t.destroy();
    for (const t of this.nestSceneTextures) t.destroy();
    this.layerTexture?.destroy();
    this.blurTexture?.destroy();
    this.fxTempTexture?.destroy();
    this.mixATexture?.destroy();
    this.mixBTexture?.destroy();

    const desc = (label: string): GPUTextureDescriptor => ({
      label,
      size: { width, height },
      format: this.sceneFormat,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });

    this.sceneTextures = [
      device.createTexture(desc("scene-a")),
      device.createTexture(desc("scene-b")),
    ];
    this.nestSceneTextures = [
      device.createTexture(desc("nest-scene-a")),
      device.createTexture(desc("nest-scene-b")),
    ];
    this.layerTexture = device.createTexture(desc("layer"));
    this.blurTexture = device.createTexture(desc("blur"));
    this.fxTempTexture = device.createTexture(desc("fx-temp"));
    this.mixATexture = device.createTexture(desc("mix-a"));
    this.mixBTexture = device.createTexture(desc("mix-b"));
  }

  private computeTrackHash(tracks: Track[], transitions: Transition[] = [], scene3D: Scene3DState = {}): string {
    let h = "";
    for (const t of tracks) {
      h += `${t.id}:${t.visible}:${t.solo}:${t.order}:${t.clips.length};`;
      for (const c of t.clips) {
        const fx = c.effects
          .map((e) => {
            const ekf = (e.keyframes || [])
              .map((k) => `${k.id}:${k.property}:${k.time}:${k.value}:${k.easing}`)
              .join("|");
            return `${e.id}:${e.type}:${e.enabled}:${JSON.stringify(e.params)}:ekf=${ekf}`;
          })
          .join(",");
        const kf = c.keyframes
          .map((k) => `${k.id}:${k.property}:${k.time}:${k.value}`)
          .join(",");
        const tp = c.textParams ? JSON.stringify(c.textParams) : "";
        const sp = c.shapeParams ? JSON.stringify(c.shapeParams) : "";
        h += `${c.id}:${c.startTime}:${c.duration}:${c.sourceMediaId}:${c.speed}:${c.reversed ? 1 : 0}:${c.opacity}:${c.blendMode}`;
        h += `:hold=${c.hold ? `${c.hold.at},${c.hold.durationSec}` : ""}`;
        h += `:sr=${c.speedRamp ? JSON.stringify(c.speedRamp) : ""}`;
        h += `:retime=${c.retime ? JSON.stringify(c.retime) : ""}`;
        h += `:mediaLayout=${c.mediaLayout ? JSON.stringify(c.mediaLayout) : ""}`;
        h += `:mask=${c.mask ? JSON.stringify(c.mask) : ""}`;
        h += `:ck=${c.chromaKey ? JSON.stringify(c.chromaKey) : ""}`;
        h += `:parent=${c.parentId || ""}:matte=${c.trackMatte ? JSON.stringify(c.trackMatte) : ""}:null=${c.nullLayer ? 1 : 0}`;
        h += `:motionTrack=${c.motionTrack ? JSON.stringify(c.motionTrack) : ""}`;
        h += `:planarTrack=${c.planarTrack ? JSON.stringify(c.planarTrack) : ""}`;
        h += `:stabilization=${c.stabilization ? JSON.stringify(c.stabilization) : ""}`;
        h += `:multicam=${c.multicam ? JSON.stringify(c.multicam) : ""}`;
        h += `:motionBlur=${c.motionBlur ? JSON.stringify(c.motionBlur) : ""}`;
        h += `:transform3D=${c.transform3D ? JSON.stringify(c.transform3D) : ""}`;
        h += `:motionGraph=${c.motionGraph ? JSON.stringify(c.motionGraph) : ""}`;
        h += `:layout=${c.layout ? JSON.stringify(c.layout) : ""}`;
        h += `:t=${c.transform.x},${c.transform.y},${c.transform.scaleX},${c.transform.scaleY},${c.transform.rotation}`;
        h += `:fx=${fx}:kf=${kf}:tp=${tp}:sp=${sp};`;
      }
    }
    for (const tr of transitions) {
      h += `|tx:${tr.id}:${tr.type}:${tr.duration}:${tr.clipAId}:${tr.clipBId}:${tr.allowHold ? 1 : 0}:${JSON.stringify(tr.params || {})}`;
    }
    h += `|3d:${JSON.stringify(scene3D.cameras || [])}:${JSON.stringify(scene3D.lights || [])}`;
    h += `|delivery:${JSON.stringify(scene3D.deliveryProfile || null)}`;
    return h;
  }

  private getActiveClips(track: Track, time: number): Clip[] {
    return track.clips.filter(
      (c) => time >= c.startTime && time < c.startTime + c.duration
    );
  }

  private resolveCompositingForTime(tracks: Track[], currentTime: number): void {
    const local = tracks.flatMap((track) => track.clips.map((clip) => {
      const values = resolveKeyframeValues(clip.keyframes, currentTime - clip.startTime);
      const graph = evaluateMotionGraph(clip.motionGraph, currentTime - clip.startTime);
      const stabilization = resolveStabilizationAtTime(clip.stabilization, currentTime - clip.startTime);
      return {
        clipId: clip.id,
        transform: (() => {
          const motion = resolveMotionTrackAtTime(clip.motionTrack, currentTime - clip.startTime);
          const scale = motion && clip.motionTrack?.useScale ? motion.scale : 1;
          const rotation = motion && clip.motionTrack?.useRotation ? motion.rotation : 0;
          return {
          ...clip.transform,
          x: ((values["transform.x"] as number) ?? clip.transform.x) + (graph["transform.x"] ?? 0) + (motion ? (motion.x - 0.5) * this.width : 0) + (stabilization?.offsetX ?? 0) * this.width,
          y: ((values["transform.y"] as number) ?? clip.transform.y) + (graph["transform.y"] ?? 0) + (motion ? (motion.y - 0.5) * this.height : 0) + (stabilization?.offsetY ?? 0) * this.height,
          scaleX: ((values["transform.scaleX"] as number) ?? clip.transform.scaleX) * (graph["transform.scaleX"] ?? 1) * scale * (stabilization?.cropScale ?? 1),
          scaleY: ((values["transform.scaleY"] as number) ?? clip.transform.scaleY) * (graph["transform.scaleY"] ?? 1) * scale * (stabilization?.cropScale ?? 1),
          rotation: ((values["transform.rotation"] as number) ?? clip.transform.rotation) + (graph["transform.rotation"] ?? 0) + rotation,
          };
        })(),
        opacity: ((values.opacity as number) ?? clip.opacity) * (graph.opacity ?? 1),
      };
    }));
    this.resolvedCompositing = resolveCompositingStates(tracks, local);
  }

  private trackMatteFor(
    tracks: readonly Track[],
    clip: Clip,
    currentTime: number
  ): { clip: Clip; track: Track; type: TrackMatteType } | null {
    const matte = clip.trackMatte;
    if (!matte || matte.sourceClipId === clip.id) return null;
    for (const track of tracks) {
      const source = track.clips.find((candidate) => candidate.id === matte.sourceClipId);
      if (!source || track.type === "audio" || track.type === "null" || source.nullLayer) continue;
      if (currentTime < source.startTime || currentTime >= source.startTime + source.duration) return null;
      return { clip: source, track, type: matte.type };
    }
    return null;
  }

  private matteSourceIds(tracks: readonly Track[]): Set<string> {
    const ids = new Set<string>();
    for (const track of tracks) for (const clip of track.clips) {
      if (clip.trackMatte?.sourceClipId) ids.add(clip.trackMatte.sourceClipId);
    }
    return ids;
  }

  private getAsset(sourceMediaId: string | null): MediaAsset | undefined {
    if (!sourceMediaId) return undefined;
    return useMediaStore.getState().assets.find((a) => a.id === sourceMediaId);
  }

  private getMediaUrl(sourceMediaId: string | null, playing = true): string | null {
    const asset = this.getAsset(sourceMediaId);
    const quality = useUIStore.getState().previewQuality;
    // Auto keeps playback light but resolves the original when paused, so the
    // editor doubles as a trustworthy still-frame quality check.
    const useProxy = quality === "proxy" || (quality === "auto" && playing && Boolean(asset?.proxyUrl));
    return resolveMediaUrl(useProxy ? asset?.proxyUrl : asset?.url ?? null);
  }

  /**
   * Bake container display rotation into an ordinary canvas raster.
   *
   * Chrome/ANGLE can report a rotation-tagged video as 576x1024 while its
   * WebGPU external-image upload still reads the encoded 1024x576 backing
   * surface. Canvas2D applies the container transform correctly, so this
   * boundary prevents portrait sources from becoming stretched in paused
   * preview, critique captures, and final frame exports.
   */
  private bakeDisplayOrientation(
    source: CanvasImageSource,
    asset: MediaAsset
  ): CanvasImageSource {
    const metadata = asset.metadata || { fileSize: 0, mimeType: "application/octet-stream" };
    const sourceWidth =
      "videoWidth" in source && (source as HTMLVideoElement).videoWidth
        ? (source as HTMLVideoElement).videoWidth
        : Number(metadata.displayWidth) || 0;
    const sourceHeight =
      "videoHeight" in source && (source as HTMLVideoElement).videoHeight
        ? (source as HTMLVideoElement).videoHeight
        : Number(metadata.displayHeight) || 0;
    const width = Math.max(1, Math.round(Number(metadata.displayWidth) || sourceWidth));
    const height = Math.max(1, Math.round(Number(metadata.displayHeight) || sourceHeight));

    if (this.orientationCanvas.width !== width || this.orientationCanvas.height !== height) {
      this.orientationCanvas.width = width;
      this.orientationCanvas.height = height;
    }
    this.orientationCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.orientationCtx.clearRect(0, 0, width, height);
    this.orientationCtx.drawImage(source, 0, 0, width, height);
    return this.orientationCanvas as unknown as CanvasImageSource;
  }

  clearMediaCache(): void {
    this.decoder.clearFrameCache();
    for (const texture of this.reusableSourceTextureResources) texture.destroy();
    this.reusableSourceTextureResources.clear();
    this.reusableSourceTextures = new WeakMap();
  }

  async prewarmFrames(currentTime: number, tracks: Track[], windowSec = 2): Promise<number> {
    const jobs = new Map<string, { url: string; times: number[] }>();
    const step = 0.5;
    for (const track of tracks) {
      if (track.type !== "video" || !track.visible) continue;
      for (const clip of track.clips) {
        if (!clip.sourceMediaId || isNestClip(clip) || clip.lottieParams) continue;
        const asset = this.getAsset(clip.sourceMediaId);
        if (!asset || asset.type !== "video") continue;
        const url = this.getMediaUrl(clip.sourceMediaId);
        if (!url) continue;
        const times: number[] = [];
        for (let timelineTime = currentTime; timelineTime <= currentTime + Math.max(0, windowSec) + 1e-4; timelineTime += step) {
          if (timelineTime < clip.startTime || timelineTime >= clip.startTime + clip.duration) continue;
          const mapped = sourceTimeAt(clip, timelineTime - clip.startTime);
          if (!mapped.frozen) times.push(mapped.sourceTime);
        }
        if (!times.length) continue;
        const id = clip.id;
        const existing = jobs.get(id);
        if (existing) existing.times.push(...times);
        else jobs.set(id, { url, times });
      }
    }
    const counts = await Promise.all([...jobs.entries()].map(([id, job]) => this.decoder.prewarmVideoFrames(id, job.url, job.times)));
    return counts.reduce((sum, count) => sum + count, 0);
  }

  private activeCamera(): Camera3D | null {
    return this.scene3D.cameras?.find((camera) => camera.enabled) || null;
  }

  private layerLighting(transform3D: Transform3D | null): { normal: [number, number, number]; ambient: number; direction: [number, number, number]; intensity: number; color: [number, number, number]; enabled: boolean } {
    const lights = (this.scene3D.lights || []).filter((light) => light.enabled);
    if (!transform3D || lights.length === 0) return { normal: [0, 0, 1], ambient: 1, direction: [0, 0, 1], intensity: 0, color: [1, 1, 1], enabled: false };
    const rx = transform3D.rotationX * Math.PI / 180;
    const ry = transform3D.rotationY * Math.PI / 180;
    const normal: [number, number, number] = [Math.sin(ry), -Math.sin(rx) * Math.cos(ry), Math.cos(rx) * Math.cos(ry)];
    let ambient = 0;
    for (const light of lights) if (light.type === "ambient") ambient += Math.max(0, light.intensity);
    const key = lights.find((light) => light.type !== "ambient");
    if (!key) return { normal, ambient, direction: [0, 0, 1], intensity: 0, color: [1, 1, 1], enabled: true };
    return { normal, ambient, direction: directionFromRotation(key.rotation), intensity: Math.max(0, key.intensity), color: rgbFromHex(key.color), enabled: true };
  }

  invalidate(): void {
    this.lastRenderedTime = -1;
    this.lastTrackHash = "";
    this.renderToken++;
  }

  clearLutTextureCache(lutId?: string): void {
    if (lutId) {
      const t = this.lutTextureCache.get(lutId);
      if (t) {
        t.destroy();
        this.lutTextureCache.delete(lutId);
      }
      this.missingLutWarned.delete(lutId);
      return;
    }
    for (const t of this.lutTextureCache.values()) t.destroy();
    this.lutTextureCache.clear();
    this.missingLutWarned.clear();
  }

  pauseMedia(): void {
    this.decoder.pauseAll();
    this.lastPlaying = false;
  }

  async renderFrame(
    currentTime: number,
    tracks: Track[],
    playing = false,
    transitions: Transition[] = [],
    sequences: Sequence[] = [],
    scene3D: Scene3DState = {}
  ): Promise<{ pending: boolean }> {
    this.sequences = sequences || [];
    this.scene3D = scene3D || {};
    // Single-flight: coalesce concurrent scrub/play renders onto one GPU path
    const run = this.renderChain.then(() =>
      this.renderFrameInternal(currentTime, tracks, playing, transitions)
    );
    this.renderChain = run.then(
      () => undefined,
      (err) => {
        console.warn("[Compositor] renderFrame error:", err);
      }
    );
    return run;
  }

  async flushGpu(): Promise<void> {
    if (this.disposed) return;
    await this.device.queue.onSubmittedWorkDone();
  }

  async readFrameRgba16(): Promise<Uint8Array> {
    if (this.disposed || !this.lastPresentedScene) {
      throw new Error("No composed frame is available for 16-bit readback");
    }
    if (this.sceneFormat !== "rgba16float" && this.sceneFormat !== "rgba32float") {
      throw new Error("16-bit readback requires a floating-point compositor");
    }

    const bytesPerComponent = this.sceneFormat === "rgba32float" ? 4 : 2;
    const bytesPerPixel = bytesPerComponent * 4;
    const rowBytes = this.renderWidth * bytesPerPixel;
    const paddedRowBytes = Math.ceil(rowBytes / 256) * 256;
    const readback = this.device.createBuffer({
      label: "export-rgba16-readback",
      size: paddedRowBytes * this.renderHeight,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.lastPresentedScene },
      { buffer: readback, bytesPerRow: paddedRowBytes, rowsPerImage: this.renderHeight },
      { width: this.renderWidth, height: this.renderHeight, depthOrArrayLayers: 1 }
    );
    this.device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);

    try {
      const mapped = readback.getMappedRange();
      const source16 = this.sceneFormat === "rgba16float" ? new Uint16Array(mapped) : undefined;
      const source32 = this.sceneFormat === "rgba32float" ? new Float32Array(mapped) : undefined;
      const sourceStride = paddedRowBytes / bytesPerComponent;
      const output = new Uint16Array(this.renderWidth * this.renderHeight * 4);
      const outputStride = this.renderWidth * 4;
      for (let y = 0; y < this.renderHeight; y++) {
        const sourceRow = y * sourceStride;
        const outputRow = y * outputStride;
        for (let x = 0; x < outputStride; x++) {
          const value = source32
            ? source32[sourceRow + x]!
            : halfFloatToNumber(source16![sourceRow + x]!);
          output[outputRow + x] = Number.isFinite(value)
            ? Math.round(Math.max(0, Math.min(1, value)) * 65535)
            : 0;
        }
      }
      return new Uint8Array(output.buffer);
    } finally {
      readback.unmap();
      readback.destroy();
    }
  }

  private async renderFrameInternal(
    currentTime: number,
    tracks: Track[],
    playing = false,
    transitions: Transition[] = []
  ): Promise<{ pending: boolean }> {
    if (this.disposed) return { pending: false };

    // The hash protects paused-frame memoization only. Rebuilding a serialized
    // project hash on every playback frame is pure main-thread overhead.
    const trackHash = playing ? "" : this.computeTrackHash(tracks, transitions, this.scene3D);
    if (
      !playing &&
      currentTime === this.lastRenderedTime &&
      trackHash === this.lastTrackHash &&
      !this.lastPlaying
    ) {
      return { pending: false };
    }

    if (!playing && this.lastPlaying) {
      this.decoder.pauseAll();
    }
    this.lastPlaying = playing;

    const token = ++this.renderToken;
    const { renderWidth, renderHeight } = this;

    if (
      this.rasterCanvas.width !== renderWidth ||
      this.rasterCanvas.height !== renderHeight
    ) {
      this.rasterCanvas.width = renderWidth;
      this.rasterCanvas.height = renderHeight;
      this.allocTargets();
    }

    // Clear scene A to transparent black
    let sceneIdx = 0;
    this.clearTexture(this.sceneTextures[0]!, [0, 0, 0, 0]);

    const sortedTracks = [...tracks].sort((a, b) => a.order - b.order);
    this.resolveCompositingForTime(tracks, currentTime);
    const matteSourceIds = this.matteSourceIds(tracks);
    let pendingMedia = false;
    let drawnLayerCount = 0;
    const activeLiveIds = new Set<string>();
    const anySolo = tracks.some((t) => t.solo);

    for (const track of sortedTracks) {
      if (!track.visible) continue;
      if (anySolo && !track.solo) continue;
      if (track.type === "audio") continue;

      const candidateTx = findActiveTransition(
        transitions,
        tracks,
        track.id,
        currentTime
      );
      // A transition cannot safely consume a matte source independently. Fall
      // back to the normal compositing pass; validation keeps this visible.
      const activeTx = candidateTx &&
        (matteSourceIds.has(candidateTx.clipA.id) || matteSourceIds.has(candidateTx.clipB.id) || candidateTx.clipA.trackMatte || candidateTx.clipB.trackMatte)
        ? null
        : candidateTx;
      const skipIds = new Set<string>();
      if (activeTx) {
        skipIds.add(activeTx.clipA.id);
        skipIds.add(activeTx.clipB.id);
        const mix = getTransitionMix(
          activeTx.transition.type,
          activeTx.progress,
          (activeTx.transition.params || {}) as Record<
            string,
            number | string | boolean
          >
        );

        if (mix.mode === "geometric") {
          const drawnA = await this.renderOneClip({
            clip: activeTx.clipA,
            track,
            currentTime,
            token,
            sceneIdx,
            opacityMul: 1,
            playing,
            activeLiveIds,
            skipSceneComposite: true,
          });
          if (token !== this.renderToken) return { pending: true };
          if (drawnA.ok) this.copyTex(this.layerTexture, this.mixATexture);
          if (drawnA.pending) pendingMedia = true;

          const drawnB = await this.renderOneClip({
            clip: activeTx.clipB,
            track,
            currentTime,
            token,
            sceneIdx,
            opacityMul: 1,
            playing,
            activeLiveIds,
            skipSceneComposite: true,
          });
          if (token !== this.renderToken) return { pending: true };
          if (drawnB.ok) this.copyTex(this.layerTexture, this.mixBTexture);
          if (drawnB.pending) pendingMedia = true;

          if (drawnA.ok || drawnB.ok) {
            if (!drawnA.ok) this.clearTexture(this.mixATexture, [0, 0, 0, 0]);
            if (!drawnB.ok) this.clearTexture(this.mixBTexture, [0, 0, 0, 0]);
            this.runGeometricTransitionMix(mix);
            // Composite mixed layer onto scene
            const readScene = this.sceneTextures[sceneIdx]!;
            const writeScene = this.sceneTextures[1 - sceneIdx]!;
            const compData = new Float32Array([0, 1, 0, 0]);
            this.device.queue.writeBuffer(this.compUniformBuffer, 0, compData);
            const compBind = this.device.createBindGroup({
              layout: this.compositePipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: this.compUniformBuffer } },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: readScene.createView() },
                { binding: 3, resource: this.layerTexture.createView() },
              ],
            });
            const encoder = this.device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
              colorAttachments: [
                {
                  view: writeScene.createView(),
                  loadOp: "clear",
                  clearValue: [0, 0, 0, 0],
                  storeOp: "store",
                },
              ],
            });
            pass.setPipeline(this.compositePipeline);
            pass.setBindGroup(0, compBind);
            pass.draw(3);
            pass.end();
            this.device.queue.submit([encoder.finish()]);
            sceneIdx = 1 - sceneIdx;
            drawnLayerCount++;
          }
        } else {
          for (const which of ["A", "B"] as const) {
            const clip = which === "A" ? activeTx.clipA : activeTx.clipB;
            const mul = getTransitionClipOpacity(
              activeTx.transition.type,
              activeTx.progress,
              which,
              (activeTx.transition.params || {}) as Record<
                string,
                number | string | boolean
              >
            );
            if (mul < 0.001) continue;
            const drawn = await this.renderOneClip({
              clip,
              track,
              currentTime,
              token,
              sceneIdx,
              opacityMul: mul,
              playing,
              activeLiveIds,
            });
            if (token !== this.renderToken) return { pending: true };
            if (drawn.ok) {
              sceneIdx = 1 - sceneIdx;
              drawnLayerCount++;
            }
            if (drawn.pending) pendingMedia = true;
          }
        }
      }

      for (const clip of this.getActiveClips(track, currentTime)) {
        if (token !== this.renderToken) return { pending: true };
        if (skipIds.has(clip.id) || matteSourceIds.has(clip.id) || track.type === "null" || clip.nullLayer) continue;

        const drawn = await this.renderClipWithMatte({
          clip,
          track,
          tracks,
          currentTime,
          token,
          sceneIdx,
          opacityMul: 1,
          playing,
          activeLiveIds,
        });
        if (token !== this.renderToken) return { pending: true };
        if (drawn.ok) {
          sceneIdx = 1 - sceneIdx;
          drawnLayerCount++;
        }
        if (drawn.pending) pendingMedia = true;
      }
    }

    if (playing) {
      this.decoder.releaseInactive(activeLiveIds);
    }

    if (token !== this.renderToken || this.disposed) {
      return { pending: true };
    }

    // Don't present an empty cleared scene when clips exist but all are
    // pending/failed — keep the last good frame on canvas (Canvas2D parity).
    if (drawnLayerCount === 0 && pendingMedia && this.hasEverPresented) {
      this.lastRenderedTime = -1;
      return { pending: true };
    }

    this.present(this.sceneTextures[sceneIdx]!);
    this.hasEverPresented = true;

    if (!playing) {
      if (!pendingMedia) {
        this.lastRenderedTime = currentTime;
        this.lastTrackHash = trackHash;
      } else {
        this.lastRenderedTime = -1;
      }
    }

    return { pending: pendingMedia };
  }

  /**
   * Compose a nested sequence into nestSceneTextures (depth already incremented).
   * Temporarily redirects sceneTextures so drawClipLayer composites onto the nest.
   */
  private async composeSequenceToNest(
    localT: number,
    tracks: Track[],
    transitions: Transition[],
    token: number,
    playing: boolean
  ): Promise<{ texture: GPUTexture; pending: boolean } | null> {
    if (this.disposed || this.nestSceneTextures.length < 2) return null;

    const savedScenes = this.sceneTextures;
    const savedCompositing = this.resolvedCompositing;
    this.sceneTextures = this.nestSceneTextures;
    this.clearTexture(this.nestSceneTextures[0]!, [0, 0, 0, 0]);

    try {
      let sceneIdx = 0;
      let pendingMedia = false;
      const activeLiveIds = new Set<string>();
      this.resolveCompositingForTime(tracks, localT);
      const matteSourceIds = this.matteSourceIds(tracks);
      const anySolo = tracks.some((t) => t.solo);
      const sortedTracks = [...tracks].sort((a, b) => a.order - b.order);

      for (const track of sortedTracks) {
        if (!track.visible) continue;
        if (anySolo && !track.solo) continue;
        if (track.type === "audio") continue;

        const candidateTx = findActiveTransition(
          transitions,
          tracks,
          track.id,
          localT
        );
        const activeTx = candidateTx &&
          (matteSourceIds.has(candidateTx.clipA.id) || matteSourceIds.has(candidateTx.clipB.id) || candidateTx.clipA.trackMatte || candidateTx.clipB.trackMatte)
          ? null
          : candidateTx;
        const skipIds = new Set<string>();
        if (activeTx) {
          skipIds.add(activeTx.clipA.id);
          skipIds.add(activeTx.clipB.id);
          const mix = getTransitionMix(
            activeTx.transition.type,
            activeTx.progress,
            (activeTx.transition.params || {}) as Record<
              string,
              number | string | boolean
            >
          );

          if (mix.mode === "geometric") {
            const drawnA = await this.renderOneClip({
              clip: activeTx.clipA,
              track,
              currentTime: localT,
              token,
              sceneIdx,
              opacityMul: 1,
              playing,
              activeLiveIds,
              skipSceneComposite: true,
            });
            if (token !== this.renderToken) return null;
            if (drawnA.ok) this.copyTex(this.layerTexture, this.mixATexture);
            if (drawnA.pending) pendingMedia = true;

            const drawnB = await this.renderOneClip({
              clip: activeTx.clipB,
              track,
              currentTime: localT,
              token,
              sceneIdx,
              opacityMul: 1,
              playing,
              activeLiveIds,
              skipSceneComposite: true,
            });
            if (token !== this.renderToken) return null;
            if (drawnB.ok) this.copyTex(this.layerTexture, this.mixBTexture);
            if (drawnB.pending) pendingMedia = true;

            this.runGeometricTransitionMix(mix);
            const readScene = this.sceneTextures[sceneIdx]!;
            const writeScene = this.sceneTextures[1 - sceneIdx]!;
            const compData = new Float32Array([0, 1, 0, 0]);
            this.device.queue.writeBuffer(this.compUniformBuffer, 0, compData);
            const compBind = this.device.createBindGroup({
              layout: this.compositePipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: this.compUniformBuffer } },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: readScene.createView() },
                { binding: 3, resource: this.layerTexture.createView() },
              ],
            });
            {
              const encoder = this.device.createCommandEncoder();
              const pass = encoder.beginRenderPass({
                colorAttachments: [
                  {
                    view: writeScene.createView(),
                    loadOp: "clear",
                    clearValue: [0, 0, 0, 0],
                    storeOp: "store",
                  },
                ],
              });
              pass.setPipeline(this.compositePipeline);
              pass.setBindGroup(0, compBind);
              pass.draw(3);
              pass.end();
              this.device.queue.submit([encoder.finish()]);
            }
            sceneIdx = 1 - sceneIdx;
          } else {
            for (const which of ["A", "B"] as const) {
              const clip = which === "A" ? activeTx.clipA : activeTx.clipB;
              const mul = getTransitionClipOpacity(
                activeTx.transition.type,
                activeTx.progress,
                which,
                (activeTx.transition.params || {}) as Record<
                  string,
                  number | string | boolean
                >
              );
              if (mul < 0.001) continue;
              const drawn = await this.renderOneClip({
                clip,
                track,
                currentTime: localT,
                token,
                sceneIdx,
                opacityMul: mul,
                playing,
                activeLiveIds,
              });
              if (token !== this.renderToken) return null;
              if (drawn.ok) sceneIdx = 1 - sceneIdx;
              if (drawn.pending) pendingMedia = true;
            }
          }
        }

        for (const clip of this.getActiveClips(track, localT)) {
          if (token !== this.renderToken) return null;
          if (skipIds.has(clip.id) || matteSourceIds.has(clip.id) || track.type === "null" || clip.nullLayer) continue;
          const drawn = await this.renderClipWithMatte({
            clip,
            track,
            tracks,
            currentTime: localT,
            token,
            sceneIdx,
            opacityMul: 1,
            playing,
            activeLiveIds,
          });
          if (token !== this.renderToken) return null;
          if (drawn.ok) sceneIdx = 1 - sceneIdx;
          if (drawn.pending) pendingMedia = true;
        }
      }

      const texture = this.sceneTextures[sceneIdx]!;
      return { texture, pending: pendingMedia };
    } finally {
      this.sceneTextures = savedScenes;
      this.resolvedCompositing = savedCompositing;
    }
  }

  private async renderOneClip(args: {
    clip: Clip;
    track: Track;
    currentTime: number;
    token: number;
    sceneIdx: number;
    opacityMul: number;
    playing: boolean;
    activeLiveIds: Set<string>;
    /** When true, leave result in layerTexture and skip scene composite */
    skipSceneComposite?: boolean;
  }): Promise<{ ok: boolean; pending: boolean }> {
    const { clip: inputClip, track, currentTime, token, sceneIdx, opacityMul, playing, activeLiveIds } =
      args;
    const multicamAngle = resolveMulticamAngleAtTime(inputClip.multicam, currentTime - inputClip.startTime);
    // Keep timing/keyframes on the multicam container while resolving only its source media.
    const clip = multicamAngle
      ? { ...inputClip, sourceMediaId: multicamAngle.sourceMediaId, sourceOffset: multicamAngle.sourceOffset }
      : inputClip;
    const width = this.width;
    const height = this.height;

    const timeInClip = currentTime - clip.startTime;
    const kfValues = resolveKeyframeValues(clip.keyframes, timeInClip);
    const resolvedCompositing = this.resolvedCompositing.get(clip.id);
    const opacity =
      (resolvedCompositing?.opacity ?? (kfValues["opacity"] as number) ?? clip.opacity) * opacityMul;
    const tx = (kfValues["transform.x"] as number) ?? clip.transform.x;
    const ty = (kfValues["transform.y"] as number) ?? clip.transform.y;
    const sx = (kfValues["transform.scaleX"] as number) ?? clip.transform.scaleX;
    const sy = (kfValues["transform.scaleY"] as number) ?? clip.transform.scaleY;
    const rot =
      (kfValues["transform.rotation"] as number) ?? clip.transform.rotation;
    const ax = clip.transform.anchorX;
    const ay = clip.transform.anchorY;
    const crop = resolveCropAtTime(clip.crop, clip.keyframes, timeInClip);
    const mediaLayout = resolveMediaLayoutAtTime(clip.mediaLayout, clip.keyframes, timeInClip);
    const blur = normalizeMotionBlur(clip.motionBlur);
    const previousTime = Math.max(0, timeInClip - 1 / 60);
    const previousValues = resolveKeyframeValues(clip.keyframes, previousTime);
    const currentTrack = resolveMotionTrackAtTime(clip.motionTrack, timeInClip);
    const previousTrack = resolveMotionTrackAtTime(clip.motionTrack, previousTime);
    const planarTrack = resolvePlanarTrackAtTime(clip.planarTrack, timeInClip);
    const motionBlur = blur.enabled && blur.shutterAngle > 0
      ? {
          dx: tx - ((previousValues["transform.x"] as number) ?? clip.transform.x) +
            ((currentTrack?.x ?? 0.5) - (previousTrack?.x ?? 0.5)) * width,
          dy: ty - ((previousValues["transform.y"] as number) ?? clip.transform.y) +
            ((currentTrack?.y ?? 0.5) - (previousTrack?.y ?? 0.5)) * height,
          radius: Math.min(24, (blur.shutterAngle / 180) * Math.max(1, Math.min(blur.samples, 12))),
        }
      : null;

    const elapsed = currentTime - clip.startTime;

    // Adjustment layers sample the already composited scene below this track.
    // Their normal effect stack is then applied to that full-frame texture,
    // keeping preview semantics identical to the Chromium frame-export path.
    if (isAdjustmentClip(clip, track)) {
      const fx = effectParams(clip.effects, timeInClip);
      const ok = await this.drawClipLayer({
        source: this.rasterCanvas as unknown as CanvasImageSource,
        gpuSource: this.sceneTextures[sceneIdx]!,
        gpuSourceSize: { w: width, h: height },
        opacity,
        tx: 0,
        ty: 0,
        sx: 1,
        sy: 1,
        rot: 0,
        ax: 0,
        ay: 0,
        fx,
        blendMode: "normal",
        sceneIdx,
        isRasterFullFrame: true,
        token,
        currentTime,
        skipSceneComposite: args.skipSceneComposite,
        mask: clip.mask,
        chromaKey: null,
        crop,
        worldTransform: resolvedCompositing?.matrix,
        motionBlur,
        transform3D: clip.transform3D,
      });
      if (token !== this.renderToken) return { ok: false, pending: true };
      return { ok, pending: !ok };
    }

    // Nested sequence → compose into nest scene, then treat as full-frame layer
    if (isNestClip(clip) && clip.sourceSequenceId) {
      if (this.renderDepth >= 1) return { ok: false, pending: false };
      const seq = this.sequences.find((s) => s.id === clip.sourceSequenceId);
      if (!seq) return { ok: false, pending: false };
      const localT = sequenceLocalTime(clip, currentTime);
      if (!Number.isFinite(localT)) return { ok: false, pending: false };

      this.renderDepth += 1;
      let nest: { texture: GPUTexture; pending: boolean } | null = null;
      try {
        nest = await this.composeSequenceToNest(
          localT,
          seq.tracks,
          seq.transitions || [],
          token,
          playing
        );
      } finally {
        this.renderDepth -= 1;
      }
      if (token !== this.renderToken) return { ok: false, pending: true };
      if (!nest) return { ok: false, pending: false };

      const fxNest = effectParams(clip.effects, timeInClip);
      const okNest = await this.drawClipLayer({
        source: this.rasterCanvas as unknown as CanvasImageSource,
        gpuSource: nest.texture,
        gpuSourceSize: { w: width, h: height },
        opacity,
        tx,
        ty,
        sx,
        sy,
        rot,
        ax,
        ay,
        fx: fxNest,
        blendMode: clip.blendMode,
        sceneIdx,
        isRasterFullFrame: true,
        token,
        currentTime,
        skipSceneComposite: args.skipSceneComposite,
        mask: clip.mask,
        chromaKey: clip.chromaKey ?? null,
        crop,
        worldTransform: resolvedCompositing?.matrix,
        motionBlur,
        transform3D: clip.transform3D,
      });
      if (token !== this.renderToken) return { ok: false, pending: true };
      return { ok: okNest, pending: nest.pending || !okNest };
    }

    const assetForHold = this.getAsset(clip.sourceMediaId);
    const { sourceTime, frozen, rate } = sourceTimeAt(
      clip,
      elapsed,
      assetForHold?.duration ?? null
    );
    // decoder treats speed <= 0.05 as freeze (pause + pin currentTime)
    // Reverse or ramps: prefer frame decode (HTML video can't reverse reliably)
    const useFramePath =
      frozen ||
      rate < 0.05 ||
      clip.reversed === true ||
      (Number(clip.speed) || 1) < 0 ||
      (clip.speedRamp != null && clip.speedRamp.length >= 2) ||
      clip.retime?.interpolation === "frame-blend";
    const effectiveSpeed = frozen || rate < 0.05 ? 0 : rate;
    const url = clip.generatedMediaUrl ? resolveMediaUrl(clip.generatedMediaUrl) : this.getMediaUrl(clip.sourceMediaId, playing);

    let source: CanvasImageSource | null = null;
    let bakeOrientationAsset: MediaAsset | null = null;

    if (clip.lottieParams) {
      const lottieUrl = this.getMediaUrl(clip.lottieParams.assetId, playing);
      if (!lottieUrl) return { ok: false, pending: false };
      this.rasterCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.rasterCtx.clearRect(0, 0, this.renderWidth, this.renderHeight);
      try {
        await renderLottie(this.rasterCtx as CanvasRenderingContext2D, lottieUrl, timeInClip, this.renderWidth, this.renderHeight, clip.lottieParams);
      } catch (error) {
        console.warn("[Tempo] Lottie render failed", error);
        return { ok: false, pending: false };
      }
      source = this.rasterCanvas as unknown as CanvasImageSource;
    } else if (track.type === "text") {
      this.rasterCtx.setTransform(this.renderWidth / width, 0, 0, this.renderHeight / height, 0, 0);
      this.rasterCtx.clearRect(0, 0, width, height);
      renderText(
        this.rasterCtx as CanvasRenderingContext2D,
        clip,
        width,
        height,
        timeInClip,
        this.scene3D.deliveryProfile
      );
      source = this.rasterCanvas as unknown as CanvasImageSource;
    } else if (track.type === "shape") {
      this.rasterCtx.setTransform(this.renderWidth / width, 0, 0, this.renderHeight / height, 0, 0);
      this.rasterCtx.clearRect(0, 0, width, height);
      renderShape(
        this.rasterCtx as CanvasRenderingContext2D,
        clip,
        width,
        height,
        this.scene3D.deliveryProfile
      );
      source = this.rasterCanvas as unknown as CanvasImageSource;
    } else if (url) {
      const asset = this.getAsset(clip.sourceMediaId);
      const originalUrl = resolveMediaUrl(asset?.url ?? null);
      const hasContainerRotation = Number(asset?.metadata?.rotation || 0) !== 0;
      // Proxies are physically rotation-normalized during ingest. Originals
      // retain metadata so their full quality is preserved and need baking.
      if (asset?.type === "video" && hasContainerRotation && originalUrl === url) {
        bakeOrientationAsset = asset;
      }
      // Each timeline instance owns a playback cursor. Sharing one element by
      // source asset made overlaps/transitions fight over currentTime.
      const decodeId = asset?.type === "image" ? (clip.sourceMediaId || clip.id) : clip.id;
      if (asset?.type === "image") {
        const img = await this.decoder.getImage(decodeId, url);
        if (token !== this.renderToken) return { ok: false, pending: true };
        source = img;
        if (!img) return { ok: false, pending: true };
      } else if (playing && !useFramePath) {
        const video = this.decoder.getLiveVideo(
          decodeId,
          url,
          sourceTime,
          effectiveSpeed
        );
        if (video) {
          activeLiveIds.add(decodeId);
          source = video;
        } else {
          return { ok: false, pending: true };
        }
      } else {
        const retime = normalizeRetimeSettings(clip.retime);
        const shouldFrameBlend = retime.interpolation === "frame-blend" && !frozen;
        const sampleStep = 1 / retime.frameRate;
        const sampleBase = shouldFrameBlend ? Math.floor(sourceTime / sampleStep) * sampleStep : sourceTime;
        const frame = await this.decoder.getFrame(
          decodeId,
          url,
          sampleBase,
          this.renderWidth,
          this.renderHeight,
          { preferVideoElement: Boolean(bakeOrientationAsset) }
        );
        if (token !== this.renderToken) return { ok: false, pending: true };
        source = frame;
        if (!frame) return { ok: false, pending: true };
        if (shouldFrameBlend) {
          const nextTime = Math.min(asset?.duration ? Math.max(0, asset.duration - 1 / retime.frameRate) : sourceTime + sampleStep, sampleBase + sampleStep);
          const next = await this.decoder.getFrame(
            `${decodeId}:retime-next`,
            url,
            nextTime,
            this.renderWidth,
            this.renderHeight,
            { preferVideoElement: Boolean(bakeOrientationAsset) }
          );
          if (token !== this.renderToken) return { ok: false, pending: true };
          if (next) {
            const mix = Math.max(0, Math.min(1, (sourceTime - sampleBase) / sampleStep));
            const frameWidth = "videoWidth" in frame && frame.videoWidth ? frame.videoWidth : frame.width;
            const frameHeight = "videoHeight" in frame && frame.videoHeight ? frame.videoHeight : frame.height;
            if (this.retimeCanvas.width !== frameWidth || this.retimeCanvas.height !== frameHeight) {
              this.retimeCanvas.width = frameWidth;
              this.retimeCanvas.height = frameHeight;
            }
            this.retimeCtx.clearRect(0, 0, frameWidth, frameHeight);
            this.retimeCtx.globalAlpha = 1 - mix;
            this.retimeCtx.drawImage(frame, 0, 0);
            this.retimeCtx.globalAlpha = mix;
            this.retimeCtx.drawImage(next, 0, 0);
            this.retimeCtx.globalAlpha = 1;
            source = this.retimeCanvas as unknown as CanvasImageSource;
          }
        }
      }
    }

    if (!source) return { ok: false, pending: false };
    if (bakeOrientationAsset) {
      source = this.bakeDisplayOrientation(source, bakeOrientationAsset);
    }

    const fx = effectParams(clip.effects, timeInClip);
    const ok = await this.drawClipLayer({
      source,
      opacity,
      tx,
      ty,
      sx,
      sy,
      rot,
      ax,
      ay,
      fx,
      blendMode: clip.blendMode,
      sceneIdx,
      isRasterFullFrame: Boolean(clip.lottieParams) || track.type === "text" || track.type === "shape",
      token,
      currentTime,
      skipSceneComposite: args.skipSceneComposite,
      mask: clip.mask,
      chromaKey: clip.chromaKey ?? null,
      crop,
      mediaLayout,
      worldTransform: resolvedCompositing?.matrix,
      motionBlur,
      transform3D: clip.transform3D,
      planarCorners: planarTrack?.corners,
    });
    if (token !== this.renderToken) return { ok: false, pending: true };
    return { ok, pending: !ok };
  }

  private async renderClipWithMatte(args: {
    clip: Clip;
    track: Track;
    tracks: Track[];
    currentTime: number;
    token: number;
    sceneIdx: number;
    opacityMul: number;
    playing: boolean;
    activeLiveIds: Set<string>;
    skipSceneComposite?: boolean;
  }): Promise<{ ok: boolean; pending: boolean }> {
    const matte = this.trackMatteFor(args.tracks, args.clip, args.currentTime);
    if (!args.clip.trackMatte) return this.renderOneClip(args);
    // An inactive or missing matte intentionally hides its target.
    if (!matte) return { ok: false, pending: false };

    const source = await this.renderOneClip({ ...args, skipSceneComposite: true });
    if (!source.ok || args.token !== this.renderToken) return source;
    this.copyTex(this.layerTexture, this.mixATexture);

    const matteDrawn = await this.renderOneClip({
      ...args,
      clip: matte.clip,
      track: matte.track,
      skipSceneComposite: true,
    });
    if (!matteDrawn.ok || args.token !== this.renderToken) {
      return { ok: false, pending: source.pending || matteDrawn.pending };
    }
    this.copyTex(this.layerTexture, this.mixBTexture);
    this.applyTrackMatte(args.clip.trackMatte!);

    if (args.skipSceneComposite) return { ok: true, pending: false };
    this.compositeLayer(args.sceneIdx, args.clip.blendMode);
    return { ok: true, pending: false };
  }

  private clearTexture(texture: GPUTexture, color: GPUColor): void {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          clearValue: color,
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private applyTrackMatte(trackMatte: TrackMatte): void {
    const refinement = trackMatte.refinement ? normalizeRotoMatteRefinement(trackMatte.refinement) : null;
    const packRegion = (mask: TrackMatte["garbageMask"] | undefined) => mask
      ? [mask.x, mask.y, mask.width, mask.height, mask.feather, mask.inverted ? 1 : 0, mask.opacity, mask.shape === "ellipse" ? 1 : 0]
      : [0, 0, 0, 0, 0, 0, 0, -1];
    const garbage = packRegion(trackMatte.garbageMask);
    const holdout = packRegion(trackMatte.holdoutMask);
    this.device.queue.writeBuffer(
      this.trackMatteUniformBuffer,
      0,
      new Float32Array([
        trackMatte.type === "luma" ? 1 : 0,
        refinement ? refinement.threshold : -1,
        refinement?.feather ?? 0,
        refinement?.inverted ? 1 : 0,
        refinement?.choke ?? 0,
        0, 0, 0,
        ...garbage,
        ...holdout,
      ])
    );
    const bind = this.device.createBindGroup({
      layout: this.trackMattePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.trackMatteUniformBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.mixATexture.createView() },
        { binding: 3, resource: this.mixBTexture.createView() },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.layerTexture.createView(),
        clearValue: [0, 0, 0, 0],
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(this.trackMattePipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private compositeLayer(sceneIdx: number, blendMode: BlendMode): void {
    const readScene = this.sceneTextures[sceneIdx]!;
    const writeScene = this.sceneTextures[1 - sceneIdx]!;
    this.device.queue.writeBuffer(
      this.compUniformBuffer,
      0,
      new Float32Array([BLEND_MODE_INDEX[blendMode] ?? 0, 1, 0, 0])
    );
    const bind = this.device.createBindGroup({
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.compUniformBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: readScene.createView() },
        { binding: 3, resource: this.layerTexture.createView() },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: writeScene.createView(),
        clearValue: [0, 0, 0, 0],
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(this.compositePipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private async drawClipLayer(args: {
    source: CanvasImageSource;
    /** When set, skip canvas upload and sample this texture (full-frame nest). */
    gpuSource?: GPUTexture;
    gpuSourceSize?: { w: number; h: number };
    opacity: number;
    tx: number;
    ty: number;
    sx: number;
    sy: number;
    rot: number;
    ax: number;
    ay: number;
    fx: ReturnType<typeof effectParams>;
    blendMode: BlendMode;
    sceneIdx: number;
    isRasterFullFrame: boolean;
    token: number;
    currentTime: number;
    skipSceneComposite?: boolean;
    mask?: Mask | null;
    chromaKey?: ChromaKey | null;
    crop: Crop;
    mediaLayout?: MediaLayout | null;
    worldTransform?: AffineTransform;
    /** Screen-space displacement over one 60fps frame for temporal blur. */
    motionBlur?: { dx: number; dy: number; radius: number } | null;
    transform3D?: Transform3D | null;
    /** Four normalized destination corners; forces a perspective corner pin. */
    planarCorners?: PlanarTrackSample["corners"];
  }): Promise<boolean> {
    if (this.disposed || args.token !== this.renderToken) return false;

    const { device, width, height } = this;
    let srcTex: GPUTexture;
    let uploadW: number;
    let uploadH: number;
    let ownsSrcTex = false;

    if (args.gpuSource) {
      srcTex = args.gpuSource;
      uploadW = args.gpuSourceSize?.w || width;
      uploadH = args.gpuSourceSize?.h || height;
    } else {
      const src = args.source;

      if (src instanceof HTMLVideoElement) {
        if (src.readyState < 2 || !src.videoWidth || !src.videoHeight) {
          return false;
        }
      }

      const srcW =
        "videoWidth" in src && (src as HTMLVideoElement).videoWidth
          ? (src as HTMLVideoElement).videoWidth
          : "naturalWidth" in src && (src as HTMLImageElement).naturalWidth
            ? (src as HTMLImageElement).naturalWidth
            : "width" in src
              ? Number((src as ImageBitmap | HTMLCanvasElement).width)
              : 0;
      const srcH =
        "videoHeight" in src && (src as HTMLVideoElement).videoHeight
          ? (src as HTMLVideoElement).videoHeight
          : "naturalHeight" in src && (src as HTMLImageElement).naturalHeight
            ? (src as HTMLImageElement).naturalHeight
            : "height" in src
              ? Number((src as ImageBitmap | HTMLCanvasElement).height)
              : 0;

      if (!srcW || !srcH) return false;

      uploadW = Math.max(1, Math.floor(srcW));
      uploadH = Math.max(1, Math.floor(srcH));
      // Live video/image/canvas objects are stable between frames. Reusing the
      // allocation avoids a GPU texture create/destroy cycle for every layer
      // on every playback frame. Decoded ImageBitmaps remain one-shot because
      // their LRU lifecycle is managed separately by FrameCache.
      const reusable = !(src instanceof ImageBitmap);
      let cached = reusable ? this.reusableSourceTextures.get(src as object) : undefined;
      if (cached && (cached.width !== uploadW || cached.height !== uploadH)) {
        cached.texture.destroy();
        this.reusableSourceTextureResources.delete(cached.texture);
        this.reusableSourceTextures.delete(src as object);
        cached = undefined;
      }
      if (cached) {
        srcTex = cached.texture;
      } else {
        srcTex = device.createTexture({
          size: { width: uploadW, height: uploadH },
          format: this.sourceTextureFormat,
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
        });
        if (reusable) {
          this.reusableSourceTextures.set(src as object, { texture: srcTex, width: uploadW, height: uploadH });
          this.reusableSourceTextureResources.add(srcTex);
        } else {
          ownsSrcTex = true;
        }
      }

      try {
        device.queue.copyExternalImageToTexture(
          { source: src as GPUCopyExternalImageSource },
          { texture: srcTex },
          { width: uploadW, height: uploadH }
        );
      } catch (err) {
        console.warn("[Compositor] copyExternalImageToTexture failed", {
          width: uploadW,
          height: uploadH,
          sourceType: src.constructor?.name,
          error: err,
        });
        srcTex.destroy();
        return false;
      }
    }

    if (args.token !== this.renderToken) {
      if (ownsSrcTex) srcTex.destroy();
      return false;
    }

    this.clearTexture(this.layerTexture, [0, 0, 0, 0]);

    const geometry = args.isRasterFullFrame || args.planarCorners
      ? {
          sourceUvRect: args.crop,
          destinationRect: { x: 0, y: 0, width, height },
        }
      : resolveMediaGeometry({
          sourceWidth: uploadW,
          sourceHeight: uploadH,
          compositionWidth: width,
          compositionHeight: height,
          crop: args.crop,
          mediaLayout: args.mediaLayout,
        });
    const rect = {
      x: geometry.destinationRect.x,
      y: geometry.destinationRect.y,
      w: geometry.destinationRect.width,
      h: geometry.destinationRect.height,
    };

    const x0 = rect.x;
    const y0 = rect.y;
    const x1 = rect.x + rect.w;
    const y1 = rect.y + rect.h;
    const planarWeights = args.planarCorners ? planarPerspectiveWeights(args.planarCorners) : null;
    const verts = planarWeights && args.planarCorners
      ? (() => {
          const corners = args.planarCorners!;
          const points = corners.map((corner) => [corner.x * width, corner.y * height] as const);
          const [p0, p1, p2, p3] = points;
          const [q0, q1, q2, q3] = planarWeights;
          return new Float32Array([
            p0[0], p0[1], 0, 0, q0,
            p1[0], p1[1], 1, 0, q1,
            p3[0], p3[1], 0, 1, q3,
            p3[0], p3[1], 0, 1, q3,
            p1[0], p1[1], 1, 0, q1,
            p2[0], p2[1], 1, 1, q2,
          ]);
        })()
      : new Float32Array([
          x0, y0, 0, 0, 1,
          x1, y0, 1, 0, 1,
          x0, y1, 0, 1, 1,
          x0, y1, 0, 1, 1,
          x1, y0, 1, 0, 1,
          x1, y1, 1, 1, 1,
        ]);
    device.queue.writeBuffer(this.quadBuffer, 0, verts);

    // A corner pin already owns all screen-space geometry. It intentionally
    // bypasses normal/parent/3D transforms, while color, crop, masks and blend
    // settings continue to apply to the pinned layer.
    const layer3D = planarWeights ? null : (args.transform3D ? normalizeTransform3D(args.transform3D) : null);
    const camera = layer3D ? this.activeCamera() : null;
    const cameraDistance = camera
      ? width / Math.max(0.1, 2 * Math.tan((Math.max(10, Math.min(160, camera.fov)) * Math.PI / 180) * 0.5))
      : 1600;
    let mvp = layer3D ? mat4PixelPerspective(width, height, cameraDistance) : mat4Ortho(width, height);
    if (camera) {
      mvp = mat4Multiply(mvp, mat4RotateZ(-camera.rotation[2]));
      mvp = mat4Multiply(mvp, mat4RotateY(-camera.rotation[1]));
      mvp = mat4Multiply(mvp, mat4RotateX(-camera.rotation[0]));
      mvp = mat4Multiply(mvp, mat4Translate3(-camera.position[0], -camera.position[1], -camera.position[2]));
    }
    if (planarWeights) {
      // Keep the corner positions in composition pixel space.
    } else if (args.worldTransform) {
      mvp = mat4Multiply(mvp, mat4FromAffine(args.worldTransform));
    } else {
      mvp = mat4Multiply(mvp, mat4Translate(args.tx + args.ax, args.ty + args.ay));
      mvp = mat4Multiply(mvp, mat4RotateZ(args.rot));
      mvp = mat4Multiply(mvp, mat4Scale(args.sx, args.sy));
      mvp = mat4Multiply(mvp, mat4Translate(-args.ax, -args.ay));
    }
    if (layer3D) {
      mvp = mat4Multiply(mvp, mat4Translate3(layer3D.x + layer3D.anchorX, layer3D.y + layer3D.anchorY, layer3D.z + layer3D.anchorZ));
      mvp = mat4Multiply(mvp, mat4RotateZ(layer3D.rotationZ));
      mvp = mat4Multiply(mvp, mat4RotateY(layer3D.rotationY));
      mvp = mat4Multiply(mvp, mat4RotateX(layer3D.rotationX));
      mvp = mat4Multiply(mvp, mat4Scale3(layer3D.scaleX, layer3D.scaleY, layer3D.scaleZ));
      mvp = mat4Multiply(mvp, mat4Translate3(-layer3D.anchorX, -layer3D.anchorY, -layer3D.anchorZ));
    }

    const uniform = new Float32Array(172);
    uniform.set(mvp, 0);
    uniform[16] = args.fx.brightness;
    uniform[17] = args.fx.contrast;
    uniform[18] = args.fx.saturate;
    uniform[19] = args.fx.hue;
    uniform[20] = args.fx.grayscale;
    uniform[21] = args.fx.sepia;
    uniform[22] = args.fx.invert;
    uniform[23] = Math.max(0, Math.min(1, args.opacity));
    const mask = args.mask;
    if (mask) {
      uniform[24] = mask.x;
      uniform[25] = mask.y;
      uniform[26] = mask.width;
      uniform[27] = mask.height;
      uniform[28] = mask.feather;
      uniform[29] = mask.inverted ? 1 : 0;
      uniform[30] = mask.opacity;
      uniform[31] = mask.shape === "ellipse" ? 1 : 0;
    } else {
      uniform[24] = 0;
      uniform[25] = 0;
      uniform[26] = 1;
      uniform[27] = 1;
      uniform[28] = 0;
      uniform[29] = 0;
      uniform[30] = 1;
      uniform[31] = -1; // mask off
    }
    const ck = args.chromaKey ? normalizeChromaKey(args.chromaKey) : null;
    const keyRgb = ck ? parseKeyColorRgb(ck.keyColor) : null;
    if (ck && keyRgb) {
      uniform[32] = keyRgb.r;
      uniform[33] = keyRgb.g;
      uniform[34] = keyRgb.b;
      uniform[35] = 1;
      uniform[36] = ck.similarity;
      uniform[37] = ck.smoothness;
      uniform[38] = ck.spill;
      uniform[39] = 0;
    } else {
      uniform[32] = 0;
      uniform[33] = 1;
      uniform[34] = 0;
      uniform[35] = 0;
      uniform[36] = 0.4;
      uniform[37] = 0.1;
      uniform[38] = 0.4;
      uniform[39] = 0;
    }
    uniform[40] = geometry.sourceUvRect.x;
    uniform[41] = geometry.sourceUvRect.y;
    uniform[42] = geometry.sourceUvRect.width;
    uniform[43] = geometry.sourceUvRect.height;
    uniform[44] = args.fx.gradeExposure;
    uniform[45] = args.fx.gradeContrast;
    uniform[46] = args.fx.gradeSaturation;
    uniform[47] = args.fx.gradeTemperature;
    uniform[48] = args.fx.gradeTint;
    uniform[49] = args.fx.gradeShadows;
    uniform[50] = args.fx.gradeHighlights;
    uniform[51] = args.fx.gradeBlacks;
    uniform[52] = args.fx.gradeWhites;
    uniform[53] = args.fx.gradeVibrance;
    uniform[54] = 0;
    uniform[55] = 0;
    uniform[56] = args.fx.curves.luma.length;
    uniform[57] = args.fx.curves.red.length;
    uniform[58] = args.fx.curves.green.length;
    uniform[59] = args.fx.curves.blue.length;
    uniform.set(packCurvePoints(args.fx.curves.luma), 60);
    uniform.set(packCurvePoints(args.fx.curves.red), 76);
    uniform.set(packCurvePoints(args.fx.curves.green), 92);
    uniform.set(packCurvePoints(args.fx.curves.blue), 108);
    uniform[124] = args.fx.secondary.hueCenter;
    uniform[125] = args.fx.secondary.hueRange;
    uniform[126] = args.fx.secondary.saturationMin;
    uniform[127] = args.fx.secondary.saturationMax;
    uniform[128] = args.fx.secondary.lightnessMin;
    uniform[129] = args.fx.secondary.lightnessMax;
    uniform[130] = args.fx.secondary.feather;
    uniform[131] = args.fx.secondary.hueShift;
    uniform[132] = args.fx.secondary.saturationShift;
    uniform[133] = args.fx.secondary.lightnessShift;
    uniform[134] = args.fx.secondary.mix;
    uniform[135] = 0;
    uniform[136] = args.fx.wheels.liftRed;
    uniform[137] = args.fx.wheels.liftGreen;
    uniform[138] = args.fx.wheels.liftBlue;
    uniform[139] = args.fx.wheels.liftMaster;
    uniform[140] = args.fx.wheels.gammaRed;
    uniform[141] = args.fx.wheels.gammaGreen;
    uniform[142] = args.fx.wheels.gammaBlue;
    uniform[143] = args.fx.wheels.gammaMaster;
    uniform[144] = args.fx.wheels.gainRed;
    uniform[145] = args.fx.wheels.gainGreen;
    uniform[146] = args.fx.wheels.gainBlue;
    uniform[147] = args.fx.wheels.gainMaster;
    uniform[148] = args.fx.levels.inputBlack;
    uniform[149] = args.fx.levels.inputWhite;
    uniform[150] = args.fx.levels.gamma;
    uniform[151] = args.fx.levels.outputBlack;
    uniform[152] = args.fx.levels.outputWhite;
    uniform[153] = 0;
    uniform[154] = 0;
    uniform[155] = 0;
    const lighting = this.layerLighting(layer3D);
    uniform[156] = lighting.normal[0];
    uniform[157] = lighting.normal[1];
    uniform[158] = lighting.normal[2];
    uniform[159] = lighting.ambient;
    uniform[160] = lighting.direction[0];
    uniform[161] = lighting.direction[1];
    uniform[162] = lighting.direction[2];
    uniform[163] = lighting.intensity;
    uniform[164] = lighting.color[0];
    uniform[165] = lighting.color[1];
    uniform[166] = lighting.color[2];
    uniform[167] = lighting.enabled ? 1 : 0;
    uniform[168] = args.fx.inputColorProfile;
    uniform[169] = args.fx.inputExposureCompensation;
    uniform[170] = 0;
    uniform[171] = 0;
    device.queue.writeBuffer(this.layerUniformBuffer, 0, uniform);

    const layerBind = device.createBindGroup({
      layout: this.layerPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.layerUniformBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: srcTex.createView() },
      ],
    });

    {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.layerTexture.createView(),
            clearValue: [0, 0, 0, 0],
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(this.layerPipeline);
      pass.setBindGroup(0, layerBind);
      pass.setVertexBuffer(0, this.quadBuffer);
      pass.draw(6);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }

    let layerView = this.layerTexture.createView();

    if (args.fx.blur > 0.01) {
      const radius = Math.min(args.fx.blur * Math.min(this.renderWidth / width, this.renderHeight / height), 24);
      for (const [dirX, dirY, dest] of [
        [1, 0, this.blurTexture] as const,
        [0, 1, this.layerTexture] as const,
      ]) {
        const blurData = new Float32Array([dirX, dirY, radius, 0]);
        device.queue.writeBuffer(this.blurUniformBuffer, 0, blurData);
        const srcView =
          dirX === 1 ? this.layerTexture.createView() : this.blurTexture.createView();
        const bind = device.createBindGroup({
          layout: this.blurPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.blurUniformBuffer } },
            { binding: 1, resource: this.sampler },
            { binding: 2, resource: srcView },
          ],
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: dest.createView(),
              loadOp: "clear",
              clearValue: [0, 0, 0, 0],
              storeOp: "store",
            },
          ],
        });
        pass.setPipeline(this.blurPipeline);
        pass.setBindGroup(0, bind);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
      }
      layerView = this.layerTexture.createView();
    }

    // Order: color grade → blur → glow → LUT → detail → vignette → grain
    await this.applyEscapeCssFx(args.fx, args.token, args.currentTime);
    if (args.token !== this.renderToken) {
      if (ownsSrcTex) srcTex.destroy();
      return false;
    }
    if (args.motionBlur) {
      const distance = Math.hypot(args.motionBlur.dx, args.motionBlur.dy);
      if (distance > 0.2) {
        this.runDirectionalBlur(
          this.layerTexture,
          this.fxTempTexture,
          args.motionBlur.dx / distance,
          args.motionBlur.dy / distance,
          Math.min(24, distance * args.motionBlur.radius)
        );
        this.copyTex(this.fxTempTexture, this.layerTexture);
      }
    }
    layerView = this.layerTexture.createView();

    // Mask is applied in LAYER_SHADER in clip UV (moves with transform).

    if (args.token !== this.renderToken) {
      if (ownsSrcTex) srcTex.destroy();
      return false;
    }

    if (args.skipSceneComposite) {
      if (ownsSrcTex) srcTex.destroy();
      return true;
    }

    const readScene = this.sceneTextures[args.sceneIdx]!;
    const writeScene = this.sceneTextures[1 - args.sceneIdx]!;
    const mode = BLEND_MODE_INDEX[args.blendMode] ?? 0;
    // Opacity is already baked into the layer texture alpha by the layer shader,
    // so pass 1.0 here to avoid double-multiplying.
    const compData = new Float32Array([mode, 1, 0, 0]);
    device.queue.writeBuffer(this.compUniformBuffer, 0, compData);

    const compBind = device.createBindGroup({
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.compUniformBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: readScene.createView() },
        { binding: 3, resource: layerView },
      ],
    });

    {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: writeScene.createView(),
            loadOp: "clear",
            clearValue: [0, 0, 0, 0],
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(this.compositePipeline);
      pass.setBindGroup(0, compBind);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }

    if (ownsSrcTex) srcTex.destroy();
    return true;
  }

  private applyClipMask(mask: Mask): void {
    const data = new Float32Array([
      mask.x,
      mask.y,
      mask.width,
      mask.height,
      mask.feather,
      mask.inverted ? 1 : 0,
      mask.opacity,
      mask.shape === "ellipse" ? 1 : 0,
    ]);
    this.device.queue.writeBuffer(this.maskUniformBuffer, 0, data);
    this.copyTex(this.layerTexture, this.fxTempTexture);
    const bind = this.device.createBindGroup({
      layout: this.maskPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.maskUniformBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.fxTempTexture.createView() },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.layerTexture.createView(),
          loadOp: "clear",
          clearValue: [0, 0, 0, 0],
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.maskPipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private runGeometricTransitionMix(mix: {
    kind: "wipe" | "push" | "whip" | "iris" | "zoom-smash" | "spin" | "squeeze" | "peel" | "dip-white" | "flash" | "beat-flash" | "glitch-transition" | "light-leak-transition" | "film-burn-transition";
    progress: number;
    direction: string;
    softness: number;
    blur?: number;
    centerX?: number;
    centerY?: number;
  }): void {
    const dirMap: Record<string, number> = {
      left: 0,
      right: 1,
      up: 2,
      down: 3,
    };
    const kindMap: Record<string, number> = {
      wipe: 0,
      push: 1,
      whip: 2,
      iris: 3,
      "zoom-smash": 4,
      spin: 5,
      squeeze: 6,
      peel: 7,
      "dip-white": 8,
      flash: 9,
      "beat-flash": 10,
      "glitch-transition": 11,
      "light-leak-transition": 12,
      "film-burn-transition": 13,
    };
    const softOrBlur =
      mix.kind === "whip" || mix.kind === "zoom-smash" || mix.kind === "spin" ? Number(mix.blur ?? 0.7) : Number(mix.softness ?? 0);
    const aspect = this.height > 0 ? this.width / this.height : 1;
    // std140: two vec4s
    const data = new Float32Array([
      mix.progress,
      kindMap[mix.kind] ?? 0,
      dirMap[mix.direction] ?? 0,
      softOrBlur,
      mix.centerX ?? 0.5,
      mix.centerY ?? 0.5,
      mix.kind === "whip" || mix.kind === "zoom-smash" || mix.kind === "spin" ? Number(mix.blur ?? 0.7) : 0,
      aspect,
    ]);
    this.device.queue.writeBuffer(this.transitionMixUniformBuffer, 0, data);
    const bind = this.device.createBindGroup({
      layout: this.transitionMixPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.transitionMixUniformBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.mixATexture.createView() },
        { binding: 3, resource: this.mixBTexture.createView() },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.layerTexture.createView(),
          loadOp: "clear",
          clearValue: [0, 0, 0, 0],
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.transitionMixPipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private copyTex(src: GPUTexture, dst: GPUTexture): void {
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: src },
      { texture: dst },
      { width: this.renderWidth, height: this.renderHeight }
    );
    this.device.queue.submit([encoder.finish()]);
  }

  /** A shutter-style directional integration used for animated 2D layers. */
  private runDirectionalBlur(
    src: GPUTexture,
    dest: GPUTexture,
    dx: number,
    dy: number,
    radius: number
  ): void {
    const scaleX = this.renderWidth / this.width;
    const scaleY = this.renderHeight / this.height;
    const r = Math.min(Math.max(radius * Math.min(scaleX, scaleY), 0), 24);
    this.device.queue.writeBuffer(this.blurUniformBuffer, 0, new Float32Array([dx * scaleX, dy * scaleY, r, 0]));
    const bind = this.device.createBindGroup({
      layout: this.blurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.blurUniformBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: src.createView() },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: dest.createView(),
        loadOp: "clear",
        clearValue: [0, 0, 0, 0],
        storeOp: "store",
      }],
    });
    pass.setPipeline(this.blurPipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private runSeparableBlur(src: GPUTexture, radius: number, dest: GPUTexture): void {
    const { device } = this;
    const r = Math.min(Math.max(radius * Math.min(this.renderWidth / this.width, this.renderHeight / this.height), 0), 24);
    // H: src → blurTexture, V: blurTexture → dest
    for (const [dirX, dirY, from, to] of [
      [1, 0, src, this.blurTexture] as const,
      [0, 1, this.blurTexture, dest] as const,
    ]) {
      const blurData = new Float32Array([dirX, dirY, r, 0]);
      device.queue.writeBuffer(this.blurUniformBuffer, 0, blurData);
      const bind = device.createBindGroup({
        layout: this.blurPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.blurUniformBuffer } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: from.createView() },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: to.createView(),
            loadOp: "clear",
            clearValue: [0, 0, 0, 0],
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(this.blurPipeline);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }
  }

  private async ensureLutTexture(lutId: string): Promise<GPUTexture | null> {
    const cached = this.lutTextureCache.get(lutId);
    if (cached) return cached;
    const parsed = await loadLutById(lutId);
    if (!parsed) {
      if (!this.missingLutWarned.has(lutId)) {
        this.missingLutWarned.add(lutId);
        console.warn(
          `[Tempo] LUT "${lutId}" could not be loaded — effect skipped until available`
        );
      }
      return null;
    }
    const format = this.lutTextureFormat;
    const { data, bytesPerRow, size } = lutToRgbaBytes(parsed, format);
    const texture = this.device.createTexture({
      size: [size, size, size],
      format,
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture },
      data,
      { bytesPerRow, rowsPerImage: size },
      { width: size, height: size, depthOrArrayLayers: size }
    );
    this.lutTextureCache.set(lutId, texture);
    return texture;
  }

  private async applyEscapeCssFx(
    fx: ReturnType<typeof effectParams>,
    token: number,
    currentTime: number
  ): Promise<void> {
    if (this.disposed || token !== this.renderToken) return;
    const { device } = this;

    if (fx.glowIntensity > 0.01) {
      // extract bright → fxTemp
      const extractData = new Float32Array([fx.glowThreshold, fx.glowIntensity, 0, 0]);
      device.queue.writeBuffer(this.glowUniformBuffer, 0, extractData);
      {
        const bind = device.createBindGroup({
          layout: this.glowExtractPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.glowUniformBuffer } },
            { binding: 1, resource: this.sampler },
            { binding: 2, resource: this.layerTexture.createView() },
          ],
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: this.fxTempTexture.createView(),
              loadOp: "clear",
              clearValue: [0, 0, 0, 0],
              storeOp: "store",
            },
          ],
        });
        pass.setPipeline(this.glowExtractPipeline);
        pass.setBindGroup(0, bind);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
      }
      // blur bloom into blurTexture (dest via separable: ends in blurTexture if dest=blur — wait)
      // runSeparableBlur writes final to dest; use blurTexture as dest then composite
      this.runSeparableBlur(this.fxTempTexture, fx.glowRadius, this.fxTempTexture);

      const glowComp = new Float32Array([fx.glowIntensity, 0, 0, 0]);
      device.queue.writeBuffer(this.glowUniformBuffer, 0, glowComp);
      {
        const bind = device.createBindGroup({
          layout: this.glowCompositePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.glowUniformBuffer } },
            { binding: 1, resource: this.sampler },
            { binding: 2, resource: this.layerTexture.createView() },
            { binding: 3, resource: this.fxTempTexture.createView() },
          ],
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: this.blurTexture.createView(),
              loadOp: "clear",
              clearValue: [0, 0, 0, 0],
              storeOp: "store",
            },
          ],
        });
        pass.setPipeline(this.glowCompositePipeline);
        pass.setBindGroup(0, bind);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
      }
      this.copyTex(this.blurTexture, this.layerTexture);
    }

    if (token !== this.renderToken) return;

    if (fx.lutId && fx.lutIntensity > 0.001) {
      const lutTex = await this.ensureLutTexture(fx.lutId);
      if (lutTex && token === this.renderToken) {
        const lutData = new Float32Array([fx.lutIntensity, 0, 0, 0]);
        device.queue.writeBuffer(this.lutUniformBuffer, 0, lutData);
        const bind = device.createBindGroup({
          layout: this.lutPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.lutUniformBuffer } },
            { binding: 1, resource: this.sampler },
            { binding: 2, resource: this.layerTexture.createView() },
            { binding: 3, resource: lutTex.createView() },
          ],
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: this.fxTempTexture.createView(),
              loadOp: "clear",
              clearValue: [0, 0, 0, 0],
              storeOp: "store",
            },
          ],
        });
        pass.setPipeline(this.lutPipeline);
        pass.setBindGroup(0, bind);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        this.copyTex(this.fxTempTexture, this.layerTexture);
      }
    }

    if (token !== this.renderToken) return;

    if (fx.vignetteAmount > 0.001 || fx.grainAmount > 0.001 || Math.abs(fx.clarityAmount) > 0.001 || fx.dehazeAmount > 0.001 || fx.sharpenAmount > 0.001 || fx.posterizeLevels > 1 || fx.chromaticAberration > 0.001 || fx.lightLeakAmount > 0.001) {
      this.grainTimeSec = currentTime;
      const post = new Float32Array(16);
      post[0] = fx.vignetteAmount;
      post[1] = fx.vignetteSoftness;
      post[4] = fx.grainAmount;
      post[5] = fx.grainSize;
      post[6] = this.grainTimeSec * 24;
      post[8] = fx.clarityAmount;
      post[9] = fx.dehazeAmount;
      post[10] = fx.sharpenAmount;
      post[12] = fx.posterizeLevels;
      post[13] = fx.chromaticAberration;
      post[14] = fx.lightLeakAmount;
      post[15] = fx.lightLeakPosition;
      device.queue.writeBuffer(this.postFxUniformBuffer, 0, post);
      const bind = device.createBindGroup({
        layout: this.postFxPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.postFxUniformBuffer } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this.layerTexture.createView() },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.fxTempTexture.createView(),
            loadOp: "clear",
            clearValue: [0, 0, 0, 0],
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(this.postFxPipeline);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      this.copyTex(this.fxTempTexture, this.layerTexture);
    }
  }

  private present(scene: GPUTexture): void {
    if (this.disposed) return;
    this.lastPresentedScene = scene;
    const encoder = this.device.createCommandEncoder();
    const bind = this.device.createBindGroup({
      layout: this.presentPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: scene.createView() },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          clearValue: [0, 0, 0, 1],
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.presentPipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.disposed = true;
    this.deviceLossListeners.clear();
    this.renderToken++;
    this.decoder.dispose();
    // Do not unconfigure the canvas context here. React Strict Mode and
    // resolution changes can overlap async compositor initialization; a stale
    // instance shares the canvas context and must not unconfigure the newer
    // live instance. Destroying this instance's device releases its resources.
    for (const t of this.sceneTextures) t.destroy();
    this.sceneTextures = [];
    for (const t of this.nestSceneTextures) t.destroy();
    this.nestSceneTextures = [];
    this.layerTexture?.destroy();
    this.blurTexture?.destroy();
    this.fxTempTexture?.destroy();
    this.mixATexture?.destroy();
    this.mixBTexture?.destroy();
    for (const t of this.lutTextureCache.values()) t.destroy();
    this.lutTextureCache.clear();
    for (const t of this.reusableSourceTextureResources) t.destroy();
    this.reusableSourceTextureResources.clear();
    this.reusableSourceTextures = new WeakMap();
    this.quadBuffer?.destroy();
    this.layerUniformBuffer?.destroy();
    this.blurUniformBuffer?.destroy();
    this.compUniformBuffer?.destroy();
    this.glowUniformBuffer?.destroy();
    this.lutUniformBuffer?.destroy();
    this.postFxUniformBuffer?.destroy();
    this.transitionMixUniformBuffer?.destroy();
    this.maskUniformBuffer?.destroy();
    try {
      this.device.destroy();
    } catch {
      /* ignore */
    }
  }
}
