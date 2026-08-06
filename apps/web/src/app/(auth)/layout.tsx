import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex bg-[var(--bg-primary)]">
      {/* Left panel */}
      <div className="hidden lg:flex lg:w-1/2 bg-[var(--bg-secondary)] flex-col justify-between p-10 border-r border-[var(--border-default)]">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded bg-zinc-100 text-zinc-950 flex items-center justify-center font-bold text-xs">
            T
          </div>
          <span className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">Tempo</span>
        </Link>
        <div className="max-w-sm">
          <blockquote className="text-sm text-[var(--text-secondary)] leading-relaxed mb-4">
            &ldquo;A clean, precise video editor designed for high-performance timeline creation and automation.&rdquo;
          </blockquote>
          <span className="text-xs text-[var(--text-muted)] font-mono">Tempo Architecture v1.0</span>
        </div>
        <div className="text-xs text-[var(--text-muted)]">
          © 2026 Tempo Studio
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
