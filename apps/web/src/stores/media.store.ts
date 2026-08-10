import { create } from "zustand";
import { toast } from "sonner";
import { apiFetch, apiUpload } from "@/lib/api-client";
import type { MediaAsset } from "@tempo/types";

/** Ensure duration is always present (DB/metadata fallback). */
function normalizeAsset(asset: MediaAsset): MediaAsset {
  const fromMeta =
    typeof asset.metadata?.duration === "number" ? asset.metadata.duration : null;
  return {
    ...asset,
    duration: asset.duration ?? fromMeta,
    thumbnailUrl: asset.thumbnailUrl ?? null,
    proxyUrl: asset.proxyUrl ?? null,
    waveformUrl: asset.waveformUrl ?? null,
    metadata: {
      ...asset.metadata,
      fileSize: asset.metadata?.fileSize ?? 0,
      mimeType: asset.metadata?.mimeType ?? "application/octet-stream",
    },
  };
}

function isAnalysisPending(asset: MediaAsset): boolean {
  const m = asset.metadata;
  return (
    m?.analysisStatus === "pending" ||
    m?.audioAnalysisStatus === "pending"
  );
}

function isProxyPending(asset: MediaAsset): boolean {
  return asset.metadata?.proxyStatus === "processing";
}

interface MediaState {
  assets: MediaAsset[];
  isLoading: boolean;
  uploadingCount: number;
  analyzingIds: Set<string>;

  upsertAsset: (asset: MediaAsset) => void;
  loadAssets: (projectId: string) => Promise<void>;
  uploadFile: (projectId: string, file: File) => Promise<MediaAsset | null>;
  deleteAsset: (projectId: string, assetId: string) => Promise<void>;
  refreshAsset: (projectId: string, assetId: string) => Promise<MediaAsset | null>;
  reanalyzeAsset: (projectId: string, assetId: string) => Promise<MediaAsset | null>;
  createProxy: (projectId: string, assetId: string) => Promise<void>;
  clearProxy: (projectId: string, assetId: string) => Promise<void>;
  relinkAsset: (projectId: string, assetId: string, file: File) => Promise<MediaAsset | null>;
  analyzeAll: (projectId: string) => Promise<void>;
  pollPendingAnalysis: (projectId: string) => void;
  reset: () => void;
}

const pendingPollTimers = new Map<string, ReturnType<typeof setInterval>>();

