import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Tempo — AI Video Editor",
  description:
    "Professional AI video editing platform. Beat-synced cuts, motion design, and intelligent timeline automation.",
};

export default function LandingPage() {
  return (
    <div className="flex flex-col min-h-screen bg-[var(--bg-primary)]">
      {/* Navigation */}
      <nav className="flex items-center justify-between px-6 py-3.5 border-b border-[var(--border-default)]">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded bg-zinc-100 text-zinc-950 flex items-center justify-center font-bold text-xs tracking-tight">
            T
          </div>
          <span className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">Tempo</span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors font-medium"
          >
            Sign in
          </Link>
          <Link
            href="/register"
            className="px-3.5 py-1.5 text-xs bg-[var(--tempo-primary)] hover:bg-[var(--tempo-primary-hover)] text-[var(--tempo-primary-text)] rounded-[var(--radius-sm)] transition-colors font-medium"
          >
            Get Started
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-20">
        <div className="max-w-3xl mx-auto text-center animate-fade-in">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs font-medium mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-400" />
            AI Video Editor
          </div>

          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-[var(--text-primary)] mb-5 leading-[1.15]">
            Professional video editing, <br />
            <span className="text-zinc-400">powered by intelligence.</span>
          </h1>

          <p className="text-base text-[var(--text-secondary)] max-w-xl mx-auto mb-8 leading-relaxed">
            Recreate reference edits, sync cuts to audio beats, and automate timelines with natural language prompts. Fast, local, and precise.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-16">
            <Link
              href="/register"
              className="w-full sm:w-auto px-6 py-2.5 bg-[var(--tempo-primary)] hover:bg-[var(--tempo-primary-hover)] text-[var(--tempo-primary-text)] rounded-[var(--radius-sm)] font-medium text-xs transition-colors"
            >
              Start Editing
            </Link>
            <Link
              href="#features"
              className="w-full sm:w-auto px-6 py-2.5 border border-[var(--border-default)] hover:border-[var(--border-hover)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-[var(--radius-sm)] font-medium text-xs transition-colors"
            >
              Explore Features
            </Link>
          </div>

          {/* Minimal App Mockup Preview */}
          <div className="relative mx-auto max-w-2xl">
            <div className="aspect-video rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-hidden">
              <div className="h-full flex flex-col">
                {/* Window header */}
                <div className="h-9 border-b border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-zinc-800" />
                    <div className="w-2.5 h-2.5 rounded-full bg-zinc-800" />
                    <div className="w-2.5 h-2.5 rounded-full bg-zinc-800" />
                  </div>
                  <span className="text-[11px] font-mono text-[var(--text-muted)]">project_timeline_01.tempo</span>
                  <div className="w-10" />
                </div>
                {/* Workspace preview body */}
                <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary)]">
                  <div className="text-center p-6">
                    <div className="w-12 h-12 rounded-[var(--radius-md)] border border-zinc-800 bg-zinc-900 flex items-center justify-center mx-auto mb-3">
                      <svg className="w-5 h-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
                      </svg>
                    </div>
                    <span className="text-xs font-mono text-[var(--text-muted)]">Interactive Timeline & Canvas</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Feature Grid */}
        <section id="features" className="max-w-4xl mx-auto mt-24 w-full">
          <div className="border-t border-[var(--border-default)] pt-16">
            <h2 className="text-xl font-bold text-center mb-10 text-[var(--text-primary)] tracking-tight">
              Designed for speed and control
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                {
                  title: "Style Transfer",
                  desc: "Analyze pacing, transitions, and cuts from reference videos and apply them to your media.",
                },
                {
                  title: "Beat Detection",
                  desc: "Automatic transient detection and BPM matching for audio-driven video cuts.",
                },
                {
                  title: "Kinetic Typography",
                  desc: "Generate accurate, styled text overlays and captions synced perfectly with voice tracks.",
                },
                {
                  title: "Color Matching",
                  desc: "Match color profiles and LUT curves across distinct clips seamlessly.",
                },
                {
                  title: "Smart Transitions",
                  desc: "Context-aware transitions based on scene dynamics and motion vectors.",
                },
                {
                  title: "High Performance",
                  desc: "Hardware-accelerated preview rendering with background job queue export.",
                },
              ].map((item) => (
                <div
                  key={item.title}
                  className="p-5 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-secondary)] hover:border-[var(--border-hover)] transition-colors"
                >
                  <h3 className="text-xs font-semibold text-[var(--text-primary)] mb-1.5 tracking-tight">
                    {item.title}
                  </h3>
                  <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                    {item.desc}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-[var(--border-default)] py-6 px-6 bg-[var(--bg-primary)]">
        <div className="max-w-4xl mx-auto flex items-center justify-between text-xs text-[var(--text-muted)]">
          <span>Tempo Studio</span>
          <span>Shadcn Clean Design</span>
        </div>
      </footer>
    </div>
  );
}
