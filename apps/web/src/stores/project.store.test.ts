import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/lib/api-client", () => ({ apiFetch }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useProjectStore } from "./project.store";
import { useTimelineStore } from "./timeline.store";

describe("project autosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiFetch.mockReset();
    useProjectStore.getState().reset();
    useProjectStore.setState({ id: "project-1" });
  });

  afterEach(() => {
    useProjectStore.getState().reset();
    vi.useRealTimers();
  });

  it("marks name and settings changes dirty and persists them", async () => {
    apiFetch.mockResolvedValue({ success: true, data: {} });

    useProjectStore.getState().setName("Renamed");
    useProjectStore.getState().updateSettings({ fps: 60 });
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(apiFetch.mock.calls[0]![1].body)).toMatchObject({
      name: "Renamed",
      settings: { fps: 60 },
    });
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);
  });

  it("queues edits made while a save request is in flight", async () => {
    let resolveFirst!: (value: { success: boolean; data: object }) => void;
    apiFetch
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ success: true, data: {} });

    useProjectStore.getState().setName("First");
    const firstSave = useProjectStore.getState().saveProject();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));

    useProjectStore.getState().setName("Second");
    resolveFirst({ success: true, data: {} });
    await firstSave;
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(apiFetch.mock.calls[1]![1].body).name).toBe("Second");
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);
  });

  it("waits for an active save and then persists the latest dimensions", async () => {
    let resolveFirst!: (value: { success: boolean; data: object }) => void;
    apiFetch
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ success: true, data: {} });

    const firstSave = useProjectStore.getState().saveProject();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    useProjectStore.getState().updateSettings({ width: 1080, height: 1920 });
    const agentSaveBarrier = useProjectStore.getState().saveProject();

    resolveFirst({ success: true, data: {} });
    await firstSave;
    await agentSaveBarrier;
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(apiFetch.mock.calls[1]![1].body).settings).toMatchObject({
      width: 1080,
      height: 1920,
    });
  });

  it("applies an agent surface snapshot atomically and schedules one save", async () => {
    apiFetch.mockResolvedValue({ success: true, data: {} });
    const settings = {
      ...useProjectStore.getState().settings,
      width: 1080,
      height: 1920,
      duration: 12,
    };
    useProjectStore.getState().applyAgentSurfaces({
      settings,
      cameras: [{ id: "camera", name: "Camera", position: [0, 0, 0], rotation: [0, 0, 0], fov: 50, near: 0.1, far: 1000, enabled: true }],
      markers: [{ id: "marker", time: 2, label: "Beat", color: "#ffffff" }],
    });

    expect(useProjectStore.getState().settings).toEqual(settings);
    expect(useProjectStore.getState().cameras).toHaveLength(1);
    expect(useProjectStore.getState().markers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("does not dirty the project again while capturing the autosave snapshot", async () => {
    apiFetch
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: "project-1",
          name: "Autosave",
          updatedAt: "2026-08-11T09:45:00.000Z",
          settings: { width: 1920, height: 1080, fps: 30, duration: 0, backgroundColor: "#000", sampleRate: 44100 },
          data: { tracks: [], transitions: [], sequences: [] },
        },
      })
      .mockResolvedValue({ success: true, data: {} });

    await useProjectStore.getState().loadProject("project-1");
    expect(useProjectStore.getState().lastSavedAt).toBe("2026-08-11T09:45:00.000Z");
    useTimelineStore.getState().addTrack("Video", "video");
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);
    expect(apiFetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(6000);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);
  });
});
