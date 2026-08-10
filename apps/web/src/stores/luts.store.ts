import { create } from "zustand";
import { toast } from "sonner";
import { apiFetch, apiUpload } from "@/lib/api-client";
import type { LutAsset } from "@tempo/types";
import {
  registerLutAsset,
  clearRegisteredLutAssets,
  loadLutById,
  unregisterLutAsset,
  notifyLutReady,
} from "@/lib/luts";

interface LutsState {
  luts: LutAsset[];
  isLoading: boolean;
  uploading: boolean;
  /** Set after a successful load for this project (including empty list). */
  loadedProjectId: string | null;

  loadLuts: (projectId: string) => Promise<void>;
  uploadLut: (projectId: string, file: File, name?: string) => Promise<LutAsset | null>;
  deleteLut: (projectId: string, lutId: string) => Promise<void>;
  reset: () => void;
}

let loadGeneration = 0;

export const useLutsStore = create<LutsState>((set) => ({
  luts: [],
  isLoading: false,
  uploading: false,
  loadedProjectId: null,

  loadLuts: async (projectId) => {
    const gen = ++loadGeneration;
    set({ isLoading: true });
    const res = await apiFetch<LutAsset[]>(`/api/projects/${projectId}/luts`);
    if (gen !== loadGeneration) return;

    if (res.success && res.data) {
      clearRegisteredLutAssets();
      for (const lut of res.data) {
        if (gen !== loadGeneration) return;
        registerLutAsset(lut);
        await loadLutById(lut.id);
      }
      if (gen !== loadGeneration) return;
      set({ luts: res.data, isLoading: false, loadedProjectId: projectId });
      notifyLutReady();
    } else {
      set({ isLoading: false, loadedProjectId: projectId });
    }
  },

  uploadLut: async (projectId, file, name) => {
    set({ uploading: true });
    const formData = new FormData();
    formData.append("file", file);
    if (name) formData.append("name", name);

    const res = await apiUpload<LutAsset>(
      `/api/projects/${projectId}/luts`,
      formData
    );
    set({ uploading: false });

    if (res.success && res.data) {
      registerLutAsset(res.data);
      await loadLutById(res.data.id);
      set((s) => ({ luts: [...s.luts, res.data!] }));
      notifyLutReady();
      toast.success(`Uploaded LUT ${res.data.name}`);
      return res.data;
    }
    toast.error(res.error || `Failed to upload ${file.name}`);
    return null;
  },

  deleteLut: async (projectId, lutId) => {
    const res = await apiFetch(`/api/projects/${projectId}/luts/${lutId}`, {
      method: "DELETE",
    });
    if (res.success) {
      unregisterLutAsset(lutId);
      set((s) => ({ luts: s.luts.filter((l) => l.id !== lutId) }));
      notifyLutReady();
      toast.success("LUT deleted");
    } else {
      toast.error("Failed to delete LUT");
    }
  },

  reset: () => {
    loadGeneration += 1;
    clearRegisteredLutAssets();
    set({ luts: [], isLoading: false, uploading: false, loadedProjectId: null });
  },
}));
