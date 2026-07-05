/** A rectangle in normalized composition coordinates (0..1). */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DeliveryProfileId =
  | "instagram-reel"
  | "tiktok"
  | "youtube-short"
  | "youtube-landscape"
  | "instagram-square"
  | "instagram-portrait"
  | "custom";

export type DeliveryOrientation = "portrait" | "landscape" | "square";

/** A platform-controlled area which may cover editorial content at playback time. */
export interface DeliveryOcclusionZone {
  id: string;
  label: string;
  rect: NormalizedRect;
  /** Informational zones warn; blocking zones fail strict layout validation. */
  severity: "info" | "warning" | "blocking";
}

/**
 * Frozen composition contract stored with the project. Profile snapshots keep
 * old projects deterministic even when a platform later changes its UI chrome.
 */
export interface DeliveryProfile {
  schemaVersion: 1;
  id: DeliveryProfileId;
  label: string;
  platform: "instagram" | "tiktok" | "youtube" | "generic";
  width: number;
  height: number;
  fps: number;
  orientation: DeliveryOrientation;
  actionSafe: NormalizedRect;
  titleSafe: NormalizedRect;
  captionSafe: NormalizedRect;
  uiOcclusionZones: DeliveryOcclusionZone[];
}

export type GraphicLayoutZone =
  | "full"
  | "action-safe"
  | "title-safe"
  | "top"
  | "center"
  | "lower-third"
  | "caption";

export type GraphicSafetyTarget = "none" | "action" | "title" | "caption";
export type GraphicOverflowPolicy = "allow" | "warn" | "clamp" | "reject";

interface GraphicLayoutCommon {
  schemaVersion: 1;
  /** Which safety boundary should be used during validation. */
  safety: GraphicSafetyTarget;
  /** Creative intent is preserved; this controls how violations are handled. */
  overflow: GraphicOverflowPolicy;
  source?: "agent" | "user" | "template" | "import";
}

/** Exact composition-pixel placement. x/y describe the graphic's center. */
export interface AbsoluteGraphicLayout extends GraphicLayoutCommon {
  mode: "absolute";
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/** Resolution-independent placement. Values are normalized against composition size. */
export interface NormalizedGraphicLayout extends GraphicLayoutCommon {
  mode: "normalized";
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/**
 * Semantic placement resolved inside a layout zone. Offsets are fractions of
 * the selected zone, so the director can still art-direct the exact result.
 */
export interface ZoneGraphicLayout extends GraphicLayoutCommon {
  mode: "zone";
  zone: GraphicLayoutZone;
  alignX: "start" | "center" | "end";
  alignY: "start" | "center" | "end";
  offsetX?: number;
  offsetY?: number;
  widthRatio?: number;
  heightRatio?: number;
}

export type GraphicLayout =
  | AbsoluteGraphicLayout
  | NormalizedGraphicLayout
  | ZoneGraphicLayout;

/** Pixel-space geometry returned by the shared resolver. */
export interface ResolvedGraphicGeometry {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rect: { x: number; y: number; width: number; height: number };
  safeRect: { x: number; y: number; width: number; height: number } | null;
  clamped: boolean;
}

export type LayoutIssueCode =
  | "outside_composition"
  | "outside_action_safe"
  | "outside_title_safe"
  | "outside_caption_safe"
  | "platform_ui_occlusion"
  | "invalid_geometry";

export interface LayoutValidationIssue {
  code: LayoutIssueCode;
  severity: "warning" | "error";
  message: string;
  zoneId?: string;
}
