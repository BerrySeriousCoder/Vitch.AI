import { create } from "zustand";
import { apiFetch, setTokens, clearTokens } from "@/lib/api-client";

interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  /** Login with email/password */
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;

  /** Register a new account */
  register: (
    email: string,
    password: string,
    name: string
  ) => Promise<{ success: boolean; error?: string }>;

  /** Logout and clear tokens */
  logout: () => Promise<void>;

  /** Check if user is authenticated (on app load) */
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,

  login: async (email, password) => {
    const res = await apiFetch<{
      user: User;
      accessToken: string;
      refreshToken: string;
    }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
      skipAuth: true,
    });

    if (res.success && res.data) {
      setTokens(res.data.accessToken, res.data.refreshToken);
      set({ user: res.data.user, isAuthenticated: true });
      return { success: true };
    }

    return { success: false, error: res.error || "Login failed" };
  },

  register: async (email, password, name) => {
    const res = await apiFetch<{
      user: User;
      accessToken: string;
      refreshToken: string;
    }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
      skipAuth: true,
    });

    if (res.success && res.data) {
      setTokens(res.data.accessToken, res.data.refreshToken);
      set({ user: res.data.user, isAuthenticated: true });
      return { success: true };
    }

    return { success: false, error: res.error || "Registration failed" };
  },

  logout: async () => {
    await apiFetch("/api/auth/logout", { method: "POST" });
    clearTokens();
    set({ user: null, isAuthenticated: false });
  },

  checkAuth: async () => {
    set({ isLoading: true });

    const token =
      typeof window !== "undefined"
        ? localStorage.getItem("tempo_access_token")
        : null;

    if (!token) {
      set({ isLoading: false, isAuthenticated: false, user: null });
      return;
    }

    const res = await apiFetch<User>("/api/auth/me");

    if (res.success && res.data) {
      set({ user: res.data, isAuthenticated: true, isLoading: false });
    } else {
      clearTokens();
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },
}));
