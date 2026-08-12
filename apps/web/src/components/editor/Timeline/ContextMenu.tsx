"use client";

import { useEffect, useRef } from "react";

interface ContextMenuProps {
  x: number;
  y: number;
  clipId: string;
  trackId: string;
  onClose: () => void;
  onSplit: (clipId: string) => void;
  onDelete: (clipId: string) => void;
  onRippleDelete: (clipId: string) => void;
  onCloseGap: (trackId: string) => void;
  onDuplicate: (clipId: string) => void;
  onOpenSequence?: (clipId: string) => void;
  onCreateSequence?: () => void;
  canOpenSequence?: boolean;
  canCreateSequence?: boolean;
  isLinked?: boolean;
  canLink?: boolean;
  onLinkSelected?: () => void;
  onUnlinkGroup?: (clipId: string) => void;
  onRippleDeleteLinked?: (clipId: string) => void;
}

export function ContextMenu({
  x,
  y,
  clipId,
  trackId,
  onClose,
  onSplit,
  onDelete,
  onRippleDelete,
  onCloseGap,
  onDuplicate,
  onOpenSequence,
  onCreateSequence,
  canOpenSequence,
  canCreateSequence,
  isLinked,
  canLink,
  onLinkSelected,
  onUnlinkGroup,
  onRippleDeleteLinked,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const items: Array<{
    label: string;
    action: () => void;
    danger?: boolean;
    disabled?: boolean;
  }> = [
    { label: "Split at Playhead", action: () => onSplit(clipId) },
    { label: "Duplicate", action: () => onDuplicate(clipId) },
    { label: "Close gap on track", action: () => onCloseGap(trackId) },
  ];
  if (canOpenSequence && onOpenSequence) {
    items.push({ label: "Open sequence", action: () => onOpenSequence(clipId) });
  }
  if (canCreateSequence && onCreateSequence) {
    items.push({
      label: "Create sequence from selection",
      action: () => onCreateSequence(),
    });
  }
  if (isLinked && onUnlinkGroup && onRippleDeleteLinked) {
    items.push(
      { label: "Unlink A/V group", action: () => onUnlinkGroup(clipId) },
      { label: "Ripple delete linked A/V", action: () => onRippleDeleteLinked(clipId), danger: true }
    );
  } else if (canLink && onLinkSelected) {
    items.push({ label: "Link selected clips", action: onLinkSelected });
  }
  items.push(
    { label: "---", action: () => {} },
    { label: "Ripple delete", action: () => onRippleDelete(clipId), danger: true },
    { label: "Delete (leave gap)", action: () => onDelete(clipId), danger: true }
  );

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left: x, top: y }}
    >
      {items.map((item, i) =>
        item.label === "---" ? (
          <div key={i} className="h-px bg-[var(--border-default)] my-1" />
        ) : (
          <button
            key={i}
            disabled={item.disabled}
            onClick={() => {
              item.action();
              onClose();
            }}
            className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
              item.danger
                ? "text-red-400 hover:bg-red-950/30"
                : "text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            }`}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  );
}
