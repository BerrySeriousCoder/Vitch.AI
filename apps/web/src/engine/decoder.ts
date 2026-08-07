import { FrameCache } from "./frame-cache";

/**
 * Video decoder using HTMLVideoElement.
 * - Scrub/pause: seek to exact source time, then draw
 * - Playback: keep the element playing and draw live frames (no per-tick seek)
 */
export class VideoDecoder {
  private videos = new Map<string, HTMLVideoElement>();
  private images = new Map<string, HTMLImageElement>();
  private seekPromises = new Map<
    string,
    { resolve: () => void; reject: (e: Error) => void; gen: number }
  >();
  private seekGen = new Map<string, number>();
  private ready = new Map<string, Promise<void>>();
  private seekingLive = new Set<string>();
  private cache: FrameCache;
  private playingIds = new Set<string>();
  private failedVideos = new Map<string, { url: string; retryAfter: number; message: string }>();

  constructor(cache: FrameCache) {
    this.cache = cache;
  }

  private failureCoolingDown(mediaId: string, url: string): boolean {
    const failure = this.failedVideos.get(mediaId);
    if (!failure) return false;
    if (failure.url !== url || Date.now() >= failure.retryAfter) {
      this.failedVideos.delete(mediaId);
      return false;
    }
    return true;
  }

  /** Returns true only for the first report in a cooldown window. */
  private markVideoFailed(mediaId: string, url: string, message: string): boolean {
    if (this.failureCoolingDown(mediaId, url)) return false;
    this.failedVideos.set(mediaId, {
      url,
      retryAfter: Date.now() + 30_000,
      message,
    });
    return true;
  }

  /** Drop a broken element so the next access recreates it. */
  private destroyVideo(mediaId: string): void {
    const video = this.videos.get(mediaId);
    this.videos.delete(mediaId);
    this.ready.delete(mediaId);
    this.playingIds.delete(mediaId);
    this.seekingLive.delete(mediaId);

    const pending = this.seekPromises.get(mediaId);
    if (pending) {
      pending.resolve();
      this.seekPromises.delete(mediaId);
    }

    if (!video) return;
    try {
      video.pause();
      // Clear source without load() — load() can re-fire error and recurse
      video.removeAttribute("src");
      video.srcObject = null;
    } catch {
      // ignore teardown errors
    }
  }

  private getVideoElement(mediaId: string, url: string): HTMLVideoElement {
    const priorFailure = this.failedVideos.get(mediaId);
    if (priorFailure && priorFailure.url !== url) this.failedVideos.delete(mediaId);
    let video = this.videos.get(mediaId);

    // Recreate if the element is in an error state (common after failed seeks)
    if (video && video.error) {
      this.destroyVideo(mediaId);
      video = undefined;
    }

    if (!video) {
      video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      video.src = url;

      const el = video;
      el.addEventListener("seeked", () => {
        if (this.videos.get(mediaId) !== el) return;
        this.seekingLive.delete(mediaId);
        const pending = this.seekPromises.get(mediaId);
        if (!pending) return;
        if (pending.gen !== this.seekGen.get(mediaId)) return;
        pending.resolve();
        this.seekPromises.delete(mediaId);
      });

      el.addEventListener("error", () => {
        if (this.videos.get(mediaId) !== el) return;
        const message = el.error?.message || `Video resource failed to load: ${url}`;
        if (this.markVideoFailed(mediaId, url, message)) {
          console.warn("[VideoDecoder] media unavailable; pausing retries for 30s", mediaId, url, message);
        }
        this.seekingLive.delete(mediaId);
        const pending = this.seekPromises.get(mediaId);
        if (pending && pending.gen === this.seekGen.get(mediaId)) {
          pending.reject(new Error(`Video load/seek failed: ${url}`));
          this.seekPromises.delete(mediaId);
        }
        this.destroyVideo(mediaId);
      });

      this.videos.set(mediaId, video);
      this.ready.set(mediaId, this.makeReadyPromise(video));
    } else if (this.needsSrcUpdate(video, url)) {
      video.src = url;
      this.ready.set(mediaId, this.makeReadyPromise(video));
    }
    return video;
  }

  private needsSrcUpdate(video: HTMLVideoElement, url: string): boolean {
    try {
      const absolute = new URL(url, window.location.href).href;
      // Prefer currentSrc once loaded; fall back to src
      const current = video.currentSrc || video.src;
      return current !== absolute;
    } catch {
      return !video.src.includes(url) && video.getAttribute("src") !== url;
    }
  }