export const useMediaStore = create<MediaState>((set, get) => ({
  assets: [],
  isLoading: false,
  uploadingCount: 0,
  analyzingIds: new Set(),

  upsertAsset: (rawAsset) => {
    const asset = normalizeAsset(rawAsset);
    set((state) => {
      const exists = state.assets.some((item) => item.id === asset.id);
      return {
        assets: exists
          ? state.assets.map((item) => (item.id === asset.id ? asset : item))
          : [asset, ...state.assets],
      };
    });
  },

  loadAssets: async (projectId) => {
    set({ isLoading: true });
    const res = await apiFetch<MediaAsset[]>(`/api/projects/${projectId}/media`);
    if (res.success && res.data) {
      const assets = res.data.map(normalizeAsset);
      const needsProxy = assets.filter((asset) =>
        asset.type === "video" &&
        !asset.proxyUrl &&
        asset.metadata?.proxyStatus !== "processing" &&
        asset.metadata?.proxyStatus !== "error"
      );
      set({
        assets: assets.map((asset) => needsProxy.some((candidate) => candidate.id === asset.id)
          ? { ...asset, metadata: { ...asset.metadata, proxyStatus: "processing" } }
          : asset),
        isLoading: false,
      });
      if (needsProxy.length > 0) {
        void apiFetch(`/api/projects/${projectId}/media/proxy-all`, { method: "POST" });
      }
      get().pollPendingAnalysis(projectId);
    } else {
      set({ isLoading: false });
    }
  },

  uploadFile: async (projectId, file) => {
    set((s) => ({ uploadingCount: s.uploadingCount + 1 }));
    const formData = new FormData();
    formData.append("file", file);

    const res = await apiUpload<MediaAsset>(
      `/api/projects/${projectId}/media`,
      formData
    );

    set((s) => ({ uploadingCount: s.uploadingCount - 1 }));

    if (res.success && res.data) {
      const asset = normalizeAsset(res.data);
      set((s) => ({ assets: [...s.assets, asset] }));
      toast.success(`Uploaded ${file.name}`);
      get().pollPendingAnalysis(projectId);
      return asset;
    }
    toast.error(`Failed to upload ${file.name}`);
    return null;
  },

  deleteAsset: async (projectId, assetId) => {
    const res = await apiFetch(`/api/projects/${projectId}/media/${assetId}`, {
      method: "DELETE",
    });
    if (res.success) {
      set((s) => ({ assets: s.assets.filter((a) => a.id !== assetId) }));
      toast.success("Asset deleted");
    } else {
      toast.error("Failed to delete asset");
    }
  },

  refreshAsset: async (projectId, assetId) => {
    const res = await apiFetch<MediaAsset>(
      `/api/projects/${projectId}/media/${assetId}`
    );
    if (res.success && res.data) {
      const asset = normalizeAsset(res.data);
      set((s) => ({
        assets: s.assets.map((a) => (a.id === assetId ? asset : a)),
      }));
      return asset;
    }
    return null;
  },

  reanalyzeAsset: async (projectId, assetId) => {
    set((s) => {
      const next = new Set(s.analyzingIds);
      next.add(assetId);
      return { analyzingIds: next };
    });
    // Optimistic pending (vision + audio for A/V)
    set((s) => ({
      assets: s.assets.map((a) =>
        a.id === assetId
          ? {
              ...a,
              metadata: {
                ...a.metadata,
                analysisStatus: "pending" as const,
                ...((a.type === "audio" || a.type === "video")
                  ? { audioAnalysisStatus: "pending" as const }
                  : {}),
              },
            }
          : a
      ),
    }));

    const res = await apiFetch<{ asset: MediaAsset }>(
      `/api/projects/${projectId}/media/${assetId}/analyze`,
      { method: "POST" }
    );

    set((s) => {
      const next = new Set(s.analyzingIds);
      next.delete(assetId);
      return { analyzingIds: next };
    });

    if (res.success && res.data?.asset) {
      const asset = normalizeAsset(res.data.asset);
      set((s) => ({
        assets: s.assets.map((a) => (a.id === assetId ? asset : a)),
      }));
      toast.success("Analysis updated");
      return asset;
    }
    toast.error("Analysis failed");
    get().pollPendingAnalysis(projectId);
    return null;
  },

  createProxy: async (projectId, assetId) => {
    const res = await apiFetch(`/api/projects/${projectId}/media/${assetId}/proxy`, { method: "POST" });
    if (!res.success) { toast.error("Could not start proxy generation"); return; }
    set((s) => ({ assets: s.assets.map((asset) => asset.id === assetId ? { ...asset, metadata: { ...asset.metadata, proxyStatus: "processing" } } : asset) }));
    toast.success("Creating editorial proxy…");
    get().pollPendingAnalysis(projectId);
  },

  clearProxy: async (projectId, assetId) => {
    const res = await apiFetch(`/api/projects/${projectId}/media/${assetId}/proxy`, { method: "DELETE" });
    if (!res.success) { toast.error("Could not remove proxy"); return; }
    set((s) => ({ assets: s.assets.map((asset) => asset.id === assetId ? { ...asset, proxyUrl: null, metadata: { ...asset.metadata, proxyStatus: "none", proxyError: undefined, proxyProfile: undefined } } : asset) }));
  },

  relinkAsset: async (projectId, assetId, file) => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await apiUpload<MediaAsset>(`/api/projects/${projectId}/media/${assetId}/relink`, formData);
    if (!res.success || !res.data) { toast.error("Could not relink media"); return null; }
    const asset = normalizeAsset(res.data);
    set((s) => ({ assets: s.assets.map((item) => item.id === assetId ? asset : item) }));
    toast.success(`Relinked ${file.name}`);
    get().pollPendingAnalysis(projectId);
    return asset;
  },

  analyzeAll: async (projectId) => {
    const res = await apiFetch(`/api/projects/${projectId}/media/analyze-all`, {
      method: "POST",
      body: JSON.stringify({ onlyMissing: true }),
    });
    if (res.success) {
      toast.success("Analyzing media library…");
      // Mark missing as pending for UI
      set((s) => ({
        assets: s.assets.map((a) =>
          a.metadata?.analysisStatus === "ready"
            ? a
            : {
                ...a,
                metadata: { ...a.metadata, analysisStatus: "pending" as const },
              }
        ),
      }));
      get().pollPendingAnalysis(projectId);
    } else {
      toast.error("Could not start analysis");
    }
  },

  pollPendingAnalysis: (projectId) => {
    const existing = pendingPollTimers.get(projectId);
    if (existing) clearInterval(existing);

    let ticks = 0;
    const timer = setInterval(async () => {
      ticks += 1;
      const pending = get().assets.filter((asset) => isAnalysisPending(asset) || isProxyPending(asset));
      if (pending.length === 0) {
        clearInterval(timer);
        pendingPollTimers.delete(projectId);
        return;
      }
      // ~3 minutes at 1.5s interval; keep going while anything is pending
      if (ticks > 120) {
        clearInterval(timer);
        pendingPollTimers.delete(projectId);
        return;
      }

      let anyBecameReady = false;
      await Promise.all(
        pending.map(async (a) => {
          const res = await apiFetch<MediaAsset>(
            `/api/projects/${projectId}/media/${a.id}`
          );
          if (res.success && res.data) {
            const asset = normalizeAsset(res.data);
            if (
              asset.metadata?.analysisStatus !== "pending" &&
              asset.metadata?.audioAnalysisStatus !== "pending" &&
              asset.metadata?.proxyStatus !== "processing"
            ) {
              anyBecameReady = true;
            }
            set((s) => ({
              assets: s.assets.map((x) => (x.id === a.id ? asset : x)),
            }));
          }
        })
      );
      if (anyBecameReady) ticks = Math.max(0, ticks - 10);
    }, 1500);

    pendingPollTimers.set(projectId, timer);
  },

  reset: () => {
    for (const t of pendingPollTimers.values()) clearInterval(t);
    pendingPollTimers.clear();
    set({ assets: [], isLoading: false, uploadingCount: 0, analyzingIds: new Set() });
  },
}));
