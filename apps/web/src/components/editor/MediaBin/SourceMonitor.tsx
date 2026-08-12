"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { MediaAsset, TrackType } from "@tempo/types";
import { usePlaybackStore } from "@/stores/playback.store";
import { useSelectionStore } from "@/stores/selection.store";
import { useTimelineStore } from "@/stores/timeline.store";
import { resolveMediaUrl } from "@/lib/media-url";
import { toast } from "sonner";

const TRANSFORM = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0 };

function timeLabel(seconds: number) {
  const value = Math.max(0, seconds);
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}.${String(Math.floor((value % 1) * 10))}`;
}

/** A source-side media monitor with marks and insert editing into the active timeline. */
export function SourceMonitor({ asset }: { asset: MediaAsset }) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const tracks = useTimelineStore((state) => state.tracks);
  const addTrack = useTimelineStore((state) => state.addTrack);
  const sourceEdit = useTimelineStore((state) => state.sourceEdit);
  const selectedTrackId = useSelectionStore((state) => state.selectedTrackId);
  const selectClip = useSelectionStore((state) => state.selectClip);
  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(Math.max(0.1, asset.duration || asset.metadata?.duration || 0.1));
  const [editMode, setEditMode] = useState<"insert" | "overwrite">("insert");
  const [gangProgram, setGangProgram] = useState(false);
  const gangAnchorRef = useRef(0);
  const sourceUrl = resolveMediaUrl(asset.url);
  const kind: TrackType = asset.type === "audio" ? "audio" : "video";

  const mark = (which: "in" | "out") => {
    const at = Math.max(0, mediaRef.current?.currentTime || 0);
    if (which === "in") setInPoint(Math.min(at, outPoint - 0.05));
    else setOutPoint(Math.max(at, inPoint + 0.05));
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || target?.isContentEditable) return;
      const media = mediaRef.current;
      if (!media) return;
      if (event.key.toLowerCase() === "j") { media.pause(); media.currentTime = Math.max(0, media.currentTime - 1); event.preventDefault(); }
      if (event.key.toLowerCase() === "k") { media.pause(); event.preventDefault(); }
      if (event.key.toLowerCase() === "l") { void media.play().catch(() => undefined); event.preventDefault(); }
      if (event.key.toLowerCase() === "i") { mark("in"); event.preventDefault(); }
      if (event.key.toLowerCase() === "o") { mark("out"); event.preventDefault(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inPoint, outPoint]);

  const editIntoTimeline = () => {
    let target = tracks.find((track) => track.id === selectedTrackId && track.type === kind && !track.locked)
      || tracks.find((track) => track.type === kind && !track.locked);
    if (!target) {
      const id = addTrack(kind === "audio" ? "Audio" : "Video", kind);
      target = useTimelineStore.getState().tracks.find((track) => track.id === id);
    }
    if (!target) return toast.error("No unlocked track is available for this source");
    const result = sourceEdit(target.id, {
      sourceMediaId: asset.id,
      startTime: currentTime,
      duration: Math.max(0.05, outPoint - inPoint),
      sourceOffset: inPoint,
      speed: 1,
      mediaLayout: kind === "video" ? { schemaVersion: 1, fit: "cover", focalPoint: { x: 0.5, y: 0.5 } } : undefined,
      transform: { ...TRANSFORM },
      opacity: 1,
      blendMode: "normal",
      effects: [],
      keyframes: [],
      mask: null,
      muted: false,
      volume: 1,
    }, editMode);
    if (result.ok) {
      selectClip(result.clipId);
      toast.success(`${editMode === "insert" ? "Inserted" : "Overwrote with"} ${asset.name} at ${timeLabel(currentTime)}`);
    } else {
      toast.error(result.message);
    }
  };

  const toggleGang = () => {
    const next = !gangProgram;
    gangAnchorRef.current = currentTime - (mediaRef.current?.currentTime || 0);
    setGangProgram(next);
  };
  const gangTimeUpdate = () => {
    if (gangProgram && mediaRef.current) usePlaybackStore.getState().seek(Math.max(0, gangAnchorRef.current + mediaRef.current.currentTime));
  };

  if (!sourceUrl) return null;
  return (
    <section className="border-b border-zinc-800 bg-zinc-950">
      <div className="px-3 pt-2 text-[9px] font-mono uppercase tracking-wider text-zinc-400">Source monitor</div>
      {asset.type === "audio" ? (
        <audio ref={mediaRef as RefObject<HTMLAudioElement>} onTimeUpdate={gangTimeUpdate} src={sourceUrl} controls className="mx-3 mt-2 w-[calc(100%-1.5rem)]" />
      ) : (
        <video ref={mediaRef as RefObject<HTMLVideoElement>} onTimeUpdate={gangTimeUpdate} src={sourceUrl} controls preload="metadata" className="mt-2 aspect-video w-full bg-black object-contain" />
      )}
      <div className="flex items-center gap-1 px-3 py-2">
        <button type="button" onClick={() => mark("in")} className="rounded bg-zinc-800 px-1.5 py-1 text-[10px] text-zinc-200 hover:bg-zinc-700">Mark In</button>
        <span className="font-mono text-[10px] text-emerald-300">{timeLabel(inPoint)}</span>
        <button type="button" onClick={() => mark("out")} className="rounded bg-zinc-800 px-1.5 py-1 text-[10px] text-zinc-200 hover:bg-zinc-700">Mark Out</button>
        <span className="font-mono text-[10px] text-amber-300">{timeLabel(outPoint)}</span>
        <button type="button" onClick={toggleGang} className={`rounded px-1.5 py-1 text-[10px] ${gangProgram ? "bg-violet-700 text-white" : "bg-zinc-800 text-zinc-300"}`}>Gang</button>
        <select value={editMode} onChange={(event) => setEditMode(event.target.value as "insert" | "overwrite")} className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-[10px] text-zinc-200"><option value="insert">Insert</option><option value="overwrite">Overwrite</option></select>
        <button type="button" onClick={editIntoTimeline} className="rounded bg-cyan-700 px-2 py-1 text-[10px] font-medium text-white hover:bg-cyan-600">{editMode === "insert" ? "Insert" : "Overwrite"}</button>
      </div>
    </section>
  );
}
