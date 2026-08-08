import type { Clip, DeliveryProfile, GradientFill, LayerShadow, ShapeParams } from "@tempo/types";
import { resolveDeliveryProfile, resolveGraphicGeometry } from "@tempo/editor-core";

function getShapeProps(clip: Clip): ShapeParams {
  const p = clip.shapeParams;
  const finite = (value: unknown, fallback: number, min = -Infinity, max = Infinity) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(min, Math.min(max, value))
      : fallback;
  const shapes = new Set(["rect", "ellipse", "triangle", "polygon", "star", "line", "path"]);
  return {
    shape: p?.shape && shapes.has(p.shape) ? p.shape : "rect",
    fill: typeof p?.fill === "string" ? p.fill : "#3b82f6",
    fillGradient: p?.fillGradient,
    stroke: typeof p?.stroke === "string" ? p.stroke : "transparent",
    strokeWidth: finite(p?.strokeWidth, 0, 0, 10_000),
    width: finite(p?.width, 200, 0.01, 100_000),
    height: finite(p?.height, 200, 0.01, 100_000),
    cornerRadius: finite(p?.cornerRadius, 0, 0, 100_000),
    points: Math.round(finite(p?.points, p?.shape === "polygon" ? 6 : 5, 3, 100)),
    innerRadius: finite(p?.innerRadius, 0.4, 0, 1),
    pathPoints: Array.isArray(p?.pathPoints) ? p.pathPoints.map((point) => ({ ...point })) : undefined,
    pathClosed: p?.pathClosed !== false,
    shadow: p?.shadow,
    glow: p?.glow,
  };
}

function gradientFill(ctx: CanvasRenderingContext2D, gradient: GradientFill | undefined, width: number, height: number, fallback: string): string | CanvasGradient {
  if (!gradient) return fallback;
  try {
    if (gradient.type === "radial") {
      const fill = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) / 2);
      fill.addColorStop(0, gradient.from);
      fill.addColorStop(1, gradient.to);
      return fill;
    }
    const radians = ((Number.isFinite(gradient.angle) ? gradient.angle! : 0) * Math.PI) / 180;
    const dx = Math.cos(radians) * width / 2;
    const dy = Math.sin(radians) * height / 2;
    const fill = ctx.createLinearGradient(width / 2 - dx, height / 2 - dy, width / 2 + dx, height / 2 + dy);
    fill.addColorStop(0, gradient.from);
    fill.addColorStop(1, gradient.to);
    return fill;
  } catch {
    return fallback;
  }
}

function alphaColor(color: string, opacity = 1): string {
  if (typeof color !== "string") return "transparent";
  if (opacity >= 0.999) return color;
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (!hex) return color;
  const full = hex.length === 3 ? hex.split("").map((x) => x + x).join("") : hex;
  return `rgba(${parseInt(full.slice(0, 2), 16)}, ${parseInt(full.slice(2, 4), 16)}, ${parseInt(full.slice(4, 6), 16)}, ${Math.max(0, Math.min(1, opacity))})`;
}

function applyShadow(ctx: CanvasRenderingContext2D, shadow?: LayerShadow, glow?: ShapeParams["glow"]) {
  const style = glow
    ? { color: glow.color, offsetX: 0, offsetY: 0, blur: glow.blur, opacity: glow.opacity }
    : shadow;
  if (!style) return;
  ctx.shadowColor = alphaColor(style.color, style.opacity ?? 1);
  ctx.shadowOffsetX = Number.isFinite(style.offsetX) ? style.offsetX : 0;
  ctx.shadowOffsetY = Number.isFinite(style.offsetY) ? style.offsetY : 0;
  ctx.shadowBlur = Number.isFinite(style.blur) ? Math.max(0, style.blur) : 0;
}

function drawPolygon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  sides: number
) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const angle = (Math.PI * 2 * i) / sides - Math.PI / 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outerRadius: number,
  points: number,
  innerRatio: number
) {
  const innerRadius = outerRadius * innerRatio;
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const angle = (Math.PI * i) / points - Math.PI / 2;
    const r = i % 2 === 0 ? outerRadius : innerRadius;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const cr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + cr, y);
  ctx.lineTo(x + w - cr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + cr);
  ctx.lineTo(x + w, y + h - cr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - cr, y + h);
  ctx.lineTo(x + cr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - cr);
  ctx.lineTo(x, y + cr);
  ctx.quadraticCurveTo(x, y, x + cr, y);
  ctx.closePath();
}

