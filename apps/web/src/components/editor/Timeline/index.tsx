"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useTimelineStore } from "@/stores/timeline.store";
import { usePlaybackStore } from "@/stores/playback.store";
import { useSelectionStore } from "@/stores/selection.store";
import { useUIStore } from "@/stores/ui.store";
import { TimeRuler } from "./TimeRuler";
import { TrackHeader } from "./TrackHeader";
import { ClipBlock } from "./ClipBlock";
import { Playhead } from "./Playhead";
import { ContextMenu } from "./ContextMenu";
import type { AudioAutomationPoint, Clip, MediaAsset, TimelineMarker } from "@tempo/types";
import { getTransitionWindow, isNestClip, normalizeAudioAutomationPoints } from "@tempo/editor-core";
import { toast } from "sonner";
import { useSequenceStore } from "@/stores/sequence.store";
import { useProjectStore } from "@/stores/project.store";

interface ContextMenuState {
  x: number;
  y: number;
  clipId: string;
  trackId: string;
}

function TrackAutomationOverlay({ trackId, zoom, width }: { trackId: string; zoom: number; width: number }) {
  const audioMixer = useProjectStore((s) => s.audioMixer);
  const setAudioMixer = useProjectStore((s) => s.setAudioMixer);
  const volume = normalizeAudioAutomationPoints(audioMixer.trackAutomation?.[trackId]?.volume, "volume");
  const pan = normalizeAudioAutomationPoints(audioMixer.trackAutomation?.[trackId]?.pan, "pan");
  if (!volume.length && !pan.length) return null;

  const pointY = (property: "volume" | "pan", value: number) => property === "volume"
    ? 21 - (Math.max(0, Math.min(2, value)) / 2) * 18
    : 45 - ((Math.max(-1, Math.min(1, value)) + 1) / 2) * 18;
  const path = (property: "volume" | "pan", points: AudioAutomationPoint[]) => points
    .map((point, index) => `${index ? "L" : "M"}${point.time * zoom} ${pointY(property, point.value)}`)
    .join(" ");
  const startDrag = (event: React.MouseEvent<SVGCircleElement>, property: "volume" | "pan", index: number) => {
    event.preventDefault();
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const edit = (next: MouseEvent) => {
      // Re-normalize from the latest store snapshot: the visible sorted index
      // remains stable even for imported envelopes that arrived unsorted.
      const points = [...normalizeAudioAutomationPoints(
        useProjectStore.getState().audioMixer.trackAutomation?.[trackId]?.[property],
        property
      )];
      const value = property === "volume"
        ? Math.max(0, Math.min(2, ((21 - (next.clientY - rect.top)) / 18) * 2))
        : Math.max(-1, Math.min(1, ((45 - (next.clientY - rect.top)) / 18) * 2 - 1));
      points[index] = { ...points[index]!, time: Math.max(0, (next.clientX - rect.left) / zoom), value };
      setAudioMixer({
        ...useProjectStore.getState().audioMixer,
        trackAutomation: {
          ...(useProjectStore.getState().audioMixer.trackAutomation || {}),
          [trackId]: {
            ...(useProjectStore.getState().audioMixer.trackAutomation?.[trackId] || {}),
            [property]: normalizeAudioAutomationPoints(points, property),
          },
        },
      });
    };
    edit(event.nativeEvent);
    const up = () => { document.removeEventListener("mousemove", edit); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", edit);
    document.addEventListener("mouseup", up);
  };
  return (
    <svg className="absolute inset-0 z-[7] overflow-visible" width={width} height={48} aria-label="Track automation lanes">
      {volume.length > 0 && <><path d={path("volume", volume)} fill="none" stroke="rgb(250 204 21)" strokeWidth="1.5" /><text x="3" y="10" fill="rgb(250 204 21)" fontSize="7">VOL</text>{volume.map((point, index) => <circle key={point.id || `v-${index}`} cx={point.time * zoom} cy={pointY("volume", point.value)} r="3" fill="rgb(254 240 138)" stroke="rgb(133 77 14)" onMouseDown={(event) => startDrag(event, "volume", index)} className="cursor-ns-resize" />)}</>}
      {pan.length > 0 && <><path d={path("pan", pan)} fill="none" stroke="rgb(103 232 249)" strokeWidth="1.5" strokeDasharray="3 2" /><text x="3" y="34" fill="rgb(103 232 249)" fontSize="7">PAN</text>{pan.map((point, index) => <circle key={point.id || `p-${index}`} cx={point.time * zoom} cy={pointY("pan", point.value)} r="3" fill="rgb(165 243 252)" stroke="rgb(14 116 144)" onMouseDown={(event) => startDrag(event, "pan", index)} className="cursor-ns-resize" />)}</>}
    </svg>
  );
}

export function Timeline() {
  const tracks = useTimelineStore((s) => s.tracks);
  const transitions = useTimelineStore((s) => s.transitions);
  const addTrack = useTimelineStore((s) => s.addTrack);
  const removeClip = useTimelineStore((s) => s.removeClip);
  const rippleRemoveClip = useTimelineStore((s) => s.rippleRemoveClip);
  const closeGap = useTimelineStore((s) => s.closeGap);
  const splitClip = useTimelineStore((s) => s.splitClip);
  const duplicateClip = useTimelineStore((s) => s.duplicateClip);
  const linkClips = useTimelineStore((s) => s.linkClips);
  const unlinkClipGroup = useTimelineStore((s) => s.unlinkClipGroup);
  const rippleRemoveLinkedGroup = useTimelineStore((s) => s.rippleRemoveLinkedGroup);
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const duration = usePlaybackStore((s) => s.duration);
  const deselectAll = useSelectionStore((s) => s.deselectAll);
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds);
  const zoom = useUIStore((s) => s.timelineZoom);
  const setTimelineZoom = useUIStore((s) => s.setTimelineZoom);
  const snapEnabled = useUIStore((s) => s.snapEnabled);
  const toggleSnap = useUIStore((s) => s.toggleSnap);
  const snapSources = useUIStore((s) => s.snapSources);
  const toggleSnapSource = useUIStore((s) => s.toggleSnapSource);
  const timelineMarkers = useProjectStore((s) => s.markers);
  const setTimelineMarkers = useProjectStore((s) => s.setMarkers);
  const editStack = useSequenceStore((s) => s.editStack);
  const exitSequence = useSequenceStore((s) => s.exitSequence);
  const exitToMain = useSequenceStore((s) => s.exitToMain);
  const enterSequence = useSequenceStore((s) => s.enterSequence);
  const createFromSelection = useSequenceStore((s) => s.createFromSelection);
  const placeOnTrack = useSequenceStore((s) => s.placeOnTrack);
  const isEditingSequence = editStack.length > 1;
  const activeSeqName = useSequenceStore((s) => s.activeSequenceName());
  const agentBanner = useSequenceStore((s) => s.agentUpdatedWhileEditing);
  const clearAgentBanner = useSequenceStore((s) => s.clearAgentBanner);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [containerWidth, setContainerWidth] = useState(800);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const trackAreaRef = useRef<HTMLDivElement>(null);

  const timelineWidth = Math.max(duration || 30, 30) * zoom + 200;
  const trackHeight = 48;
  const totalTrackHeight = tracks.length * trackHeight;
  const selectedMarker = timelineMarkers.find((marker) => marker.id === selectedMarkerId) ?? null;

  const addTimelineMarker = (time: number) => {
    const marker: TimelineMarker = {
      id: crypto.randomUUID(),
      time: Math.max(0, time),
      label: "Marker",
      color: "#f59e0b",
      type: "comment",
    };
    setTimelineMarkers([...timelineMarkers, marker].sort((a, b) => a.time - b.time));
    setSelectedMarkerId(marker.id);
  };
  const removeTimelineMarker = (id: string) => {
    setTimelineMarkers(timelineMarkers.filter((marker) => marker.id !== id));
    if (selectedMarkerId === id) setSelectedMarkerId(null);
  };
  const updateTimelineMarker = (id: string, patch: Partial<TimelineMarker>) => {
    setTimelineMarkers(timelineMarkers.map((marker) => marker.id === id ? { ...marker, ...patch, time: Math.max(0, patch.time ?? marker.time) } : marker).sort((a, b) => a.time - b.time));
  };
  const linkedRelationships = useMemo(() => {
    const byGroup = new Map<string, Array<{ clip: Clip; trackIndex: number }>>();
    tracks.forEach((track, trackIndex) => track.clips.forEach((clip) => {
      if (!clip.linkGroupId) return;
      const members = byGroup.get(clip.linkGroupId) ?? [];
      members.push({ clip, trackIndex });
      byGroup.set(clip.linkGroupId, members);
    }));
    return [...byGroup.entries()].filter(([, members]) => members.length > 1);
  }, [tracks]);

  const handleScrollAndResize = useCallback(() => {
    if (scrollContainerRef.current) {
      setScrollLeft(scrollContainerRef.current.scrollLeft);
      setContainerWidth(scrollContainerRef.current.clientWidth);
    }
  }, []);

  const handleScroll = useCallback(() => {
    handleScrollAndResize();
  }, [handleScrollAndResize]);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -10 : 10;
        setTimelineZoom(zoom + delta);
      }
    },
    [zoom, setTimelineZoom]
  );

  const handleTrackAreaClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.lane === "true") {
        deselectAll();
      }
    },
    [deselectAll]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, clipId: string, trackId: string) => {
      setContextMenu({ x: e.clientX, y: e.clientY, clipId, trackId });
    },
    []
  );

  const getSnapTargets = useCallback((): number[] => {
    const targets: number[] = [];
    if (snapSources.playhead) targets.push(currentTime);
    if (snapSources.markers) targets.push(...timelineMarkers.map((marker) => marker.time));
    if (snapSources.clipEdges) {
      for (const track of tracks) {
        for (const clip of track.clips) {
          targets.push(clip.startTime);
          targets.push(clip.startTime + clip.duration);
        }
      }
    }
    return targets;
  }, [tracks, currentTime, timelineMarkers, snapSources]);

  const handleSplit = useCallback(
    (clipId: string) => {
      splitClip(clipId, currentTime);
    },
    [splitClip, currentTime]
  );

  const handleDelete = useCallback(
    (clipId: string) => {
      removeClip(clipId);
      useSelectionStore.getState().deselectAll();
    },
    [removeClip]
  );

  const handleRippleDelete = useCallback(
    (clipId: string) => {
      const res = rippleRemoveClip(clipId);
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      useSelectionStore.getState().deselectAll();
    },
    [rippleRemoveClip]
  );

  const handleCloseGap = useCallback(
    (trackId: string) => {
      const res = closeGap(trackId);
      if (!res.ok) toast.error(res.message);
    },
    [closeGap]
  );

  const handleDuplicate = useCallback(
    (clipId: string) => {
      duplicateClip(clipId);
    },
    [duplicateClip]
  );

  const contextClip = useMemo(() => {
    if (!contextMenu) return null;
    return tracks.flatMap((track) => track.clips).find((clip) => clip.id === contextMenu.clipId) ?? null;
  }, [contextMenu, tracks]);

  const handleLinkSelected = useCallback(() => {
    if (!contextMenu) return;
    const selected = [...useSelectionStore.getState().selectedClipIds];
    const ids = selected.includes(contextMenu.clipId) ? selected : [...selected, contextMenu.clipId];
    const result = linkClips(ids);
    if (!result.ok) toast.error(result.message);
    else toast.success("Linked A/V clips");
  }, [contextMenu, linkClips]);

  const handleUnlinkGroup = useCallback((clipId: string) => {
    const result = unlinkClipGroup(clipId);
    if (!result.ok) toast.error(result.message);
    else toast.success("Unlinked A/V group");
  }, [unlinkClipGroup]);

  const handleRippleDeleteLinked = useCallback((clipId: string) => {
    const result = rippleRemoveLinkedGroup(clipId);
    if (!result.ok) toast.error(result.message);
    else toast.success("Ripple-deleted linked A/V");
  }, [rippleRemoveLinkedGroup]);

  const handleOpenSequence = useCallback(
    (clipId: string) => {
      for (const track of tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip?.sourceSequenceId) {
          const r = enterSequence(clip.sourceSequenceId);
          if (!r.ok) toast.error(r.message);
          return;
        }
      }
    },
    [tracks, enterSequence]
  );

  const handleCreateSequence = useCallback(() => {
    const ids = [...useSelectionStore.getState().selectedClipIds];
    if (ids.length === 0 && contextMenu) ids.push(contextMenu.clipId);
    const r = createFromSelection(ids);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    toast.success("Sequence created");
  }, [contextMenu, createFromSelection]);

  const contextClipIsNest = useMemo(() => {
    if (!contextMenu) return false;
    for (const track of tracks) {
      const clip = track.clips.find((c) => c.id === contextMenu.clipId);
      if (clip) return isNestClip(clip);
    }
    return false;
  }, [contextMenu, tracks]);

  const handleTrackDragOver = useCallback((e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes("application/x-tempo-asset") ||
      e.dataTransfer.types.includes("application/x-tempo-sequence")
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleTrackDrop = useCallback(
    (e: React.DragEvent, trackId: string) => {
      e.preventDefault();
      const seqRaw = e.dataTransfer.getData("application/x-tempo-sequence");
      if (seqRaw) {
        if (isEditingSequence) {
          toast.error("Place sequences only on the Main timeline");
          return;
        }
        try {
          const data = JSON.parse(seqRaw) as { id: string; duration?: number };
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const xOffset =
            e.clientX - rect.left + (scrollContainerRef.current?.scrollLeft || 0);
          const startTime = Math.max(0, xOffset / zoom);
          const res = placeOnTrack(data.id, trackId, startTime, data.duration);
          if (!res.ok) toast.error(res.message);
        } catch {
          toast.error("Invalid sequence drop");
        }
        return;
      }
      const raw = e.dataTransfer.getData("application/x-tempo-asset");
      if (!raw) return;
      try {
        const asset: MediaAsset = JSON.parse(raw);
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const xOffset = e.clientX - rect.left + (scrollContainerRef.current?.scrollLeft || 0);
        const startTime = Math.max(0, xOffset / zoom);
        const clipDuration =
          (asset.duration && asset.duration > 0 ? asset.duration : undefined) ??
          asset.metadata?.duration ??
          5;

        useTimelineStore.getState().addClip(trackId, {
          sourceMediaId: asset.id,
          startTime,
          duration: clipDuration,
          sourceOffset: 0,
          speed: 1,
          mediaLayout: asset.type === "audio" ? undefined : { schemaVersion: 1, fit: "cover", focalPoint: { x: 0.5, y: 0.5 } },
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 },
          opacity: 1,
          blendMode: "normal",
          effects: [],
          keyframes: [],
          mask: null,
          muted: false,
          volume: 1,
        });
      } catch {}
    },
    [zoom, isEditingSequence, placeOnTrack]
  );

  const isClipVisible = useCallback(
    (clip: Clip): boolean => {
      const clipLeft = clip.startTime * zoom;
      const clipRight = (clip.startTime + clip.duration) * zoom;
      const viewLeft = scrollLeft - 100;
      const viewRight = scrollLeft + containerWidth + 100;
      return clipRight >= viewLeft && clipLeft <= viewRight;
    },
    [zoom, scrollLeft, containerWidth]
  );

  return (
    <div
      className="h-full flex flex-col bg-[var(--bg-secondary)] text-[var(--text-primary)]"
      onWheel={handleWheel}
    >
      {/* Timeline header */}
      <div
        className={`h-8 border-b border-[var(--border-default)] flex items-center justify-between px-3 flex-shrink-0 ${
          isEditingSequence ? "bg-teal-950/40" : "bg-[var(--bg-tertiary)]"
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <nav className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider truncate">
            <button
              type="button"
              className={`${isEditingSequence ? "text-teal-300 hover:underline" : "text-[var(--text-secondary)]"}`}
              onClick={() => {
                if (isEditingSequence) {
                  exitToMain();
                  clearAgentBanner();
                }
              }}
            >
              Main
            </button>
            {isEditingSequence && (
              <>
                <span className="text-zinc-600">/</span>
                <span className="text-teal-200 truncate">
                  Sequence: {activeSeqName || "…"}
                </span>
              </>
            )}
          </nav>
          {isEditingSequence && (
            <button
              type="button"
              onClick={() => {
                exitSequence();
                clearAgentBanner();
              }}
              className="px-1.5 py-0.5 text-[10px] rounded bg-teal-800/50 text-teal-100 hover:bg-teal-700/50"
            >
              Done
            </button>
          )}
          {agentBanner && (
            <span className="text-[9px] text-amber-300 truncate">
              Agent updated project — Exit to see Main
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Snap toggle */}
          <button
            onClick={toggleSnap}
            className={`px-1.5 py-0.5 text-[10px] font-medium rounded border transition-colors ${
              snapEnabled
                ? "text-blue-300 bg-blue-950/40 border-blue-800"
                : "text-[var(--text-muted)] bg-[var(--bg-secondary)] border-[var(--border-default)]"
            }`}
            title="Toggle snapping"
          >
            Snap
          </button>
          <div className="flex items-center gap-0.5" title="Snap targets: clip edges, playhead, markers">
            {([
              ["clipEdges", "C", "Clip edges"],
              ["playhead", "P", "Playhead"],
              ["markers", "M", "Markers"],
            ] as const).map(([source, label, title]) => (
              <button
                key={source}
                type="button"
                onClick={() => toggleSnapSource(source)}
                title={title}
                className={`w-4 h-4 text-[9px] rounded border ${snapSources[source] ? "text-teal-200 border-teal-800 bg-teal-950/40" : "text-[var(--text-muted)] border-[var(--border-default)]"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => addTimelineMarker(currentTime)}
            className="px-1.5 py-0.5 text-[10px] font-medium rounded border text-amber-200 bg-amber-950/30 border-amber-800 hover:bg-amber-900/40"
            title="Add marker at playhead (or Shift-click the ruler)"
          >
            + Marker
          </button>

          {/* Zoom slider */}
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-[var(--text-muted)] font-mono">-</span>
            <input
              type="range"
              min="10"
              max="200"
              value={zoom}
              onChange={(e) => setTimelineZoom(Number(e.target.value))}
              className="w-16 h-1 accent-zinc-400"
            />
            <span className="text-[9px] text-[var(--text-muted)] font-mono">+</span>
          </div>

          {/* Add track buttons */}
          <div className="flex items-center gap-1">
            {(["video", "audio", "text"] as const).map((type) => (
              <button
                key={type}
                onClick={() =>
                  addTrack(
                    `${type.charAt(0).toUpperCase() + type.slice(1)} ${
                      tracks.filter((t) => t.type === type).length + 1
                    }`,
                    type
                  )
                }
                className="px-2 py-0.5 text-[10px] font-medium text-[var(--text-secondary)] hover:text-zinc-100 bg-[var(--bg-secondary)] hover:bg-[var(--bg-muted)] border border-[var(--border-default)] rounded transition-colors"
              >
                + {type.charAt(0).toUpperCase() + type.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {selectedMarker && (
        <div className="h-8 flex items-center gap-2 border-b border-amber-900/60 bg-amber-950/20 px-3 text-[10px]">
          <span className="font-mono uppercase tracking-wider text-amber-200">Marker</span>
          <input
            value={selectedMarker.label}
            onChange={(event) => updateTimelineMarker(selectedMarker.id, { label: event.target.value })}
            aria-label="Marker label"
            className="w-32 rounded border border-amber-900/70 bg-[var(--bg-primary)] px-1.5 py-1 text-[10px] text-[var(--text-primary)] outline-none focus:border-amber-500"
          />
          <input
            type="number"
            min={0}
            step={0.01}
            value={Number(selectedMarker.time.toFixed(2))}
            onChange={(event) => updateTimelineMarker(selectedMarker.id, { time: Number(event.target.value) || 0 })}
            aria-label="Marker time in seconds"
            title="Marker time in seconds"
            className="w-16 rounded border border-amber-900/70 bg-[var(--bg-primary)] px-1.5 py-1 font-mono text-[10px] text-[var(--text-primary)] outline-none focus:border-amber-500"
          />
          <select value={selectedMarker.type ?? "comment"} onChange={(event) => updateTimelineMarker(selectedMarker.id, { type: event.target.value as NonNullable<TimelineMarker["type"]> })} aria-label="Marker type" className="rounded border border-amber-900/70 bg-[var(--bg-primary)] px-1 py-1 text-[10px] text-[var(--text-primary)] outline-none focus:border-amber-500">
            <option value="comment">Comment</option><option value="chapter">Chapter</option><option value="todo">To-do</option><option value="beat">Beat</option>
          </select>
          <input type="color" value={selectedMarker.color} onChange={(event) => updateTimelineMarker(selectedMarker.id, { color: event.target.value })} aria-label="Marker color" className="h-5 w-6 cursor-pointer rounded border border-amber-900/70 bg-transparent p-0" />
          <button type="button" onClick={() => removeTimelineMarker(selectedMarker.id)} className="ml-auto text-[10px] text-red-300 hover:text-red-100">Delete</button>
          <button type="button" onClick={() => setSelectedMarkerId(null)} className="text-[13px] leading-none text-[var(--text-muted)] hover:text-zinc-100" title="Close marker editor">×</button>
        </div>
      )}

      {/* Timeline body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Track headers */}
        <div className="w-40 flex-shrink-0 border-r border-[var(--border-default)] overflow-y-auto bg-[var(--bg-secondary)]">
          <div className="h-6 border-b border-[var(--border-default)] bg-[var(--bg-tertiary)]" />

          {tracks.length === 0 ? (
            <div className="flex items-center justify-center h-20 text-[11px] text-[var(--text-muted)]">
              No tracks
            </div>
          ) : (
            tracks.map((track) => (
              <TrackHeader key={track.id} track={track} />
            ))
          )}
        </div>

        {/* Track clips area */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-auto bg-[var(--bg-primary)]"
          onScroll={handleScroll}
        >
          {/* Time ruler */}
          <div className="sticky top-0 z-20">
            <TimeRuler
              zoom={zoom}
              scrollLeft={scrollLeft}
              width={timelineWidth}
              containerWidth={containerWidth}
              markers={timelineMarkers}
              onAddMarker={(time) => addTimelineMarker(time)}
              onRemoveMarker={removeTimelineMarker}
              onSelectMarker={setSelectedMarkerId}
              selectedMarkerId={selectedMarkerId}
            />
          </div>

          {/* Track lanes + Playhead */}
          <div
            ref={trackAreaRef}
            className="relative"
            style={{ minWidth: timelineWidth, minHeight: Math.max(totalTrackHeight, 80) }}
            onClick={handleTrackAreaClick}
          >
            {/* Playhead spanning all tracks */}
            <Playhead
              currentTime={currentTime}
              zoom={zoom}
              height={Math.max(totalTrackHeight, 80)}
            />

            {linkedRelationships.length > 0 && (
              <svg className="absolute left-0 top-0 z-[6] pointer-events-none overflow-visible" width={timelineWidth} height={Math.max(totalTrackHeight, 80)} aria-label="Linked clip relationships">
                {linkedRelationships.flatMap(([groupId, members]) => {
                  const ordered = [...members].sort((a, b) => a.trackIndex - b.trackIndex || a.clip.startTime - b.clip.startTime);
                  return ordered.slice(1).map((member, index) => {
                    const previous = ordered[index]!;
                    const x1 = previous.clip.startTime * zoom + Math.min(previous.clip.duration * zoom / 2, 18);
                    const x2 = member.clip.startTime * zoom + Math.min(member.clip.duration * zoom / 2, 18);
                    const y1 = previous.trackIndex * trackHeight + trackHeight / 2;
                    const y2 = member.trackIndex * trackHeight + trackHeight / 2;
                    return <path key={`${groupId}-${previous.clip.id}-${member.clip.id}`} d={`M ${x1} ${y1} C ${x1 + 12} ${y1}, ${x2 + 12} ${y2}, ${x2} ${y2}`} fill="none" stroke="rgba(52, 211, 153, 0.8)" strokeWidth="1.25" strokeDasharray="3 3" />;
                  });
                })}
              </svg>
            )}

            {tracks.length === 0 ? (
              <div
                className="flex items-center justify-center h-20 text-xs text-[var(--text-muted)]"
                style={{ minWidth: timelineWidth }}
              >
                Click + Video or + Audio to add tracks
              </div>
            ) : (
              tracks.map((track) => (
                <div
                  key={track.id}
                  data-lane="true"
                  className={`border-b border-[var(--border-default)] relative ${
                    track.visible ? "bg-zinc-950/40" : "bg-zinc-950/20 opacity-50"
                  } ${track.locked ? "pointer-events-none opacity-70" : ""}`}
                  style={{ height: trackHeight, minWidth: timelineWidth }}
                  onDragOver={handleTrackDragOver}
                  onDrop={(e) => handleTrackDrop(e, track.id)}
                >
                  {track.clips.map((clip) =>
                    isClipVisible(clip) ? (
                      <ClipBlock
                        key={clip.id}
                        clip={clip}
                        track={track}
                        zoom={zoom}
                        onContextMenu={handleContextMenu}
                        getSnapTargets={getSnapTargets}
                      />
                    ) : null
                  )}
                  {(track.type === "audio" || track.type === "video") && (
                    <TrackAutomationOverlay trackId={track.id} zoom={zoom} width={timelineWidth} />
                  )}
                  {transitions
                    .filter((tr) => tr.trackId === track.id)
                    .map((tr) => {
                      const a = track.clips.find((c) => c.id === tr.clipAId);
                      const b = track.clips.find((c) => c.id === tr.clipBId);
                      if (!a || !b) return null;
                      const [start, end] = getTransitionWindow(a, b, tr.duration);
                      return (
                        <div
                          key={tr.id}
                          title={`${tr.type} ${tr.duration}s`}
                          className="absolute top-0 bottom-0 z-[5] pointer-events-none border-x border-amber-400/70 bg-amber-500/20"
                          style={{
                            left: start * zoom,
                            width: Math.max(2, (end - start) * zoom),
                          }}
                        />
                      );
                    })}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          clipId={contextMenu.clipId}
          trackId={contextMenu.trackId}
          onClose={() => setContextMenu(null)}
          onSplit={handleSplit}
          onDelete={handleDelete}
          onRippleDelete={handleRippleDelete}
          onCloseGap={handleCloseGap}
          onDuplicate={handleDuplicate}
          onOpenSequence={handleOpenSequence}
          onCreateSequence={handleCreateSequence}
          canOpenSequence={contextClipIsNest && !isEditingSequence}
          canCreateSequence={!isEditingSequence}
          isLinked={Boolean(contextClip?.linkGroupId)}
          canLink={!contextClip?.linkGroupId && new Set([...selectedClipIds, contextMenu.clipId]).size >= 2}
          onLinkSelected={handleLinkSelected}
          onUnlinkGroup={handleUnlinkGroup}
          onRippleDeleteLinked={handleRippleDeleteLinked}
        />
      )}
    </div>
  );
}
