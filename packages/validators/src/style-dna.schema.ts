import { z } from "zod";

export const styleDnaNarrativeRoleSchema = z.enum([
  "hook",
  "build",
  "drop",
  "outro",
  "broll",
  "cta",
]);

export const styleDnaSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["reference", "manual"]),
  referenceUrl: z.string().optional(),
  derivedFromBlueprintId: z.string().optional(),
  pacing: z.object({
    avgShotSec: z.number(),
    cutRate: z.number(),
    label: z.enum(["slow", "moderate", "fast", "variable"]),
  }),
  color: z.object({
    palette: z.array(z.string()),
    gradingHint: z.string(),
    contrastBias: z.number().optional(),
  }),
  typography: z.object({
    density: z.number(),
    preferredPositions: z.array(z.enum(["top", "center", "bottom", "custom"])),
    animationHints: z.array(z.string()),
  }),
  motion: z.object({
    zoomBias: z.number(),
    panBias: z.number(),
    energy: z.number(),
  }),
  audio: z.object({
    bpm: z.number().optional(),
    mood: z.string().optional(),
    beatCutBias: z.boolean(),
  }),
  transitions: z.object({
    vocabulary: z.array(z.string()),
  }),
  narrativeRoles: z.array(
    z.object({
      role: styleDnaNarrativeRoleSchema,
      weight: z.number(),
      targetDurationSec: z.number().optional(),
      energy: z.number().optional(),
      shotCriteria: z.array(z.string()),
    })
  ),
  createdAt: z.string(),
});

export const shotIndexEntrySchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  start: z.number(),
  end: z.number(),
  summary: z.string().optional(),
  tags: z.array(z.string()),
  subjects: z.array(z.string()),
  shotType: z.string().optional(),
  cameraMotion: z.string().optional(),
  mood: z.string().optional(),
  energy: z.number().optional(),
  bestFor: z.array(z.string()),
  thumbnailUrl: z.string().optional(),
  analyzedAt: z.string(),
});

export const shotIndexSchema = z.object({
  schemaVersion: z.literal(1),
  shots: z.array(shotIndexEntrySchema),
  model: z.string(),
  analyzedAt: z.string(),
});

export type StyleDnaInput = z.infer<typeof styleDnaSchema>;
export type ShotIndexInput = z.infer<typeof shotIndexSchema>;