  private makeReadyPromise(video: HTMLVideoElement): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        resolve();
        return;
      }
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("Video ready timeout"));
      }, 10000);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(video.error?.message || "Video error"));
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("canplay", onReady);
        video.removeEventListener("error", onError);
      };
      video.addEventListener("loadeddata", onReady);
      video.addEventListener("canplay", onReady);
      video.addEventListener("error", onError);
    });
  }

  private async ensureReady(mediaId: string, video: HTMLVideoElement): Promise<void> {
    if (video.error) {
      throw new Error("Video element in error state");
    }
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const p = this.ready.get(mediaId);
    if (p) await p;
    if (video.error) {
      throw new Error("Video failed to load");
    }
    this.failedVideos.delete(mediaId);
  }

  private waitForDecodedFrame(video: HTMLVideoElement, timeoutMs = 500): Promise<void> {
    if (!("requestVideoFrameCallback" in video)) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve();
      };
      const timeout = window.setTimeout(finish, timeoutMs);
      video.requestVideoFrameCallback(() => finish());
    });
  }

  private seekTo(mediaId: string, video: HTMLVideoElement, time: number): Promise<void> {
    if (video.error) {
      return Promise.reject(new Error("Cannot seek: video in error state"));
    }

    const max = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.001) : time;
    const clamped = Math.max(0, Math.min(time, max));

    if (
      Math.abs(video.currentTime - clamped) < 0.04 &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return Promise.resolve();
    }

    const gen = (this.seekGen.get(mediaId) ?? 0) + 1;
    this.seekGen.set(mediaId, gen);

    const prev = this.seekPromises.get(mediaId);
    if (prev) {
      prev.resolve();
      this.seekPromises.delete(mediaId);
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        const pending = this.seekPromises.get(mediaId);
        if (pending?.gen !== gen) return;
        this.seekPromises.delete(mediaId);
        // Don't reject on timeout — draw whatever frame we have
        resolve();
      }, 1500);

      this.seekPromises.set(mediaId, {
        gen,
        resolve: () => {
          window.clearTimeout(timeout);
          resolve();
        },
        reject: (err) => {
          window.clearTimeout(timeout);
          reject(err);
        },
      });

      try {
        video.currentTime = clamped;
      } catch (err) {
        window.clearTimeout(timeout);
        this.seekPromises.delete(mediaId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Live playback path: keep the <video> playing near sourceTime and return it
   * for immediate drawImage — no await/seek every animation frame.
   */
  getLiveVideo(
    mediaId: string,
    url: string,
    sourceTime: number,
    speed = 1
  ): HTMLVideoElement | null {
    if (this.failureCoolingDown(mediaId, url)) return null;
    try {
      const video = this.getVideoElement(mediaId, url);
      if (video.error) {
        this.destroyVideo(mediaId);
        return null;
      }

      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        void this.ensureReady(mediaId, video).catch(() => undefined);
        return video.videoWidth > 0 ? video : null;
      }

      this.failedVideos.delete(mediaId);

      // Hold/freeze: pin frame. Speeds below 0.1 are treated as freeze (HTML min is often 0.1).
      const freeze = !(speed > 0.05);
      if (freeze) {
        try {
          if (!video.paused) video.pause();
        } catch {
          /* ignore */
        }
        const drift = Math.abs(video.currentTime - sourceTime);
        if (drift > 0.02 && !this.seekingLive.has(mediaId)) {
          this.seekingLive.add(mediaId);
          try {
            video.currentTime = Math.max(0, sourceTime);
          } catch {
            this.seekingLive.delete(mediaId);
          }
        }
        this.playingIds.add(mediaId);
        return video.videoWidth > 0 ? video : null;
      }

      video.playbackRate = Math.max(0.1, speed || 1);

      // Only resync on large drift, and never stack seeks (seeking freezes frames)
      const drift = Math.abs(video.currentTime - sourceTime);
      if (drift > 0.5 && !this.seekingLive.has(mediaId)) {
        this.seekingLive.add(mediaId);
        try {
          video.currentTime = Math.max(0, sourceTime);
        } catch {
          this.seekingLive.delete(mediaId);
        }
      }

      if (video.paused && !this.seekingLive.has(mediaId)) {
        void video.play().catch(() => {
          // Autoplay / transient failures — retry next frame
        });
      }

      this.playingIds.add(mediaId);
      return video.videoWidth > 0 ? video : null;
    } catch (err) {
      console.warn("[VideoDecoder] getLiveVideo failed", mediaId, err);
      return null;
    }
  }

  /** Pause live videos that were not used in the current frame. */
  releaseInactive(activeIds: Set<string>): void {
    for (const id of [...this.playingIds]) {
      if (activeIds.has(id)) continue;
      const video = this.videos.get(id);
      if (video && !video.paused) video.pause();
      this.playingIds.delete(id);
      this.seekingLive.delete(id);
    }
  }

  /** Pause all live-playing elements (call when transport pauses). */
  pauseAll(): void {
    for (const id of this.playingIds) {
      const video = this.videos.get(id);
      if (video && !video.paused) video.pause();
    }
    this.playingIds.clear();
    this.seekingLive.clear();
  }

  /**
   * Scrub / paused frame: seek then return drawable source.
   */
  async getFrame(
    mediaId: string,
    url: string,
    sourceTime: number,
    _width: number,
    _height: number,
    options: { preferVideoElement?: boolean } = {}
  ): Promise<ImageBitmap | HTMLVideoElement | null> {
    if (this.failureCoolingDown(mediaId, url)) return null;
    try {
      const cacheKey = FrameCache.makeKey(`${mediaId}:${url}`, sourceTime);
      // Chromium's GPU-backed createImageBitmap(video) path can expose the
      // encoded 1024x576 raster for a rotation-tagged 576x1024 source. Keep
      // the HTMLVideoElement so the compositor can bake the display rotation
      // through Canvas2D before handing pixels to WebGPU.
      if (!options.preferVideoElement) {
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;
      }
      let video = this.getVideoElement(mediaId, url);
      try {
        await this.ensureReady(mediaId, video);
      } catch {
        // Recreate once and retry
        this.destroyVideo(mediaId);
        video = this.getVideoElement(mediaId, url);
        await this.ensureReady(mediaId, video);
      }

      if (!video.paused) video.pause();
      this.playingIds.delete(mediaId);
      this.seekingLive.delete(mediaId);

      try {
        await this.seekTo(mediaId, video, sourceTime);
      } catch {
        // Element may have been destroyed on error — recreate and try once
        this.destroyVideo(mediaId);
        video = this.getVideoElement(mediaId, url);
        await this.ensureReady(mediaId, video);
        video.pause();
        await this.seekTo(mediaId, video, sourceTime);
      }

      // Re-fetch in case error handler destroyed the map entry mid-seek
      video = this.videos.get(mediaId) ?? video;
      if (video.error || video.videoWidth === 0 || video.videoHeight === 0) {
        return null;
      }

      if (options.preferVideoElement) {
        // `seeked` can fire before ANGLE has a drawable decoded surface. A
        // video-frame callback prevents the first requested export frame from
        // becoming a false black frame at a cut boundary.
        await this.waitForDecodedFrame(video);
        return video;
      }

      try {
        const bitmap = await createImageBitmap(video);
        this.cache.set(cacheKey, bitmap);
        return bitmap;
      } catch {
        return video;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.markVideoFailed(mediaId, url, message)) {
        console.warn("[VideoDecoder] getFrame failed; pausing retries for 30s", mediaId, url, err);
      }
      this.destroyVideo(mediaId);
      return null;
    }
  }

  /** Decode a short paused-playhead look-ahead window into the bounded LRU cache. */
  async prewarmVideoFrames(mediaId: string, url: string, sourceTimes: readonly number[]): Promise<number> {
    let warmed = 0;
    for (const sourceTime of sourceTimes) {
      const key = FrameCache.makeKey(`${mediaId}:${url}`, sourceTime);
      if (this.cache.get(key)) continue;
      const frame = await this.getFrame(mediaId, url, sourceTime, 0, 0);
      if (frame) warmed += 1;
    }
    return warmed;
  }

  clearFrameCache(): void {
    this.cache.clear();
  }

  async getImage(
    mediaId: string,
    url: string
  ): Promise<ImageBitmap | HTMLImageElement | null> {
    const cacheKey = FrameCache.makeKey(`${mediaId}:${url}`, 0);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      let img = this.images.get(mediaId);
      if (!img || this.imageNeedsReload(img, url)) {
        img = new Image();
        img.crossOrigin = "anonymous";
        const loadPromise = new Promise<void>((resolve, reject) => {
          img!.onload = () => resolve();
          img!.onerror = () => reject(new Error(`Image failed to load: ${url}`));
        });
        img.src = url;
        this.images.set(mediaId, img);
        await loadPromise;
      } else if (!img.complete) {
        await new Promise<void>((resolve, reject) => {
          img!.onload = () => resolve();
          img!.onerror = () => reject(new Error(`Image failed to load: ${url}`));
        });
      }

      try {
        const bitmap = await createImageBitmap(img);
        this.cache.set(cacheKey, bitmap);
        return bitmap;
      } catch {
        return img;
      }
    } catch (err) {
      console.warn("[VideoDecoder] getImage failed", mediaId, url, err);
      return null;
    }
  }

  private imageNeedsReload(img: HTMLImageElement, url: string): boolean {
    try {
      return img.src !== new URL(url, window.location.href).href;
    } catch {
      return img.getAttribute("src") !== url;
    }
  }

  dispose(): void {
    this.pauseAll();
    for (const id of [...this.videos.keys()]) {
      this.destroyVideo(id);
    }
    this.images.clear();
    this.seekPromises.clear();
    this.seekGen.clear();
    this.ready.clear();
    this.failedVideos.clear();
    this.cache.clear();
  }
}
