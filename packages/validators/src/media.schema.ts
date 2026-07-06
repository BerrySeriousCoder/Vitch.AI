import { z } from "zod";

const DEFAULT_EDIT_LIKE_THIS_AUDIO_POLICY = {
  soundtrack: "none" as const,
  sourceAudio: "keep" as const,
  soundtrackVolume: 0.85,
  sourceVolume: 1,
  duckLevel: 0.25,
};

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** Strict host-based check shared by validation tests and the web client contract. */
export function isSupportedReferenceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (hostMatches(host, "youtu.be")) return url.pathname.length > 1;
    if (hostMatches(host, "youtube.com")) {
      return (
        (url.pathname === "/watch" && Boolean(url.searchParams.get("v"))) ||
        /^\/(?:shorts|live)\/[^/]+/.test(url.pathname)
      );
    }
    if (hostMatches(host, "instagram.com")) {
      return /^\/(?:reel|reels|p|tv)\/[^/]+/.test(url.pathname);
    }
    if (hostMatches(host, "tiktok.com")) return url.pathname.length > 1;
    if (hostMatches(host, "x.com") || hostMatches(host, "twitter.com")) {
      return /\/status\/\d+/.test(url.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

export const editLikeThisAudioPolicySchema = z
  .object({
    soundtrack: z.enum(["reference", "uploaded", "none"]),
    sourceAudio: z.enum(["mute", "keep", "duck"]),
    uploadedAudioAssetId: z.string().uuid().optional(),
    referenceAudioAuthorized: z.boolean().optional(),
    soundtrackVolume: z.number().min(0).max(2).default(0.85),
    sourceVolume: z.number().min(0).max(2).default(1),
    duckLevel: z.number().min(0).max(1).default(0.25),
  })
  .superRefine((policy, ctx) => {
    if (policy.soundtrack === "reference" && policy.referenceAudioAuthorized !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["referenceAudioAuthorized"],
        message: "Confirm that you have permission to reuse the reference audio",
      });
    }
    if (policy.soundtrack === "uploaded" && !policy.uploadedAudioAssetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["uploadedAudioAssetId"],
        message: "Select an uploaded audio asset",
      });
    }
    if (policy.sourceAudio === "duck" && policy.soundtrack === "none") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceAudio"],
        message: "Ducking requires a reference or uploaded soundtrack",
      });
    }
  });

export const mediaUploadSchema = z.object({
  projectId: z.string().uuid("Invalid project ID"),
  fileName: z.string().min(1),
  fileSize: z.number().int().positive(),
  mimeType: z.string().regex(/^(video|audio|image)\//, "Must be a video, audio, or image file"),
});

export const referenceVideoSchema = z.object({
  url: z
    .string()
    .url("Must be a valid URL")
    .refine(isSupportedReferenceUrl, "URL must be a supported Instagram, YouTube, TikTok, or X video"),
  projectId: z.string().uuid("Invalid project ID"),
  audioPolicy: editLikeThisAudioPolicySchema.default(DEFAULT_EDIT_LIKE_THIS_AUDIO_POLICY),
});

export type MediaUploadInput = z.infer<typeof mediaUploadSchema>;
export type ReferenceVideoInput = z.infer<typeof referenceVideoSchema>;
export type EditLikeThisAudioPolicyInput = z.infer<typeof editLikeThisAudioPolicySchema>;
