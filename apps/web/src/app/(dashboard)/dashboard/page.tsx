"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth.store";
import { apiFetch } from "@/lib/api-client";
import { parseTempoProjectFile, projectFileData } from "@/lib/project-file";
import { listDeliveryProfiles } from "@tempo/editor-core";
import type { DeliveryProfileId } from "@tempo/types";

const DELIVERY_PROFILES = listDeliveryProfiles();

interface ProjectItem {
  id: string;
  name: string;
  thumbnailUrl: string | null;
  duration: number;
  createdAt: string;
  updatedAt: string;
}

export default function DashboardPage() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading: authLoading, logout } = useAuthStore();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [deliveryProfileId, setDeliveryProfileId] = useState<DeliveryProfileId>("youtube-landscape");
  const [creating, setCreating] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push("/login");
    }
  }, [authLoading, isAuthenticated, router]);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void (async () => {
      const res = await apiFetch<ProjectItem[]>("/api/projects");
      if (cancelled) return;
      if (res.success && res.data) setProjects(res.data);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  async function createProject() {
    if (!newProjectName.trim()) return;
    setCreating(true);

    const profile = DELIVERY_PROFILES.find((candidate) => candidate.id === deliveryProfileId)
      ?? DELIVERY_PROFILES.find((candidate) => candidate.id === "youtube-landscape")!;
    const res = await apiFetch<{ id: string }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: newProjectName,
        settings: {
          width: profile.width,
          height: profile.height,
          fps: profile.fps,
          deliveryProfile: profile,
        },
      }),
    });

    if (res.success && res.data) {
      router.push(`/editor/${res.data.id}`);
    }
    setCreating(false);
    setShowCreateModal(false);
  }

  async function handleImportProject(file: File) {
    try {
      const text = await file.text();
      const data = parseTempoProjectFile(text);
      if (!data) {
        toast.error("Invalid .tempo.json file");
        return;
      }
      const res = await apiFetch<{ id: string }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: data.name, settings: data.settings }),
      });
      if (!res.success || !res.data) {
        toast.error("Failed to create imported project");
        return;
      }
      const updated = await apiFetch(`/api/projects/${res.data.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: data.name,
            settings: data.settings,
            data: projectFileData(data),
          }),
      });
      if (!updated.success) {
        await apiFetch(`/api/projects/${res.data.id}`, { method: "DELETE" });
        toast.error("Failed to restore imported project data");
        return;
      }
      toast.success("Project imported!");
      router.push(`/editor/${res.data.id}`);
    } catch {
      toast.error("Failed to import project");
    }
  }

  async function deleteProject(id: string) {
    if (!confirm("Delete this project? This cannot be undone.")) return;

    const res = await apiFetch(`/api/projects/${id}`, { method: "DELETE" });
    if (res.success) {
      setProjects((prev) => prev.filter((p) => p.id !== id));
      toast.success("Project deleted");
    } else {
      toast.error("Failed to delete project");
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatDuration(seconds: number) {
    if (seconds === 0) return "0s";
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
        <div className="w-5 h-5 border-2 border-zinc-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      {/* Header */}
      <header className="border-b border-[var(--border-default)] px-6 py-3 bg-[var(--bg-secondary)]">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded bg-zinc-100 text-zinc-950 flex items-center justify-center font-bold text-xs">
              T
            </div>
            <span className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">Tempo</span>
          </div>

          <div className="flex items-center gap-4 text-xs">
            <span className="text-[var(--text-secondary)] font-medium">{user?.name}</span>
            <button
              onClick={async () => { await logout(); router.push("/"); }}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-lg font-bold tracking-tight text-[var(--text-primary)]">Projects</h1>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {projects.length} project{projects.length !== 1 ? "s" : ""} in workspace
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => importFileRef.current?.click()}
              className="px-3 py-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-xs font-medium transition-colors"
            >
              Import
            </button>
            <input
              ref={importFileRef}
              type="file"
              accept=".json,.tempo.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleImportProject(file);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-3.5 py-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-950 rounded-[var(--radius-sm)] font-medium text-xs transition-colors flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              New Project
            </button>
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="border border-[var(--border-default)] rounded-[var(--radius-md)] bg-[var(--bg-secondary)] overflow-hidden">
                <div className="aspect-video bg-zinc-800/50 animate-pulse" />
                <div className="p-3 space-y-2">
                  <div className="w-3/4 h-3 rounded bg-zinc-800 animate-pulse" />
                  <div className="w-1/2 h-2.5 rounded bg-zinc-800/60 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-20 border border-dashed border-[var(--border-default)] rounded-[var(--radius-lg)] bg-[var(--bg-secondary)]">
            <div className="w-10 h-10 rounded-[var(--radius-md)] border border-zinc-800 bg-zinc-900 flex items-center justify-center mx-auto mb-3">
              <svg className="w-5 h-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
              </svg>
            </div>
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-1">No projects found</h3>
            <p className="text-xs text-[var(--text-muted)] mb-4">Create your first project to open the timeline editor.</p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-3.5 py-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-950 rounded-[var(--radius-sm)] text-xs font-medium transition-colors"
            >
              Create Project
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((project) => (
              <div
                key={project.id}
                className="group border border-[var(--border-default)] rounded-[var(--radius-md)] bg-[var(--bg-secondary)] overflow-hidden hover:border-zinc-700 transition-colors cursor-pointer"
                onClick={() => router.push(`/editor/${project.id}`)}
              >
                {/* Thumbnail container */}
                <div className="aspect-video bg-[var(--bg-tertiary)] flex items-center justify-center border-b border-[var(--border-default)]">
                  {project.thumbnailUrl ? (
                    <img src={project.thumbnailUrl} alt={project.name} className="w-full h-full object-cover" />
                  ) : (
                    <svg className="w-8 h-8 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
                    </svg>
                  )}
                </div>

                {/* Card footer */}
                <div className="p-3">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-xs font-semibold text-[var(--text-primary)] truncate group-hover:text-zinc-300 transition-colors">
                        {project.name}
                      </h3>
                      <p className="text-[11px] font-mono text-[var(--text-muted)] mt-1">
                        {formatDuration(project.duration)} · {formatDate(project.updatedAt)}
                      </p>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteProject(project.id); }}
                      className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-zinc-800 transition-colors opacity-0 group-hover:opacity-100"
                      title="Delete project"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs" onClick={() => setShowCreateModal(false)}>
          <div
            className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 w-full max-w-sm mx-4 animate-fade-in"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-bold text-[var(--text-primary)] mb-3">Create New Project</h2>
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="e.g. Summer Commercial Reel"
              autoFocus
              className="w-full px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--bg-primary)] border border-[var(--border-default)] text-[var(--text-primary)] text-xs placeholder:text-[var(--text-muted)] focus:border-zinc-400 focus:outline-none transition-colors mb-3"
              onKeyDown={(e) => e.key === "Enter" && createProject()}
            />
            <div className="mb-4">
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Delivery format</div>
              <div className="grid max-h-48 grid-cols-2 gap-1.5 overflow-y-auto pr-0.5">
                {DELIVERY_PROFILES.map((profile) => {
                  const selected = deliveryProfileId === profile.id;
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      onClick={() => setDeliveryProfileId(profile.id)}
                      className={`rounded border px-2 py-2 text-left transition-colors ${selected ? "border-blue-500 bg-blue-500/10" : "border-[var(--border-default)] bg-[var(--bg-primary)] hover:border-zinc-600"}`}
                    >
                      <div className="text-[11px] font-medium text-[var(--text-primary)]">{profile.label}</div>
                      <div className="mt-0.5 font-mono text-[9px] text-[var(--text-muted)]">{profile.width}×{profile.height} · {profile.fps}fps</div>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex justify-end gap-2 text-xs">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-3 py-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={createProject}
                disabled={creating || !newProjectName.trim()}
                className="px-3.5 py-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-950 disabled:opacity-50 rounded-[var(--radius-sm)] font-medium transition-colors"
              >
                {creating ? "Creating..." : "Create Project"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
