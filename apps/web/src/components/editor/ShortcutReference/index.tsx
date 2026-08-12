"use client";

import { useUIStore } from "@/stores/ui.store";

const SHORTCUT_GROUPS = [
  {
    label: "Playback",
    shortcuts: [
      { keys: ["Space"], description: "Play / Pause" },
      { keys: ["←"], description: "Previous frame" },
      { keys: ["→"], description: "Next frame" },
      { keys: ["Home"], description: "Go to start" },
      { keys: ["End"], description: "Go to end" },
    ],
  },
  {
    label: "Editing",
    shortcuts: [
      { keys: ["Delete", "Backspace"], description: "Delete selected clips" },
      { keys: ["Ctrl", "A"], description: "Select all clips" },
      { keys: ["Ctrl", "Z"], description: "Undo" },
      { keys: ["Ctrl", "Shift", "Z"], description: "Redo" },
      { keys: ["Ctrl", "Y"], description: "Redo (alt)" },
    ],
  },
  {
    label: "Project",
    shortcuts: [
      { keys: ["Ctrl", "S"], description: "Save project" },
      { keys: ["?"], description: "Toggle shortcut reference" },
    ],
  },
  {
    label: "Timeline",
    shortcuts: [
      { keys: ["Ctrl", "Scroll"], description: "Zoom in/out" },
    ],
  },
];

export function ShortcutReference() {
  const isOpen = useUIStore((s) => s.panels.shortcutReference);
  const togglePanel = useUIStore((s) => s.togglePanel);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[480px] max-h-[80vh] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-default)] flex-shrink-0">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Keyboard Shortcuts</h2>
          <button
            onClick={() => togglePanel("shortcutReference")}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.label}>
              <h3 className="text-[10px] font-mono font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                {group.label}
              </h3>
              <div className="space-y-1.5">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.description} className="flex items-center justify-between py-1">
                    <span className="text-xs text-[var(--text-secondary)]">{shortcut.description}</span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, i) => (
                        <span key={i}>
                          {i > 0 && <span className="text-[10px] text-zinc-600 mx-0.5">+</span>}
                          <kbd className="inline-block min-w-[24px] px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-800 text-[11px] text-zinc-300 font-mono text-center">
                            {key}
                          </kbd>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-2.5 border-t border-[var(--border-default)] text-center">
          <span className="text-[10px] text-[var(--text-muted)]">
            Press <kbd className="px-1 py-0.5 rounded border border-zinc-700 bg-zinc-800 text-[10px] text-zinc-400 font-mono">?</kbd> to toggle this panel
          </span>
        </div>
      </div>
    </div>
  );
}
