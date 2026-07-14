import path from "path";
import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { eq } from "drizzle-orm";
import { db, fontAssets } from "@tempo/db";
import {
  downloadFileToPath,
  storageUrlToKey,
} from "./storage.service.js";
import { storageConfig } from "../config/storage.js";
import { logger } from "../utils/logger.js";

const exec = promisify(execFile);

export interface StagedFonts {
  fontsDir: string;
  /** font asset id → CSS family name */
  familyByFontId: Map<string, string>;
}

const EMBEDDABLE_EXT = new Set([".ttf", ".otf"]);

async function tryConvertWoff2(srcPath: string, destTtf: string): Promise<boolean> {
  // Prefer woff2_decompress if installed (google/woff2)
  try {
    await exec("woff2_decompress", [srcPath], { maxBuffer: 10 * 1024 * 1024 });
    // woff2_decompress writes alongside with .ttf
    const autoTtf = srcPath.replace(/\.woff2$/i, ".ttf");
    await fs.rename(autoTtf, destTtf).catch(async () => {
      await fs.copyFile(autoTtf, destTtf);
    });
    return true;
  } catch {
    /* try fonttools */
  }
  try {
    await exec(
      "python3",
      ["-c", "from fontTools.ttLib import TTFont; import sys; TTFont(sys.argv[1]).save(sys.argv[2])", srcPath, destTtf],
      { maxBuffer: 20 * 1024 * 1024 }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy project fonts into tempDir/fonts for libass fontsdir=.
 * WOFF2 is converted when tools exist; otherwise skipped with a warning.
 * Conversion always runs on a temp copy — never mutates the upload directory.
 */
export async function stageProjectFonts(
  projectId: string,
  tempDir: string
): Promise<StagedFonts> {
  const fontsDir = path.join(tempDir, "fonts");
  await fs.mkdir(fontsDir, { recursive: true });
  const familyByFontId = new Map<string, string>();

  const rows = await db.query.fontAssets.findMany({
    where: eq(fontAssets.projectId, projectId),
  });

  for (const row of rows) {
    familyByFontId.set(row.id, row.familyName);
    const key = storageUrlToKey(row.url);
    const ext = path.extname(row.fileName || key).toLowerCase();
    const safeBase = `${row.id}${ext || ".ttf"}`;
    const dest = path.join(fontsDir, safeBase);

    try {
      let localPath: string;
      if (storageConfig.provider === "local") {
        localPath = path.join(storageConfig.local.uploadDir, key);
      } else {
        localPath = path.join(fontsDir, `_dl_${safeBase}`);
        await downloadFileToPath(key, localPath);
      }

      if (EMBEDDABLE_EXT.has(ext)) {
        await fs.copyFile(localPath, dest);
      } else if (ext === ".woff2" || ext === ".woff") {
        const woffCopy = path.join(fontsDir, `_woff_${row.id}${ext}`);
        await fs.copyFile(localPath, woffCopy);
        const converted = path.join(fontsDir, `${row.id}.ttf`);
        const ok = await tryConvertWoff2(woffCopy, converted);
        await fs.unlink(woffCopy).catch(() => undefined);
        if (!ok) {
          logger.warn(
            { fontId: row.id, fileName: row.fileName },
            "WOFF/WOFF2 font skipped for export (no converter); ASS will use family name only"
          );
        }
      } else {
        await fs.copyFile(localPath, dest);
      }

      if (storageConfig.provider !== "local") {
        await fs.unlink(localPath).catch(() => undefined);
      }
    } catch (err: any) {
      logger.warn(
        { fontId: row.id, err: err?.message },
        "Failed to stage font for export"
      );
    }
  }

  return { fontsDir, familyByFontId };
}
