"use client";

import { useCallback, useRef, useState } from "react";
import { Toolbar } from "@/components/editor/Toolbar";
import { Preview } from "@/components/editor/Preview";
import { Timeline } from "@/components/editor/Timeline";
import { MediaBin } from "@/components/editor/MediaBin";
import { Inspector } from "@/components/editor/Inspector";
import { Layers } from "@/components/editor/Layers";
import { EffectsBrowser } from "@/components/editor/Effects";
import { GraphicsLibrary } from "@/components/editor/GraphicsLibrary";
import { TrackingWorkspace } from "@/components/editor/TrackingWorkspace";
import { CompositingWorkspace } from "@/components/editor/CompositingWorkspace";
import { MotionGraphWorkspace } from "@/components/editor/MotionGraphWorkspace";
import { HistoryPanel } from "@/components/editor/HistoryPanel";
import AIChat from "@/components/editor/AIChat";
import { ExportDialog } from "@/components/editor/ExportDialog";
import { AudioMixer } from "@/components/editor/AudioMixer";
import { ShortcutReference } from "@/components/editor/ShortcutReference";
import { useUIStore } from "@/stores/ui.store";

function ResizeHandle({
  direction,
  onResize,
  onResizeEnd,
}: {
  direction: "horizontal" | "vertical";
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
}) {
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startPos = direction === "horizontal" ? e.clientX : e.clientY;

      const handleMouseMove = (e: MouseEvent) => {
        const currentPos = direction === "horizontal" ? e.clientX : e.clientY;
        onResize(currentPos - startPos);
      };

      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        onResizeEnd?.();
      };

      document.body.style.cursor =
        direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [direction, onResize, onResizeEnd]
  );

  return (
    <div
      onMouseDown={handleMouseDown}
      className={`flex-shrink-0 bg-transparent hover:bg-blue-500/40 active:bg-blue-500/60 transition-colors z-10 ${
        direction === "horizontal"
          ? "w-1 cursor-col-resize"
          : "h-1 cursor-row-resize"
      }`}
    />
  );
}

