import { env } from "../config/env.js";

/**
 * Origin used by server-owned headless browsers to read local media.
 * API_PUBLIC_URL is intentionally excluded: that origin exists for external
 * services and may be a tunnel, placeholder, or unavailable from this host.
 */
export function internalApiBaseUrl(): string {
  return (env.API_INTERNAL_URL || `http://127.0.0.1:${env.API_PORT}`).replace(/\/$/, "");
}
