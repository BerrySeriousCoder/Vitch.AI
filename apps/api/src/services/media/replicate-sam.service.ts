import { env } from "../../config/env.js";
import { uploadFile } from "../storage.service.js";
import Replicate from "replicate";

const VERSION = "33432afdfc06a10da6b4018932893d39b0159f838b6d11dd1236dff85cc5ec1d";
const MODEL = `meta/sam-2-video:${VERSION}` as const;

function firstFileOutput(output: unknown): { blob: () => Promise<Blob> } | null {
  const values = Array.isArray(output) ? output : [output];
  return values.find((value): value is { blob: () => Promise<Blob> } =>
    Boolean(value && typeof value === "object" && "blob" in value && typeof (value as { blob?: unknown }).blob === "function")
  ) || null;
}

export async function createSamVideoMatte(input: {
  inputVideo: string | Buffer;
  clickFrames: string;
  clickObjectIds: string;
  clickCoordinates: string;
  videoFps?: number;
}): Promise<{ url: string }> {
  if (!env.REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN is required for SAM 2 mattes");
  const replicate = new Replicate({ auth: env.REPLICATE_API_TOKEN });
  const output = await replicate.run(MODEL, {
    input: {
      mask_type: "highlighted",
      output_video: true,
      video_fps: input.videoFps || 25,
      input_video: input.inputVideo,
      click_frames: input.clickFrames,
      click_object_ids: input.clickObjectIds,
      click_coordinates: input.clickCoordinates,
    },
    wait: { mode: "poll", interval: 1500 },
  });
  const file = firstFileOutput(output);
  if (!file) throw new Error("Replicate SAM did not return a video file");
  const stored = await uploadFile(Buffer.from(await (await file.blob()).arrayBuffer()), `sam-matte-${Date.now()}.mp4`, "video/mp4", "generated");
  return { url: stored.url };
}
