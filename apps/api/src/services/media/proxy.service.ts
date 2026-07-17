import fs from "fs/promises";
import os from "os";
import path from "path";
import { eq } from "drizzle-orm";
import { db, mediaAssets } from "@tempo/db";
import { generateEditorialProxy } from "../../utils/ffmpeg.js";
import { deleteFile, downloadFileToPath, storageUrlToKey, uploadFile } from "../storage.service.js";
import { storageConfig } from "../../config/storage.js";
import { logger } from "../../utils/logger.js";

const inFlight = new Map<string, { generation: number; task: Promise<void> }>();
const generations = new Map<string, number>();
const waiting: Array<() => void> = [];
let activeEncodes = 0;
const MAX_CONCURRENT_PROXY_ENCODES = 2;

function scheduleProxyEncode(task: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const run = () => {
      activeEncodes += 1;
      void task().then(resolve, reject).finally(() => {
        activeEncodes -= 1;
        waiting.shift()?.();
      });
    };
    if (activeEncodes < MAX_CONCURRENT_PROXY_ENCODES) run();
    else waiting.push(run);
  });
}

function metadata(asset: { metadata: unknown }): Record<string, unknown> {
  return (asset.metadata && typeof asset.metadata === "object" ? asset.metadata : {}) as Record<string, unknown>;
}

async function patchProxyState(assetId: string, patch: Record<string, unknown>, proxyUrl?: string | null) {
  const asset = await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, assetId) });
  if (!asset) return;
  await db.update(mediaAssets).set({
    metadata: { ...metadata(asset), ...patch },
    ...(proxyUrl !== undefined ? { proxyUrl } : {}),
  }).where(eq(mediaAssets.id, assetId));
}

async function createProxy(assetId: string, generation: number): Promise<void> {
  const asset = await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, assetId) });
  if (!asset || asset.type !== "video") return;
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "tempo-proxy-"));
  try {
    const sourcePath = path.join(workDir, `source${path.extname(storageUrlToKey(asset.url)) || ".mp4"}`);
    if (storageConfig.provider === "local") {
      await fs.copyFile(path.join(storageConfig.local.uploadDir, storageUrlToKey(asset.url)), sourcePath);
    } else {
      await downloadFileToPath(storageUrlToKey(asset.url), sourcePath);
    }
    const outputPath = path.join(workDir, "editorial-proxy.mp4");
    const ok = await generateEditorialProxy(sourcePath, outputPath);
    if (!ok) throw new Error("FFmpeg could not create a compatible editorial proxy");
    const uploaded = await uploadFile(
      await fs.readFile(outputPath),
      `${path.basename(asset.name, path.extname(asset.name)) || "media"}-proxy.mp4`,
      "video/mp4",
      "proxies"
    );
    // A user may have removed/relinked the asset while FFmpeg was running.
    if (generations.get(assetId) !== generation) {
      await deleteFile(uploaded.key).catch(() => undefined);
      return;
    }
    await patchProxyState(assetId, {
      proxyStatus: "ready",
      proxyError: undefined,
      proxyProfile: "1280px long-edge H.264/AAC editorial proxy (CRF 22)",
    }, uploaded.url);
    logger.info({ assetId }, "Editorial proxy ready");
  } catch (err: any) {
    if (generations.get(assetId) === generation) {
      await patchProxyState(assetId, { proxyStatus: "error", proxyError: err?.message || "Proxy generation failed" }, null);
    }
    logger.error({ err: err?.message, assetId }, "Editorial proxy failed");
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Persist pending state first, then coalesce duplicate background requests. */
export async function requestEditorialProxy(assetId: string): Promise<void> {
  const existing = inFlight.get(assetId);
  const currentGeneration = generations.get(assetId) || 0;
  if (existing?.generation === currentGeneration) return;
  const generation = currentGeneration + 1;
  generations.set(assetId, generation);
  await patchProxyState(assetId, { proxyStatus: "processing", proxyError: undefined });
  const task = scheduleProxyEncode(() => createProxy(assetId, generation)).finally(() => {
    if (inFlight.get(assetId)?.generation === generation) inFlight.delete(assetId);
  });
  inFlight.set(assetId, { generation, task });
  void task;
}

export async function clearEditorialProxy(assetId: string): Promise<void> {
  // Invalidate a background encode before awaiting the database so a stale
  // proxy can never win the race and be attached after clear/relink.
  generations.set(assetId, (generations.get(assetId) || 0) + 1);
  const asset = await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, assetId) });
  if (!asset) return;
  await patchProxyState(assetId, { proxyStatus: "none", proxyError: undefined, proxyProfile: undefined }, null);
}
