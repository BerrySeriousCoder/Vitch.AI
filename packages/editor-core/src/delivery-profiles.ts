import type {
  DeliveryProfile,
  DeliveryProfileId,
  GraphicLayout,
  GraphicLayoutZone,
  GraphicSafetyTarget,
  LayoutValidationIssue,
  NormalizedRect,
  ProjectSettings,
  ResolvedGraphicGeometry,
  TextParams,
} from "@tempo/types";

const rect = (x: number, y: number, width: number, height: number): NormalizedRect => ({
  x,
  y,
  width,
  height,
});

const SHORT_FORM_SAFE = {
  actionSafe: rect(0.04, 0.04, 0.92, 0.92),
  titleSafe: rect(0.08, 0.1, 0.84, 0.72),
  captionSafe: rect(0.1, 0.6, 0.72, 0.18),
};

const LANDSCAPE_SAFE = {
  actionSafe: rect(0.035, 0.06, 0.93, 0.88),
  titleSafe: rect(0.07, 0.1, 0.86, 0.8),
  captionSafe: rect(0.1, 0.7, 0.8, 0.16),
};

const SQUARE_SAFE = {
  actionSafe: rect(0.05, 0.05, 0.9, 0.9),
  titleSafe: rect(0.09, 0.09, 0.82, 0.82),
  captionSafe: rect(0.1, 0.66, 0.8, 0.18),
};

const BUILTIN_PROFILES: Record<Exclude<DeliveryProfileId, "custom">, DeliveryProfile> = {
  "instagram-reel": {
    schemaVersion: 1,
    id: "instagram-reel",
    label: "Instagram Reel",
    platform: "instagram",
    width: 1080,
    height: 1920,
    fps: 30,
    orientation: "portrait",
    ...SHORT_FORM_SAFE,
    uiOcclusionZones: [
      { id: "reel-top-ui", label: "Reel top controls", rect: rect(0, 0, 1, 0.1), severity: "warning" },
      { id: "reel-right-ui", label: "Reel actions", rect: rect(0.82, 0.48, 0.18, 0.42), severity: "warning" },
      { id: "reel-bottom-ui", label: "Reel caption and controls", rect: rect(0, 0.82, 1, 0.18), severity: "warning" },
    ],
  },
  tiktok: {
    schemaVersion: 1,
    id: "tiktok",
    label: "TikTok",
    platform: "tiktok",
    width: 1080,
    height: 1920,
    fps: 30,
    orientation: "portrait",
    ...SHORT_FORM_SAFE,
    uiOcclusionZones: [
      { id: "tiktok-top-ui", label: "TikTok top controls", rect: rect(0, 0, 1, 0.1), severity: "warning" },
      { id: "tiktok-right-ui", label: "TikTok actions", rect: rect(0.82, 0.45, 0.18, 0.45), severity: "warning" },
      { id: "tiktok-bottom-ui", label: "TikTok caption and controls", rect: rect(0, 0.82, 1, 0.18), severity: "warning" },
    ],
  },
  "youtube-short": {
    schemaVersion: 1,
    id: "youtube-short",
    label: "YouTube Short",
    platform: "youtube",
    width: 1080,
    height: 1920,
    fps: 30,
    orientation: "portrait",
    ...SHORT_FORM_SAFE,
    uiOcclusionZones: [
      { id: "shorts-right-ui", label: "Shorts actions", rect: rect(0.82, 0.48, 0.18, 0.42), severity: "warning" },
      { id: "shorts-bottom-ui", label: "Shorts metadata and controls", rect: rect(0, 0.84, 1, 0.16), severity: "warning" },
    ],
  },
  "youtube-landscape": {
    schemaVersion: 1,
    id: "youtube-landscape",
    label: "YouTube Landscape",
    platform: "youtube",
    width: 1920,
    height: 1080,
    fps: 30,
    orientation: "landscape",
    ...LANDSCAPE_SAFE,
    uiOcclusionZones: [],
  },
  "instagram-square": {
    schemaVersion: 1,
    id: "instagram-square",
    label: "Instagram Square",
    platform: "instagram",
    width: 1080,
    height: 1080,
    fps: 30,
    orientation: "square",
    ...SQUARE_SAFE,
    uiOcclusionZones: [
      { id: "feed-bottom-ui", label: "Feed caption controls", rect: rect(0, 0.9, 1, 0.1), severity: "info" },
    ],
  },
  "instagram-portrait": {
    schemaVersion: 1,
    id: "instagram-portrait",
    label: "Instagram Portrait",
    platform: "instagram",
    width: 1080,
    height: 1350,
    fps: 30,
    orientation: "portrait",
    ...SQUARE_SAFE,
    uiOcclusionZones: [
      { id: "feed-bottom-ui", label: "Feed caption controls", rect: rect(0, 0.9, 1, 0.1), severity: "info" },
    ],
  },
};

