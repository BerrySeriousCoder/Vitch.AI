import { randomUUID } from "crypto";
import type { Clip, GraphicTemplate, Track, TrackType } from "@tempo/types";
import type { ProjectState } from "./project-state.js";

const transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 };
const slots = (value: string, values: Record<string, string> = {}) => value.replace(/\{\{([\w-]+)\}\}/g, (_, key) => values[key] ?? `{{${key}}}`);
const find = (state: ProjectState, id: string) => state.tracks.flatMap((t) => t.clips).find((c) => c.id === id);

export const graphicsLibraryToolDefinitions = [
  { name: "set_brand_kit", description: "Save project brand tokens for future graphic templates.", parameters: { type: "object" as const, properties: { name: { type: "string" }, colors: { type: "array", items: { type: "string" } }, fontId: { type: "string" }, fontFamily: { type: "string" }, logoAssetId: { type: "string" } }, required: ["colors"] } },
  { name: "list_graphic_templates", description: "List saved reusable project graphic templates.", parameters: { type: "object" as const, properties: {} } },
  { name: "save_graphic_template", description: "Save a text or shape timeline layer as a reusable template. Use {{slot}} tokens in text for later replacement.", parameters: { type: "object" as const, properties: { clipId: { type: "string" }, name: { type: "string" } }, required: ["clipId", "name"] } },
  { name: "apply_graphic_template", description: "Create a timeline layer from a saved template, replacing {{slot}} values.", parameters: { type: "object" as const, properties: { templateId: { type: "string" }, startTime: { type: "number" }, duration: { type: "number" }, slotValues: { type: "object" } }, required: ["templateId", "startTime"] } },
];

export const graphicsLibraryToolExecutors: Record<string, (args: any, state: ProjectState) => { result: string; state: ProjectState }> = {
  set_brand_kit: (args, state) => { state.brandKit = { name: args.name, colors: (args.colors || []).filter((x: unknown) => typeof x === "string").slice(0, 12), fontId: args.fontId, fontFamily: args.fontFamily, logoAssetId: args.logoAssetId }; return { result: JSON.stringify({ ok: true, brandKit: state.brandKit }), state }; },
  list_graphic_templates: (_args, state) => ({ result: JSON.stringify({ ok: true, templates: state.graphicTemplates || [] }), state }),
  save_graphic_template: (args, state) => {
    const clip = find(state, args.clipId); if (!clip?.textParams && !clip?.shapeParams) return { result: "Error: Select a text or shape graphic layer", state };
    const template: GraphicTemplate = { id: randomUUID(), name: String(args.name).slice(0, 80), kind: clip.textParams ? "text" : "shape", textParams: clip.textParams ? JSON.parse(JSON.stringify(clip.textParams)) : undefined, shapeParams: clip.shapeParams ? JSON.parse(JSON.stringify(clip.shapeParams)) : undefined, layout: clip.layout ? JSON.parse(JSON.stringify(clip.layout)) : undefined, suggestedDuration: clip.duration, createdAt: new Date().toISOString() };
    (state.graphicTemplates ||= []).push(template); return { result: JSON.stringify({ ok: true, templateId: template.id, name: template.name }), state };
  },
  apply_graphic_template: (args, state) => {
    const template = (state.graphicTemplates || []).find((x) => x.id === args.templateId); if (!template) return { result: `Error: Template ${args.templateId} not found`, state };
    const type: TrackType = template.kind === "text" ? "text" : "shape"; let track = state.tracks.find((t) => t.type === type);
    if (!track) { track = { id: randomUUID(), name: template.kind === "text" ? "Template Text" : "Template Shapes", type, order: state.tracks.length, locked: false, visible: true, solo: false, clips: [] } as Track; state.tracks.push(track); }
    const id = randomUUID(); const values = args.slotValues || {}; const textParams = template.textParams ? { ...template.textParams, text: slots(template.textParams.text || "", values), richTextRuns: template.textParams.richTextRuns?.map((run) => ({ ...run, text: slots(run.text, values) })) } : undefined;
    track.clips.push({ id, trackId: track.id, sourceMediaId: null, startTime: Math.max(0, Number(args.startTime) || 0), duration: Math.max(0.1, Number(args.duration) || template.suggestedDuration), sourceOffset: 0, speed: 1, transform: { ...transform }, layout: template.layout ? JSON.parse(JSON.stringify(template.layout)) : undefined, opacity: 1, blendMode: "normal", effects: [], keyframes: [], mask: null, muted: false, volume: 1, textParams, shapeParams: template.shapeParams ? JSON.parse(JSON.stringify(template.shapeParams)) : undefined } as Clip);
    return { result: JSON.stringify({ ok: true, clipId: id, trackId: track.id, templateId: template.id }), state };
  },
};