function RightSidebarTabs() {
  const panels = useUIStore((s) => s.panels);
  const tabs: { key: string; label: string }[] = [];
  if (panels.inspector) tabs.push({ key: "inspector", label: "Inspector" });
  if (panels.effects) tabs.push({ key: "effects", label: "Effects" });
  if (panels.graphics) tabs.push({ key: "graphics", label: "Graphics" });
  if (panels.tracking) tabs.push({ key: "tracking", label: "Tracking" });
  if (panels.compositing) tabs.push({ key: "compositing", label: "Rigs" });
  if (panels.motionGraph) tabs.push({ key: "motionGraph", label: "Motion" });
  if (panels.aiChat) tabs.push({ key: "aiChat", label: "AI" });

  const [activeTab, setActiveTab] = useState(tabs[0]?.key || "inspector");
  const currentTab = tabs.find((t) => t.key === activeTab) ? activeTab : tabs[0]?.key || "inspector";

  return (
    <div className="h-full flex flex-col">
      {tabs.length > 1 && (
        <div className="flex border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 px-3 py-1.5 text-[11px] font-medium transition-colors ${
                currentTab === tab.key
                  ? "text-[var(--text-primary)] border-b-2 border-zinc-400"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        {currentTab === "inspector" && <Inspector />}
        {currentTab === "effects" && <EffectsBrowser />}
        {currentTab === "graphics" && <GraphicsLibrary />}
        {currentTab === "tracking" && <TrackingWorkspace />}
        {currentTab === "compositing" && <CompositingWorkspace />}
        {currentTab === "motionGraph" && <MotionGraphWorkspace />}
        {currentTab === "aiChat" && <AIChat />}
      </div>
    </div>
  );
}

function LeftSidebarTabs() {
  const panels = useUIStore((s) => s.panels);
  const tabs: { key: string; label: string }[] = [];
  if (panels.mediaBin) tabs.push({ key: "media", label: "Media" });
  if (panels.layers) tabs.push({ key: "layers", label: "Layers" });
  if (panels.history) tabs.push({ key: "history", label: "History" });

  const [activeTab, setActiveTab] = useState(tabs[0]?.key || "media");
  const currentTab = tabs.find((t) => t.key === activeTab) ? activeTab : tabs[0]?.key || "media";

  return (
    <div className="h-full flex flex-col">
      {tabs.length > 1 && (
        <div className="flex border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 px-3 py-1.5 text-[11px] font-medium transition-colors ${
                currentTab === tab.key
                  ? "text-[var(--text-primary)] border-b-2 border-zinc-400"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        {currentTab === "media" && <MediaBin />}
        {currentTab === "layers" && <Layers />}
        {currentTab === "history" && <HistoryPanel />}
      </div>
    </div>
  );
}

export function EditorLayout() {
  const panels = useUIStore((s) => s.panels);
  const panelSizes = useUIStore((s) => s.panelSizes);
  const setPanelSize = useUIStore((s) => s.setPanelSize);

  const mediaBinBaseRef = useRef(panelSizes.mediaBin);
  const inspectorBaseRef = useRef(panelSizes.inspector);
  const timelineBaseRef = useRef(panelSizes.timeline);

  const onMediaBinResize = useCallback(
    (delta: number) => {
      const next = Math.max(200, Math.min(400, mediaBinBaseRef.current + delta));
      setPanelSize("mediaBin", next);
    },
    [setPanelSize]
  );

  const onMediaBinResizeEnd = useCallback(() => {
    mediaBinBaseRef.current = useUIStore.getState().panelSizes.mediaBin;
  }, []);

  const onInspectorResize = useCallback(
    (delta: number) => {
      const next = Math.max(220, Math.min(420, inspectorBaseRef.current - delta));
      setPanelSize("inspector", next);
    },
    [setPanelSize]
  );

  const onInspectorResizeEnd = useCallback(() => {
    inspectorBaseRef.current = useUIStore.getState().panelSizes.inspector;
  }, []);

  const onTimelineResize = useCallback(
    (delta: number) => {
      const next = Math.max(150, Math.min(600, timelineBaseRef.current - delta));
      setPanelSize("timeline", next);
    },
    [setPanelSize]
  );

  const onTimelineResizeEnd = useCallback(() => {
    timelineBaseRef.current = useUIStore.getState().panelSizes.timeline;
  }, []);

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-primary)] overflow-hidden select-none">
      <Toolbar />

      <div className="flex-1 flex overflow-hidden">
        {(panels.mediaBin || panels.layers || panels.history) && (
          <>
            <div
              className="flex-shrink-0 overflow-hidden flex flex-col"
              style={{ width: panelSizes.mediaBin }}
            >
              {[panels.mediaBin, panels.layers, panels.history].filter(Boolean).length > 1 ? (
                <LeftSidebarTabs />
              ) : panels.layers ? (
                <Layers />
              ) : panels.history ? (
                <HistoryPanel />
              ) : (
                <MediaBin />
              )}
            </div>
            <ResizeHandle direction="horizontal" onResize={onMediaBinResize} onResizeEnd={onMediaBinResizeEnd} />
          </>
        )}

        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <Preview />
          </div>
        </div>

        {(panels.inspector || panels.effects || panels.graphics || panels.tracking || panels.compositing || panels.motionGraph || panels.aiChat) && (
          <>
            <ResizeHandle direction="horizontal" onResize={onInspectorResize} onResizeEnd={onInspectorResizeEnd} />
            <div
              className="flex-shrink-0 overflow-hidden flex flex-col"
              style={{ width: panelSizes.inspector }}
            >
              {[panels.inspector, panels.effects, panels.graphics, panels.tracking, panels.compositing, panels.motionGraph, panels.aiChat].filter(Boolean).length > 1 ? (
                <RightSidebarTabs />
              ) : panels.aiChat ? (
                <AIChat />
              ) : panels.effects ? (
                <EffectsBrowser />
              ) : panels.graphics ? (
                <GraphicsLibrary />
              ) : panels.tracking ? (
                <TrackingWorkspace />
              ) : panels.compositing ? (
                <CompositingWorkspace />
              ) : panels.motionGraph ? (
                <MotionGraphWorkspace />
              ) : (
                <Inspector />
              )}
            </div>
          </>
        )}
      </div>

      {panels.audioMixer && (
        <div className="flex-shrink-0 h-[160px] border-t border-[var(--border-default)]">
          <AudioMixer />
        </div>
      )}

      {panels.timeline && (
        <>
          <ResizeHandle direction="vertical" onResize={onTimelineResize} onResizeEnd={onTimelineResizeEnd} />
          <div
            className="flex-shrink-0 overflow-hidden"
            style={{ height: panelSizes.timeline }}
          >
            <Timeline />
          </div>
        </>
      )}

      <ExportDialog />
      <ShortcutReference />
    </div>
  );
}
