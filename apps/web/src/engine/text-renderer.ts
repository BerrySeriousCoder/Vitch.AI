import type { Clip, DeliveryProfile, GradientFill, LayerShadow, RichTextRun, TextParams } from "@tempo/types";
import {
  normalizeSplit,
  resolveDeliveryProfile,
  resolveGraphicGeometry,
  resolveUnitMotion,
  splitTextUnits,
  textHasKineticAnimators,
} from "@tempo/editor-core";
import { loadFont, loadFontById } from "@/lib/fonts";

function getTextProps(clip: Clip): TextParams {
  const p = clip.textParams;
  const finite = (value: unknown, fallback: number, min = -Infinity, max = Infinity) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(min, Math.min(max, value))
      : fallback;
  const richTextRuns = Array.isArray(p?.richTextRuns)
    ? p.richTextRuns.filter((run): run is RichTextRun => Boolean(run && typeof run === "object" && typeof run.text === "string"))
    : undefined;
  return {
    text: typeof p?.text === "string" ? p.text : "Text",
    richTextRuns,
    fontId: p?.fontId,
    fontFamily: p?.fontFamily || "Inter, sans-serif",
    fontSize: finite(p?.fontSize, 48, 0.01, 10_000),
    fontWeight: p?.fontWeight || "600",
    color: p?.color || "#ffffff",
    fillGradient: p?.fillGradient,
    fillEnabled: p?.fillEnabled,
    textAlign: p?.textAlign || "center",
    lineHeight: finite(p?.lineHeight, 1.3, 0.01, 100),
    stroke: p?.stroke,
    strokeWidth: p?.strokeWidth,
    shadow: p?.shadow,
    shadowStyle: p?.shadowStyle,
    glow: p?.glow,
    backgroundColor: p?.backgroundColor,
    maxWidth: p?.maxWidth,
    backgroundPadding: p?.backgroundPadding,
    backgroundRadius: p?.backgroundRadius,
    captionPresetId: p?.captionPresetId,
    letterSpacing: p?.letterSpacing,
    karaokeWords: p?.karaokeWords,
    karaokeActiveColor: p?.karaokeActiveColor,
    karaokeInactiveColor: p?.karaokeInactiveColor,
    split: p?.split,
    animators: p?.animators,
  };
}

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  props: TextParams,
  fillStyle: string | CanvasGradient,
  fillColor?: string
) {
  if (props.stroke && props.strokeWidth && props.strokeWidth > 0) {
    ctx.strokeStyle = props.stroke;
    ctx.lineWidth = props.strokeWidth;
    ctx.lineJoin = "round";
    ctx.strokeText(text, x, y);
  }
  if (props.fillEnabled !== false) {
    ctx.fillStyle = fillColor || fillStyle;
    ctx.fillText(text, x, y);
  }
}

function gradientFill(
  ctx: CanvasRenderingContext2D,
  gradient: GradientFill | undefined,
  width: number,
  height: number,
  fallback: string
): string | CanvasGradient {
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

function applyShadow(ctx: CanvasRenderingContext2D, style?: LayerShadow, legacy?: string, glow?: TextParams["glow"]) {
  if (glow) {
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = Number.isFinite(glow.blur) ? Math.max(0, glow.blur) : 0;
    ctx.shadowColor = alphaColor(glow.color, glow.opacity ?? 1);
    return;
  }
  if (style) {
    ctx.shadowOffsetX = Number.isFinite(style.offsetX) ? style.offsetX : 0;
    ctx.shadowOffsetY = Number.isFinite(style.offsetY) ? style.offsetY : 0;
    ctx.shadowBlur = Number.isFinite(style.blur) ? Math.max(0, style.blur) : 0;
    ctx.shadowColor = alphaColor(style.color, style.opacity ?? 1);
    return;
  }
  if (!legacy) return;
  const values = legacy.match(/(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px\s+(.+)/);
  if (!values) return;
  ctx.shadowOffsetX = Number(values[1]);
  ctx.shadowOffsetY = Number(values[2]);
  ctx.shadowBlur = Number(values[3]);
  ctx.shadowColor = values[4]!;
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth?: number): string[] {
  if (!(maxWidth && maxWidth > 0)) return text.split("\n");
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    const words = rawLine.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
  }
  return lines;
}

function fillRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
  ctx.fill();
}