function cloneProfile(profile: DeliveryProfile): DeliveryProfile {
  return JSON.parse(JSON.stringify(profile)) as DeliveryProfile;
}

export function listDeliveryProfiles(): DeliveryProfile[] {
  return Object.values(BUILTIN_PROFILES).map(cloneProfile);
}

export function getDeliveryProfile(id: DeliveryProfileId): DeliveryProfile | undefined {
  if (id === "custom") return undefined;
  const profile = BUILTIN_PROFILES[id];
  return profile ? cloneProfile(profile) : undefined;
}

function orientationFor(width: number, height: number): DeliveryProfile["orientation"] {
  if (Math.abs(width - height) <= Math.max(width, height) * 0.01) return "square";
  return height > width ? "portrait" : "landscape";
}

export function customDeliveryProfile(
  width: number,
  height: number,
  fps = 30,
  label = "Custom"
): DeliveryProfile {
  const orientation = orientationFor(width, height);
  const safe = orientation === "landscape" ? LANDSCAPE_SAFE : orientation === "square" ? SQUARE_SAFE : SHORT_FORM_SAFE;
  return {
    schemaVersion: 1,
    id: "custom",
    label,
    platform: "generic",
    width,
    height,
    fps,
    orientation,
    ...safe,
    uiOcclusionZones: [],
  };
}

/** Resolve the frozen profile, or infer a conservative generic one for legacy projects. */
export function resolveDeliveryProfile(settings: Pick<ProjectSettings, "width" | "height" | "fps" | "deliveryProfile">): DeliveryProfile {
  const stored = settings.deliveryProfile;
  if (
    stored?.schemaVersion === 1 &&
    stored.width === settings.width &&
    stored.height === settings.height
  ) {
    return cloneProfile({ ...stored, fps: settings.fps });
  }
  const exact = Object.values(BUILTIN_PROFILES).find(
    (profile) => profile.width === settings.width && profile.height === settings.height
  );
  return exact
    ? cloneProfile({ ...exact, fps: settings.fps })
    : customDeliveryProfile(settings.width, settings.height, settings.fps);
}

export function rectToPixels(value: NormalizedRect, width: number, height: number) {
  return {
    x: value.x * width,
    y: value.y * height,
    width: value.width * width,
    height: value.height * height,
  };
}

function safeRect(profile: DeliveryProfile, target: GraphicSafetyTarget): NormalizedRect | null {
  if (target === "action") return profile.actionSafe;
  if (target === "title") return profile.titleSafe;
  if (target === "caption") return profile.captionSafe;
  return null;
}

