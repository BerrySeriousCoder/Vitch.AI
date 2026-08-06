"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth.store";

export default function RegisterPage() {
  const router = useRouter();
  const register = useAuthStore((s) => s.register);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const result = await register(email, password, name);

    if (result.success) {
      toast.success("Account created!");
      router.push("/dashboard");
    } else {
      toast.error(result.error || "Registration failed");
      setLoading(false);
    }
  }

  return (
    <div className="animate-fade-in">
      <div className="lg:hidden flex items-center gap-2 mb-8">
        <div className="w-7 h-7 rounded bg-zinc-100 text-zinc-950 flex items-center justify-center font-bold text-xs">
          T
        </div>
        <span className="text-sm font-semibold tracking-tight">Tempo</span>
      </div>

      <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)] mb-1">Create account</h1>
      <p className="text-xs text-[var(--text-muted)] mb-6">
        Enter your details to create a new workspace.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="name" className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">
            Full Name
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            placeholder="John Doe"
            className="w-full px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--bg-secondary)] border border-[var(--border-default)] text-[var(--text-primary)] text-xs placeholder:text-[var(--text-muted)] focus:border-zinc-400 focus:outline-none transition-colors"
          />
        </div>

        <div>
          <label htmlFor="email" className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="name@example.com"
            className="w-full px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--bg-secondary)] border border-[var(--border-default)] text-[var(--text-primary)] text-xs placeholder:text-[var(--text-muted)] focus:border-zinc-400 focus:outline-none transition-colors"
          />
        </div>

        <div>
          <label htmlFor="password" className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            placeholder="Min. 8 characters"
            className="w-full px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--bg-secondary)] border border-[var(--border-default)] text-[var(--text-primary)] text-xs placeholder:text-[var(--text-muted)] focus:border-zinc-400 focus:outline-none transition-colors"
          />
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            Must contain uppercase, lowercase, and a number.
          </p>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2 bg-[var(--tempo-primary)] hover:bg-[var(--tempo-primary-hover)] text-[var(--tempo-primary-text)] disabled:opacity-50 disabled:cursor-not-allowed rounded-[var(--radius-sm)] font-medium text-xs transition-colors mt-2"
        >
          {loading ? "Creating account..." : "Create account"}
        </button>
      </form>

      <p className="mt-6 text-center text-xs text-[var(--text-muted)]">
        Already have an account?{" "}
        <Link href="/login" className="text-[var(--text-primary)] hover:underline font-medium">
          Sign in
        </Link>
      </p>
    </div>
  );
}
