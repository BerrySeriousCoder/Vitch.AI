"use client";

import { useEffect } from "react";
import { useAuthStore } from "@/stores/auth.store";

/** Restores user session on app mount by checking the stored token */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const checkAuth = useAuthStore((s) => s.checkAuth);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return <>{children}</>;
}
