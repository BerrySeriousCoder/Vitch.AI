import fs from "fs/promises";
import path from "path";
import {
  clearProjectPacks,
  registerTempoPack,
  validateTempoPackManifest,
} from "@tempo/editor-core";
import { storageConfig } from "../../config/storage.js";

/**
 * Load project pack manifests from disk into the project-scoped registry.
 * Safe to call repeatedly; replaces prior project entries.
 */
export async function ensureProjectPacksLoaded(projectId: string): Promise<void> {
  if (!projectId) return;
  clearProjectPacks(projectId);
  const projectPacksRoot = path.join(
    storageConfig.local.uploadDir,
    "packs",
    projectId
  );
  try {
    const entries = await fs.readdir(projectPacksRoot, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const manifestPath = path.join(projectPacksRoot, ent.name, "manifest.json");
      try {
        const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        const validated = validateTempoPackManifest(raw);
        if (validated.ok) {
          registerTempoPack(
            {
              manifest: validated.value,
              rootPath: path.join(projectPacksRoot, ent.name),
            },
            projectId
          );
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no packs dir */
  }
}
