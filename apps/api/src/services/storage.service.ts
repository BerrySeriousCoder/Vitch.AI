import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import crypto from "crypto";
import { storageConfig } from "../config/storage.js";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: storageConfig.s3.region,
      credentials: {
        accessKeyId: storageConfig.s3.accessKeyId,
        secretAccessKey: storageConfig.s3.secretAccessKey,
      },
      ...(storageConfig.s3.endpoint && { endpoint: storageConfig.s3.endpoint, forcePathStyle: true }),
    });
  }
  return s3Client;
}

function generateStorageKey(originalName: string): string {
  const ext = path.extname(originalName);
  const hash = crypto.randomUUID();
  return `${hash}${ext}`;
}

export async function uploadFile(
  fileBuffer: Buffer,
  originalName: string,
  mimeType: string,
  subDir = "media"
): Promise<{ key: string; url: string }> {
  const key = `${subDir}/${generateStorageKey(originalName)}`;

  if (storageConfig.provider === "s3") {
    const client = getS3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: storageConfig.s3.bucket,
        Key: key,
        Body: fileBuffer,
        ContentType: mimeType,
      })
    );
    const url = storageConfig.s3.endpoint
      ? `${storageConfig.s3.endpoint}/${storageConfig.s3.bucket}/${key}`
      : `https://${storageConfig.s3.bucket}.s3.${storageConfig.s3.region}.amazonaws.com/${key}`;
    return { key, url };
  }

  const filePath = path.join(storageConfig.local.uploadDir, key);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, fileBuffer);
  const url = `/uploads/${key}`;
  return { key, url };
}

/** Store a file already present on disk without buffering the whole asset in memory. */
export async function uploadFileFromPath(
  sourcePath: string,
  originalName: string,
  mimeType: string,
  subDir = "media"
): Promise<{ key: string; url: string; size: number }> {
  const key = `${subDir}/${generateStorageKey(originalName)}`;
  const info = await fs.stat(sourcePath);

  if (storageConfig.provider === "s3") {
    const client = getS3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: storageConfig.s3.bucket,
        Key: key,
        Body: createReadStream(sourcePath),
        ContentType: mimeType,
        ContentLength: info.size,
      })
    );
    const url = storageConfig.s3.endpoint
      ? `${storageConfig.s3.endpoint}/${storageConfig.s3.bucket}/${key}`
      : `https://${storageConfig.s3.bucket}.s3.${storageConfig.s3.region}.amazonaws.com/${key}`;
    return { key, url, size: info.size };
  }

  const filePath = path.join(storageConfig.local.uploadDir, key);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.copyFile(sourcePath, filePath);
  return { key, url: `/uploads/${key}`, size: info.size };
}

export async function deleteFile(key: string): Promise<void> {
  if (storageConfig.provider === "s3") {
    const client = getS3Client();
    await client.send(
      new DeleteObjectCommand({
        Bucket: storageConfig.s3.bucket,
        Key: key,
      })
    );
    return;
  }

  const filePath = path.join(storageConfig.local.uploadDir, key);
  await fs.unlink(filePath).catch(() => {});
}

/** Map a stored asset URL back to the storage key used by deleteFile/uploadFile. */
export function storageUrlToKey(url: string): string {
  if (url.startsWith("/uploads/")) {
    return url.slice("/uploads/".length);
  }
  try {
    const pathname = new URL(url).pathname.replace(/^\//, "");
    const bucket = storageConfig.s3.bucket;
    if (bucket && pathname.startsWith(`${bucket}/`)) {
      return pathname.slice(bucket.length + 1);
    }
    // Prefer trailing media|fonts|luts/<file> segments when present
    const match = pathname.match(/(?:^|\/)((?:media|fonts|luts)\/[^/]+)$/);
    if (match?.[1]) return match[1];
    return pathname;
  } catch {
    return url.replace(/^\/uploads\//, "");
  }
}

/** Download a stored object to a local filesystem path (S3 or local copy). */
export async function downloadFileToPath(
  key: string,
  destPath: string
): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  if (storageConfig.provider === "s3") {
    const client = getS3Client();
    const res = await client.send(
      new GetObjectCommand({
        Bucket: storageConfig.s3.bucket,
        Key: key,
      })
    );
    const body = res.Body;
    if (!body) throw new Error(`Empty S3 body for key ${key}`);
    const bytes = await body.transformToByteArray();
    await fs.writeFile(destPath, Buffer.from(bytes));
    return;
  }

  const src = path.join(storageConfig.local.uploadDir, key);
  await fs.copyFile(src, destPath);
}

export async function getPresignedUrl(key: string, expiresIn = 3600): Promise<string> {
  if (storageConfig.provider === "s3") {
    const client = getS3Client();
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: storageConfig.s3.bucket, Key: key }),
      { expiresIn }
    );
  }
  return `/uploads/${key}`;
}
