/**
 * LRU cache for decoded video frames / image bitmaps.
 * Keys are "mediaId:timeSeconds" strings.
 */
export class FrameCache {
  private map = new Map<string, ImageBitmap>();
  private order: string[] = [];
  private byteSizes = new Map<string, number>();
  private currentBytes = 0;

  constructor(private maxSize = 60, private maxBytes = 256 * 1024 * 1024) {}

  static makeKey(mediaId: string, time: number): string {
    return `${mediaId}:${time.toFixed(3)}`;
  }

  get(key: string): ImageBitmap | undefined {
    const bmp = this.map.get(key);
    if (bmp) {
      const idx = this.order.indexOf(key);
      if (idx > -1) this.order.splice(idx, 1);
      this.order.push(key);
    }
    return bmp;
  }

  set(key: string, bitmap: ImageBitmap): void {
    if (this.map.has(key)) {
      const idx = this.order.indexOf(key);
      if (idx > -1) this.order.splice(idx, 1);
      this.currentBytes -= this.byteSizes.get(key) || 0;
      const previous = this.map.get(key);
      if (previous && previous !== bitmap) previous.close();
    }
    const byteSize = Math.max(0, bitmap.width * bitmap.height * 4);
    this.map.set(key, bitmap);
    this.byteSizes.set(key, byteSize);
    this.currentBytes += byteSize;
    this.order.push(key);

    while (this.order.length > this.maxSize || (this.currentBytes > this.maxBytes && this.order.length > 1)) {
      const evictKey = this.order.shift()!;
      const evicted = this.map.get(evictKey);
      if (evicted) evicted.close();
      this.currentBytes -= this.byteSizes.get(evictKey) || 0;
      this.byteSizes.delete(evictKey);
      this.map.delete(evictKey);
    }
  }

  clear(): void {
    for (const bmp of this.map.values()) bmp.close();
    this.map.clear();
    this.byteSizes.clear();
    this.currentBytes = 0;
    this.order = [];
  }
}
