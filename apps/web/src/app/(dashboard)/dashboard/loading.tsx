export default function DashboardLoading() {
  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      {/* Header skeleton */}
      <header className="border-b border-[var(--border-default)] px-6 py-3 bg-[var(--bg-secondary)]">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded bg-zinc-800 animate-pulse" />
            <div className="w-14 h-3.5 rounded bg-zinc-800 animate-pulse" />
          </div>
          <div className="flex items-center gap-4">
            <div className="w-20 h-3 rounded bg-zinc-800 animate-pulse" />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="w-24 h-5 rounded bg-zinc-800 animate-pulse mb-1.5" />
            <div className="w-32 h-3 rounded bg-zinc-800/60 animate-pulse" />
          </div>
          <div className="w-28 h-8 rounded bg-zinc-800 animate-pulse" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="border border-[var(--border-default)] rounded-[var(--radius-md)] bg-[var(--bg-secondary)] overflow-hidden"
            >
              <div className="aspect-video bg-zinc-800/60 animate-pulse" />
              <div className="p-3 space-y-2">
                <div className="w-3/4 h-3 rounded bg-zinc-800 animate-pulse" />
                <div className="w-1/2 h-2.5 rounded bg-zinc-800/60 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
