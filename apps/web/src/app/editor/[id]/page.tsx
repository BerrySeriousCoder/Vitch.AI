"use client";

import { useEffect } from "react";
import type { Socket } from "socket.io-client";
import { useParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth.store";
import { useProjectStore } from "@/stores/project.store";
import { useTimelineStore } from "@/stores/timeline.store";
import { usePlaybackStore } from "@/stores/playback.store";
import { useSelectionStore } from "@/stores/selection.store";
import { useAIStore } from "@/stores/ai.store";
import { useRenderStore } from "@/stores/render.store";
import { useFontsStore } from "@/stores/fonts.store";
import { useLutsStore } from "@/stores/luts.store";
import { getAccessToken } from "@/lib/api-client";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { usePlaybackLoop } from "@/hooks/use-playback-loop";
import { EditorLayout } from "@/components/editor/EditorLayout";

export default function EditorPage() {
  const params = useParams();
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuthStore();
  const { loadProject, isLoading: projectLoading, id: projectId, reset: resetProject } = useProjectStore();

  const projectParamId = params.id as string;

  useKeyboardShortcuts();
  usePlaybackLoop();

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push("/login");
    }
  }, [authLoading, isAuthenticated, router]);

  useEffect(() => {
    if (isAuthenticated && projectParamId && projectParamId !== projectId) {
      loadProject(projectParamId).then((success) => {
        if (!success) router.push("/dashboard");
        else {
          useAIStore.getState().loadConversation(projectParamId);
          void useFontsStore.getState().loadFonts(projectParamId);
          void useLutsStore.getState().loadLuts(projectParamId);
          void useRenderStore.getState().loadJobs(projectParamId);
        }
      });
    }
  }, [isAuthenticated, projectParamId, projectId, loadProject, router]);

  useEffect(() => {
    if (!isAuthenticated || !projectParamId) return;
    let socket: Socket | undefined;

    import("socket.io-client").then(({ io }) => {
      const token = getAccessToken();
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
      const connectedSocket = io(`${apiUrl}/editor`, { auth: { token } });
      socket = connectedSocket;
      connectedSocket.on("connect", () => {
        connectedSocket.emit("join-project", projectParamId);
      });
      connectedSocket.on("render:progress", (data: { jobId: string; progress: number; status: string }) => {
        useRenderStore.getState().updateJobProgress(data.jobId, data.progress, data.status);
      });
      connectedSocket.on("render:complete", (data: { jobId: string; outputUrl: string }) => {
        useRenderStore.getState().updateJobComplete(data.jobId, data.outputUrl);
      });
      connectedSocket.on("render:failed", (data: { jobId: string; error: string }) => {
        useRenderStore.getState().updateJobFailed(data.jobId, data.error);
      });
    });

    return () => {
      if (socket) socket.disconnect();
    };
  }, [isAuthenticated, projectParamId]);

  useEffect(() => {
    return () => {
      resetProject();
      useTimelineStore.getState().reset();
      usePlaybackStore.getState().reset();
      useSelectionStore.getState().deselectAll();
      useAIStore.getState().reset();
      useRenderStore.getState().reset();
      useFontsStore.getState().reset();
      useLutsStore.getState().reset();
    };
  }, [resetProject]);

  if (authLoading || projectLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[var(--bg-primary)]">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-[var(--tempo-primary)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-sm text-[var(--text-muted)]">Loading project...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return <EditorLayout />;
}