function drawVectorPath(
  ctx: CanvasRenderingContext2D,
  points: NonNullable<ShapeParams["pathPoints"]>,
  x: number,
  y: number,
  width: number,
  height: number,
  closed: boolean
) {
  if (!points.length) return;
  const px = (value: number) => x + value * width;
  const py = (value: number) => y + value * height;
  ctx.beginPath();
  ctx.moveTo(px(points[0]!.x), py(points[0]!.y));
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    if (
      previous.outX !== undefined && previous.outY !== undefined &&
      current.inX !== undefined && current.inY !== undefined
    ) {
      ctx.bezierCurveTo(
        px(previous.outX), py(previous.outY),
        px(current.inX), py(current.inY),
        px(current.x), py(current.y)
      );
    } else {
      ctx.lineTo(px(current.x), py(current.y));
    }
  }
  if (closed) {
    const previous = points[points.length - 1]!;
    const current = points[0]!;
    if (
      previous.outX !== undefined && previous.outY !== undefined &&
      current.inX !== undefined && current.inY !== undefined
    ) {
      ctx.bezierCurveTo(
        px(previous.outX), py(previous.outY),
        px(current.inX), py(current.inY),
        px(current.x), py(current.y)
      );
    }
    ctx.closePath();
  }
}

export function renderShape(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  canvasWidth: number,
  canvasHeight: number,
  deliveryProfile?: DeliveryProfile
): void {
  const props = getShapeProps(clip);
  const geometry = clip.layout
    ? resolveGraphicGeometry(
        deliveryProfile ?? resolveDeliveryProfile({ width: canvasWidth, height: canvasHeight, fps: 30 }),
        clip.layout,
        { width: props.width, height: props.height }
      )
    : { centerX: canvasWidth / 2, centerY: canvasHeight / 2, width: props.width, height: props.height };
  const cx = geometry.centerX;
  const cy = geometry.centerY;
  const shapeWidth = geometry.width;
  const shapeHeight = geometry.height;
  const hw = shapeWidth / 2;
  const hh = shapeHeight / 2;

  ctx.fillStyle = gradientFill(ctx, props.fillGradient, canvasWidth, canvasHeight, props.fill);
  applyShadow(ctx, props.shadow, props.glow);
  if (props.strokeWidth > 0) {
    ctx.strokeStyle = props.stroke;
    ctx.lineWidth = props.strokeWidth;
  }

  switch (props.shape) {
    case "rect": {
      if (props.cornerRadius && props.cornerRadius > 0) {
        drawRoundedRect(ctx, cx - hw, cy - hh, shapeWidth, shapeHeight, props.cornerRadius);
      } else {
        ctx.beginPath();
        ctx.rect(cx - hw, cy - hh, shapeWidth, shapeHeight);
      }
      ctx.fill();
      if (props.strokeWidth > 0) ctx.stroke();
      break;
    }
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(cx, cy, hw, hh, 0, 0, Math.PI * 2);
      ctx.fill();
      if (props.strokeWidth > 0) ctx.stroke();
      break;
    case "triangle":
      ctx.beginPath();
      ctx.moveTo(cx, cy - hh);
      ctx.lineTo(cx + hw, cy + hh);
      ctx.lineTo(cx - hw, cy + hh);
      ctx.closePath();
      ctx.fill();
      if (props.strokeWidth > 0) ctx.stroke();
      break;
    case "polygon": {
      const sides = props.points || 6;
      const radius = Math.min(hw, hh);
      drawPolygon(ctx, cx, cy, radius, sides);
      ctx.fill();
      if (props.strokeWidth > 0) ctx.stroke();
      break;
    }
    case "star": {
      const points = props.points || 5;
      const outerR = Math.min(hw, hh);
      const innerRatio = props.innerRadius ?? 0.4;
      drawStar(ctx, cx, cy, outerR, points, innerRatio);
      ctx.fill();
      if (props.strokeWidth > 0) ctx.stroke();
      break;
    }
    case "line":
      ctx.beginPath();
      ctx.moveTo(cx - hw, cy);
      ctx.lineTo(cx + hw, cy);
      ctx.strokeStyle = props.fill;
      ctx.lineWidth = props.strokeWidth || 3;
      ctx.stroke();
      break;
    case "path":
      drawVectorPath(
        ctx,
        props.pathPoints || [],
        cx - hw,
        cy - hh,
        shapeWidth,
        shapeHeight,
        props.pathClosed !== false
      );
      if (props.pathClosed !== false) ctx.fill();
      if (props.strokeWidth > 0 || props.pathClosed === false) ctx.stroke();
      break;
  }
}
