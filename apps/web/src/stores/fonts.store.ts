import { create } from "zustand";
import { toast } from "sonner";
import { apiFetch, apiUpload } from "@/lib/api-client";
import type { FontAsset } from "@tempo/types";
import {
  registerFontAsset,
  clearRegisteredFontAssets,
  loadFontById,
  unregisterFontAsset,
  registerGoogleFontCatalog,
  type GoogleFontCatalogPayloadEntry,
} from "@/lib/fonts";

interface FontsState {
  fonts: FontAsset[];
  isLoading: boolean;
  uploading: boolean;
  /** Set after a successful load for this project (including empty list). */
  loadedProjectId: string | null;

  loadFonts: (projectId: string) => Promise<void>;
  uploadFont: (projectId: string, file: File, familyName?: string) => Promise<FontAsset | null>;
  deleteFont: (projectId: string, fontId: string) => Promise<void>;
  reset: () => void;
}

let loadGeneration = 0;

export const useFontsStore = create<FontsState>((set) => ({
  fonts: [],
  isLoading: false,
  uploading: false,
  loadedProjectId: null,

  loadFonts: async (projectId) => {
    const gen = ++loadGeneration;
    set({ isLoading: true });
    const [res, googleCatalog] = await Promise.all([
      apiFetch<FontAsset[]>(`/api/projects/${projectId}/fonts`),
      apiFetch<GoogleFontCatalogPayloadEntry[]>(`/api/projects/${projectId}/fonts/google-catalog`),
    ]);
    if (gen !== loadGeneration) return;

    if (googleCatalog.success && googleCatalog.data) {
      registerGoogleFontCatalog(googleCatalog.data);
    }

    if (res.success && res.data) {
      clearRegisteredFontAssets();
      for (const font of res.data) {
        if (gen !== loadGeneration) return;
        registerFontAsset(font);
        await loadFontById(font.id);
      }
      if (gen !== loadGeneration) return;
      set({ fonts: res.data, isLoading: false, loadedProjectId: projectId });
    } else {
      set({ isLoading: false, loadedProjectId: projectId });
    }
  },

  uploadFont: async (projectId, file, familyName) => {
    set({ uploading: true });
    const formData = new FormData();
    formData.append("file", file);
    if (familyName) formData.append("familyName", familyName);

    const res = await apiUpload<FontAsset>(
      `/api/projects/${projectId}/fonts`,
      formData
    );
    set({ uploading: false });

    if (res.success && res.data) {
      registerFontAsset(res.data);
      const family = await loadFontById(res.data.id);
      set((s) => ({ fonts: [...s.fonts, res.data!] }));
      if (family) {
        toast.success(`Uploaded font ${res.data.familyName}`);
      } else {
        toast.warning(
          `Saved ${res.data.familyName}, but the browser could not load the font file`
        );
      }
      return res.data;
    }
    toast.error(res.error || `Failed to upload ${file.name}`);
    return null;
  },

  deleteFont: async (projectId, fontId) => {
    const res = await apiFetch(`/api/projects/${projectId}/fonts/${fontId}`, {
      method: "DELETE",
    });
    if (res.success) {
      unregisterFontAsset(fontId);
      set((s) => ({ fonts: s.fonts.filter((f) => f.id !== fontId) }));
      toast.success("Font deleted");
    } else {
      toast.error("Failed to delete font");
    }
  },

  reset: () => {
    loadGeneration += 1;
    clearRegisteredFontAssets();
    set({ fonts: [], isLoading: false, uploading: false, loadedProjectId: null });
  },
}));
