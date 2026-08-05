const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

interface FetchOptions extends RequestInit {
  skipAuth?: boolean;
}

/** Get stored access token */
export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("tempo_access_token");
}

/** Get stored refresh token */
function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("tempo_refresh_token");
}

/** Store tokens */
export function setTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem("tempo_access_token", accessToken);
  localStorage.setItem("tempo_refresh_token", refreshToken);
}

/** Clear tokens */
export function clearTokens() {
  localStorage.removeItem("tempo_access_token");
  localStorage.removeItem("tempo_refresh_token");
}

/** Try to refresh the access token using the refresh token */
async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;

  try {
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      clearTokens();
      return null;
    }

    const data = await res.json();
    const newAccessToken = data.data.accessToken as string;
    localStorage.setItem("tempo_access_token", newAccessToken);
    return newAccessToken;
  } catch {
    clearTokens();
    return null;
  }
}

/**
 * Authenticated fetch wrapper.
 * - Injects Authorization header automatically
 * - Retries once with refreshed token on 401
 * - Redirects to /login on final auth failure
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: FetchOptions = {}
): Promise<{ success: boolean; data?: T; error?: string }> {
  const { skipAuth = false, headers: customHeaders, ...rest } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(customHeaders as Record<string, string>),
  };

  if (!skipAuth) {
    const token = getAccessToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  let res = await fetch(`${API_URL}${path}`, { ...rest, headers });

  // Retry on 401 with refreshed token
  if (res.status === 401 && !skipAuth) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers["Authorization"] = `Bearer ${newToken}`;
      res = await fetch(`${API_URL}${path}`, { ...rest, headers });
    } else {
      // Redirect to login
      if (typeof window !== "undefined") {
        window.location.href = "/login";
      }
      return { success: false, error: "Session expired" };
    }
  }

  const json = await res.json();
  return json;
}

const API_BASE = API_URL;

/**
 * Upload a file via FormData (no Content-Type header -- browser sets multipart boundary).
 */
export async function apiUpload<T = unknown>(
  path: string,
  formData: FormData
): Promise<{ success: boolean; data?: T; error?: string }> {
  const token = getAccessToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: formData,
  });

  if (res.status === 401) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers["Authorization"] = `Bearer ${newToken}`;
      res = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers,
        body: formData,
      });
    } else {
      return { success: false, error: "Session expired" };
    }
  }

  const json = await res.json();
  return json;
}
