export default function EditorLoading() {
  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--bg-primary)]">
      {/* Top toolbar skeleton */}
      <div className="h-10 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] flex items-center px-4 gap-3 flex-shrink-0">
        <div className="w-6 h-6 rounded bg-zinc-800 animate-pulse" />
        <div className="w-32 h-3 rounded bg-zinc-800 animate-pulse" />
        <div className="flex-1" />
        <div className="w-20 h-6 rounded bg-zinc-800 animate-pulse" />
      </div>

      {/* Main area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel skeleton */}
        <div className="w-60 border-r border-[var(--border-default)] bg-[var(--bg-secondary)] flex flex-col">
          <div className="h-9 border-b border-[var(--border-default)] flex items-center px-3">
            <div className="w-16 h-2.5 rounded bg-zinc-800 animate-pulse" />
          </div>
          <div className="flex-1 p-3 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="aspect-video rounded bg-zinc-800/50 animate-pulse" />
            ))}
          </div>
        </div>

        {/* Preview skeleton */}
        <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary)]">
          <div className="w-[640px] max-w-full aspect-video rounded bg-zinc-900 border border-[var(--border-default)] flex items-center justify-center">
            <div className="w-10 h-10 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
          </div>
        </div>

        {/* Right panel skeleton */}
        <div className="w-72 border-l border-[var(--border-default)] bg-[var(--bg-secondary)]">
          <div className="h-9 border-b border-[var(--border-default)] flex items-center px-3">
            <div className="w-20 h-2.5 rounded bg-zinc-800 animate-pulse" />
          </div>
          <div className="p-3 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="w-16 h-2 rounded bg-zinc-800/60 animate-pulse" />
                <div className="w-full h-7 rounded bg-zinc-800/40 animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Timeline skeleton */}
      <div className="h-48 border-t border-[var(--border-default)] bg-[var(--bg-secondary)]">
        <div className="h-6 border-b border-[var(--border-default)] bg-zinc-900/50" />
        <div className="p-2 space-y-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="w-24 h-8 rounded bg-zinc-800/40 animate-pulse flex-shrink-0" />
              <div className="flex-1 h-8 rounded bg-zinc-800/30 animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