export function renderText(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  canvasWidth: number,
  canvasHeight: number,
  timeInClip: number = 0,
  deliveryProfile?: DeliveryProfile
): void {
  const props = getTextProps(clip);
  if (props.fontId) {
    void loadFontById(props.fontId);
  }
  const family = props.fontFamily.split(",")[0]!.replace(/"/g, "").trim();
  loadFont(family);
  ctx.font = `${props.fontWeight} ${props.fontSize}px ${props.fontFamily}`;
  ctx.textAlign = props.textAlign;
  ctx.textBaseline = "middle";

  const spacingContext = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if (props.letterSpacing) {
    spacingContext.letterSpacing = `${props.letterSpacing}px`;
  }

  const padding = Math.max(0, props.backgroundPadding ?? 0);
  let lines = wrapLines(ctx, props.text, props.maxWidth);
  const lineSpacing = props.fontSize * props.lineHeight;
  const measureBounds = () => ({
    width: Math.max(props.fontSize * 0.5, ...lines.map((line) => ctx.measureText(line).width)) + padding * 2,
    height: Math.max(lineSpacing, lines.length * lineSpacing) + padding * 2,
  });
  let measured = measureBounds();
  let geometry = clip.layout
    ? resolveGraphicGeometry(
        deliveryProfile ?? resolveDeliveryProfile({ width: canvasWidth, height: canvasHeight, fps: 30 }),
        clip.layout,
        measured
      )
    : { centerX: canvasWidth / 2, centerY: canvasHeight / 2, width: measured.width, height: measured.height };
  const hasLayoutWidth = clip.layout && (
    (clip.layout.mode === "absolute" && clip.layout.width !== undefined) ||
    (clip.layout.mode === "normalized" && clip.layout.width !== undefined) ||
    (clip.layout.mode === "zone" && clip.layout.widthRatio !== undefined)
  );
  if (hasLayoutWidth) {
    lines = wrapLines(ctx, props.text, Math.max(1, geometry.width - padding * 2));
    measured = measureBounds();
    geometry = resolveGraphicGeometry(
      deliveryProfile ?? resolveDeliveryProfile({ width: canvasWidth, height: canvasHeight, fps: 30 }),
      clip.layout!,
      measured
    );
  }
  const totalHeight = lines.length * lineSpacing;
  const startY = geometry.centerY - totalHeight / 2 + lineSpacing / 2;

  let x: number;
  switch (props.textAlign) {
    case "left":
      x = clip.layout ? geometry.centerX - geometry.width / 2 + padding : 20;
      break;
    case "right":
      x = clip.layout ? geometry.centerX + geometry.width / 2 - padding : canvasWidth - 20;
      break;
    default:
      x = geometry.centerX;
  }

  applyShadow(ctx, props.shadowStyle, props.shadow, props.glow);
  const fillStyle = gradientFill(ctx, props.fillGradient, canvasWidth, canvasHeight, props.color);

  if (props.backgroundColor) {
    ctx.save();
    ctx.fillStyle = props.backgroundColor;
    const backgroundPadding = Math.max(0, props.backgroundPadding ?? 8);
    for (let i = 0; i < lines.length; i++) {
      const textWidth = ctx.measureText(lines[i]!).width;
      const ly = startY + i * lineSpacing;
      let bx: number;
      if (props.textAlign === "left") bx = x - backgroundPadding;
      else if (props.textAlign === "right") bx = x - textWidth - backgroundPadding;
      else bx = x - textWidth / 2 - backgroundPadding;
      fillRoundedRect(ctx, bx, ly - props.fontSize / 2 - backgroundPadding / 2, textWidth + backgroundPadding * 2, props.fontSize + backgroundPadding, props.backgroundRadius ?? 0);
    }
    ctx.restore();
  }

  const richRuns = props.richTextRuns?.filter((run) => run.text.length > 0);
  if (richRuns?.length) {
    // Rich runs are deliberately one editorial line in v1: it keeps span layout
    // deterministic in preview and headless frame export. Newlines form lines.
    const runMetrics = richRuns.map((run) => {
      ctx.save();
      ctx.font = `${run.italic ? "italic " : ""}${run.fontWeight || props.fontWeight} ${run.fontSize || props.fontSize}px ${run.fontFamily || props.fontFamily}`;
      const spacing = run.letterSpacing ?? props.letterSpacing ?? 0;
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${spacing}px`;
      const width = ctx.measureText(run.text).width;
      ctx.restore();
      return { run, width };
    });
    const totalWidth = runMetrics.reduce((sum, item) => sum + item.width, 0);
    let cursor = props.textAlign === "left" ? x : props.textAlign === "right" ? x - totalWidth : x - totalWidth / 2;
    for (const { run, width } of runMetrics) {
      ctx.save();
      ctx.textAlign = "left";
      ctx.font = `${run.italic ? "italic " : ""}${run.fontWeight || props.fontWeight} ${run.fontSize || props.fontSize}px ${run.fontFamily || props.fontFamily}`;
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${run.letterSpacing ?? props.letterSpacing ?? 0}px`;
      if (props.stroke && props.strokeWidth && props.strokeWidth > 0) {
        ctx.strokeStyle = props.stroke;
        ctx.lineWidth = props.strokeWidth;
        ctx.lineJoin = "round";
        ctx.strokeText(run.text, cursor, startY);
      }
      if (props.fillEnabled !== false) {
        ctx.fillStyle = run.color || fillStyle;
        ctx.fillText(run.text, cursor, startY);
      }
      if (run.underline) {
        ctx.strokeStyle = run.color || props.color;
        ctx.lineWidth = Math.max(1, (run.fontSize || props.fontSize) * 0.045);
        ctx.beginPath();
        ctx.moveTo(cursor, startY + (run.fontSize || props.fontSize) * 0.52);
        ctx.lineTo(cursor + width, startY + (run.fontSize || props.fontSize) * 0.52);
        ctx.stroke();
      }
      ctx.restore();
      cursor += width;
    }
  } else {

  const karaokeWords = props.karaokeWords?.filter((word) => word.text.trim());
  if (karaokeWords?.length) {
    ctx.textAlign = "left";
    ctx.lineJoin = "round";
    let wordOffset = 0;
    const lineWordCounts = lines.map((line) => line.trim().match(/\S+/g)?.length || 0);
    for (let lineIndex = 0; lineIndex < lineWordCounts.length; lineIndex++) {
      const count = lineWordCounts[lineIndex]!;
      const words = karaokeWords.slice(wordOffset, wordOffset + count);
      wordOffset += count;
      const pieces = words.map((word, index) => {
        const token = word.text.trim();
        return index > 0 && !/^[,.;:!?%)}\]]/.test(token) ? ` ${token}` : token;
      });
      const widths = pieces.map((piece) => ctx.measureText(piece).width);
      const totalWidth = widths.reduce((sum, width) => sum + width, 0);
      let cursorX = props.textAlign === "left" ? x : props.textAlign === "right" ? x - totalWidth : x - totalWidth / 2;
      for (let i = 0; i < words.length; i++) {
        const word = words[i]!;
        drawGlyph(ctx, pieces[i]!, cursorX, startY + lineIndex * lineSpacing, props, fillStyle, timeInClip >= word.start ? props.karaokeActiveColor || props.color : props.karaokeInactiveColor || props.color);
        cursorX += widths[i]!;
      }
    }
    ctx.textAlign = props.textAlign;
  } else if (textHasKineticAnimators(props)) {
    const split = normalizeSplit(props.split);
    const units = splitTextUnits(props.text, split);
    ctx.textAlign = "left";
    ctx.lineJoin = "round";

    // Group units by line and layout left-to-right with tracking
    const byLine = new Map<number, typeof units>();
    for (const u of units) {
      const arr = byLine.get(u.lineIndex) || [];
      arr.push(u);
      byLine.set(u.lineIndex, arr);
    }

    for (const [lineIndex, lineUnits] of byLine) {
      const ly = startY + lineIndex * lineSpacing;
      const motions = lineUnits.map((u) =>
        resolveUnitMotion(u.index, timeInClip, props.animators)
      );
      const widths = lineUnits.map((u, i) => {
        const m = motions[i]!;
        const tracking = (props.letterSpacing || 0) + m.tracking;
        spacingContext.letterSpacing = `${tracking}px`;
        return ctx.measureText(u.text).width * Math.max(m.scale, 0.001);
      });
      const totalWidth = widths.reduce((s, w) => s + w, 0);
      let cursor =
        props.textAlign === "left"
          ? x
          : props.textAlign === "right"
            ? x - totalWidth
            : x - totalWidth / 2;

      for (let i = 0; i < lineUnits.length; i++) {
        const u = lineUnits[i]!;
        const m = motions[i]!;
        if (m.opacity <= 0.001) {
          cursor += widths[i]!;
          continue;
        }
        const tracking = (props.letterSpacing || 0) + m.tracking;
        spacingContext.letterSpacing = `${tracking}px`;
        ctx.save();
        ctx.globalAlpha = m.opacity;
        if (m.blur > 0.1) {
          ctx.filter = `blur(${m.blur}px)`;
        }
        const cx = cursor + widths[i]! / 2;
        const cy = ly;
        ctx.translate(cx + m.offsetX, cy + m.offsetY);
        ctx.scale(m.scale, m.scale);
        if (Math.abs(m.rotation) > 0.001) {
          ctx.rotate((m.rotation * Math.PI) / 180);
        }
        ctx.translate(-widths[i]! / 2, 0);
        drawGlyph(ctx, u.text, 0, 0, props, fillStyle, m.color || undefined);
        ctx.restore();
        cursor += widths[i]!;
      }
    }
    ctx.textAlign = props.textAlign;
    ctx.globalAlpha = 1;
    ctx.filter = "none";
  } else {
    if (props.stroke && props.strokeWidth && props.strokeWidth > 0) {
      ctx.strokeStyle = props.stroke;
      ctx.lineWidth = props.strokeWidth;
      ctx.lineJoin = "round";
      for (let i = 0; i < lines.length; i++) {
        ctx.strokeText(lines[i]!, x, startY + i * lineSpacing);
      }
    }

    if (props.fillEnabled !== false) {
      ctx.fillStyle = fillStyle;
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i]!, x, startY + i * lineSpacing);
      }
    }
  }
  }

  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  if (props.letterSpacing) {
    spacingContext.letterSpacing = "0px";
  }
}
