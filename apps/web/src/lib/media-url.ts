const BUILD_API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

function apiBaseUrl(): string {
  if (typeof window !== "undefined") {
    const runtime = (window as unknown as { __TEMPO_API_BASE?: string }).__TEMPO_API_BASE;
    if (runtime) return runtime.replace(/\/$/, "");
  }
  return BUILD_API_URL.replace(/\/$/, "");
}

/** Resolve a stored `/uploads/...` path (or absolute URL) against the API origin. */
export function resolveMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("blob:")) {
    return url;
  }
  const base = apiBaseUrl();
  return `${base}${url.startsWith("/") ? url : `/${url}`}`;
}

/** Best preview image for a media asset: thumbnail, else the file itself for images. */
export function getAssetPreviewUrl(asset: {
  type: string;
  url: string;
  thumbnailUrl?: string | null;
}): string | null {
  if (asset.thumbnailUrl) return resolveMediaUrl(asset.thumbnailUrl);
  if (asset.type === "image") return resolveMediaUrl(asset.url);
  return null;
}