export function layoutZoneRect(profile: DeliveryProfile, zone: GraphicLayoutZone): NormalizedRect {
  if (zone === "full") return rect(0, 0, 1, 1);
  if (zone === "action-safe") return { ...profile.actionSafe };
  if (zone === "title-safe") return { ...profile.titleSafe };
  if (zone === "caption") return { ...profile.captionSafe };
  const base = profile.titleSafe;
  if (zone === "top") return rect(base.x, base.y, base.width, base.height * 0.3);
  if (zone === "center") return rect(base.x, base.y + base.height * 0.25, base.width, base.height * 0.5);
  return rect(base.x, base.y + base.height * 0.58, base.width, base.height * 0.3);
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sizeWithin(value: number, max: number): number {
  return Math.max(1, Math.min(max, value));
}

function alignedCenter(start: number, span: number, size: number, align: "start" | "center" | "end") {
  if (align === "start") return start + size / 2;
  if (align === "end") return start + span - size / 2;
  return start + span / 2;
}

function clampCenter(center: number, size: number, start: number, span: number) {
  const half = size / 2;
  return Math.max(start + half, Math.min(start + span - half, center));
}

/** Resolve director-authored geometry without discarding exact creative intent. */
export function resolveGraphicGeometry(
  profile: DeliveryProfile,
  layout: GraphicLayout,
  intrinsic: { width: number; height: number }
): ResolvedGraphicGeometry {
  const compositionWidth = profile.width;
  const compositionHeight = profile.height;
  const intrinsicWidth = sizeWithin(finite(intrinsic.width, compositionWidth * 0.5), compositionWidth * 4);
  const intrinsicHeight = sizeWithin(finite(intrinsic.height, compositionHeight * 0.1), compositionHeight * 4);
  let width = intrinsicWidth;
  let height = intrinsicHeight;
  let centerX = compositionWidth / 2;
  let centerY = compositionHeight / 2;

  if (layout.mode === "absolute") {
    width = sizeWithin(finite(layout.width, intrinsicWidth), compositionWidth * 4);
    height = sizeWithin(finite(layout.height, intrinsicHeight), compositionHeight * 4);
    centerX = finite(layout.x, centerX);
    centerY = finite(layout.y, centerY);
  } else if (layout.mode === "normalized") {
    width = sizeWithin(finite(layout.width, intrinsicWidth / compositionWidth) * compositionWidth, compositionWidth * 4);
    height = sizeWithin(finite(layout.height, intrinsicHeight / compositionHeight) * compositionHeight, compositionHeight * 4);
    centerX = finite(layout.x, 0.5) * compositionWidth;
    centerY = finite(layout.y, 0.5) * compositionHeight;
  } else {
    const zone = rectToPixels(layoutZoneRect(profile, layout.zone), compositionWidth, compositionHeight);
    width = sizeWithin(finite(layout.widthRatio, intrinsicWidth / zone.width) * zone.width, compositionWidth * 4);
    height = sizeWithin(finite(layout.heightRatio, intrinsicHeight / zone.height) * zone.height, compositionHeight * 4);
    centerX = alignedCenter(zone.x, zone.width, width, layout.alignX) + finite(layout.offsetX, 0) * zone.width;
    centerY = alignedCenter(zone.y, zone.height, height, layout.alignY) + finite(layout.offsetY, 0) * zone.height;
  }

  const target = safeRect(profile, layout.safety);
  const targetPixels = target ? rectToPixels(target, compositionWidth, compositionHeight) : null;
  let clamped = false;
  if (layout.overflow === "clamp" && targetPixels) {
    const nextX = clampCenter(centerX, width, targetPixels.x, targetPixels.width);
    const nextY = clampCenter(centerY, height, targetPixels.y, targetPixels.height);
    clamped = nextX !== centerX || nextY !== centerY;
    centerX = nextX;
    centerY = nextY;
  }

  return {
    centerX,
    centerY,
    width,
    height,
    rect: { x: centerX - width / 2, y: centerY - height / 2, width, height },
    safeRect: targetPixels,
    clamped,
  };
}

function contains(outer: { x: number; y: number; width: number; height: number }, inner: { x: number; y: number; width: number; height: number }) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function intersects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function validateGraphicGeometry(
  profile: DeliveryProfile,
  layout: GraphicLayout,
  geometry: ResolvedGraphicGeometry
): LayoutValidationIssue[] {
  const issues: LayoutValidationIssue[] = [];
  const composition = { x: 0, y: 0, width: profile.width, height: profile.height };
  if (![geometry.rect.x, geometry.rect.y, geometry.rect.width, geometry.rect.height].every(Number.isFinite)) {
    return [{ code: "invalid_geometry", severity: "error", message: "Graphic geometry contains non-finite values." }];
  }
  if (!contains(composition, geometry.rect)) {
    issues.push({
      code: "outside_composition",
      severity: layout.overflow === "allow" || layout.overflow === "warn" ? "warning" : "error",
      message: "Graphic extends outside the composition.",
    });
  }
  const target = safeRect(profile, layout.safety);
  if (target) {
    const pixels = rectToPixels(target, profile.width, profile.height);
    if (!contains(pixels, geometry.rect)) {
      const code = layout.safety === "action" ? "outside_action_safe" : layout.safety === "caption" ? "outside_caption_safe" : "outside_title_safe";
      issues.push({ code, severity: layout.overflow === "allow" || layout.overflow === "warn" ? "warning" : "error", message: `Graphic extends outside the ${layout.safety}-safe area.` });
    }
  }
  for (const zone of profile.uiOcclusionZones) {
    if (!intersects(rectToPixels(zone.rect, profile.width, profile.height), geometry.rect)) continue;
    issues.push({
      code: "platform_ui_occlusion",
      severity: zone.severity === "blocking" ? "error" : "warning",
      message: `Graphic intersects ${zone.label}.`,
      zoneId: zone.id,
    });
  }
  return issues;
}

/** Conservative server-side estimate; browser playback can pass exact measured bounds. */
export function estimateTextBounds(params: Pick<TextParams, "text" | "fontSize" | "lineHeight" | "letterSpacing" | "maxWidth" | "backgroundPadding">) {
  const fontSize = Math.max(1, finite(params.fontSize, 48));
  const letterSpacing = finite(params.letterSpacing, 0);
  const padding = Math.max(0, finite(params.backgroundPadding, 0));
  const averageGlyph = fontSize * 0.62 + letterSpacing;
  const rawLines = String(params.text || "Text").split("\n");
  const maxWidth = params.maxWidth && params.maxWidth > 0 ? params.maxWidth : Infinity;
  let lineCount = 0;
  let widest = 0;
  for (const rawLine of rawLines) {
    const estimated = Math.max(averageGlyph, rawLine.length * averageGlyph);
    const wraps = Number.isFinite(maxWidth) ? Math.max(1, Math.ceil(estimated / maxWidth)) : 1;
    lineCount += wraps;
    widest = Math.max(widest, Number.isFinite(maxWidth) ? Math.min(maxWidth, estimated) : estimated);
  }
  return {
    width: widest + padding * 2,
    height: lineCount * fontSize * Math.max(0.5, finite(params.lineHeight, 1.2)) + padding * 2,
  };
}
