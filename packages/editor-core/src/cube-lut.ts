/**
 * Parse Adobe/Resolve-style .cube LUT files into a dense RGB volume.
 */

export interface ParsedCubeLut {
  title: string;
  size: number;
  /** length = size^3 * 3, RGB floats 0..1, index = ((b * size + g) * size + r) * 3 */
  data: Float32Array;
  domainMin?: [number, number, number];
  domainMax?: [number, number, number];
}

function parseDomainVec(line: string): [number, number, number] | null {
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
    return [parts[0]!, parts[1]!, parts[2]!];
  }
  return null;
}

function remapDomain(
  values: number[],
  size: number,
  domainMin: [number, number, number],
  domainMax: [number, number, number]
): Float32Array {
  const out = new Float32Array(size * size * size * 3);
  const dr = domainMax[0] - domainMin[0] || 1;
  const dg = domainMax[1] - domainMin[1] || 1;
  const db = domainMax[2] - domainMin[2] || 1;
  for (let i = 0; i < out.length; i += 3) {
    out[i] = (values[i]! - domainMin[0]) / dr;
    out[i + 1] = (values[i + 1]! - domainMin[1]) / dg;
    out[i + 2] = (values[i + 2]! - domainMin[2]) / db;
  }
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.min(1, Math.max(0, out[i]!));
  }
  return out;
}

export function parseCubeLut(text: string): ParsedCubeLut {
  const lines = text.split(/\r?\n/);
  let title = "LUT";
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith("TITLE")) {
      const m = line.match(/TITLE\s+"?([^"]+)"?/i);
      if (m?.[1]) title = m[1].trim();
      continue;
    }
    if (upper.startsWith("LUT_3D_SIZE")) {
      const parts = line.split(/\s+/);
      size = parseInt(parts[1] || "0", 10);
      continue;
    }
    if (upper.startsWith("DOMAIN_MIN")) {
      const v = parseDomainVec(line);
      if (v) domainMin = v;
      continue;
    }
    if (upper.startsWith("DOMAIN_MAX")) {
      const v = parseDomainVec(line);
      if (v) domainMax = v;
      continue;
    }
    if (upper.startsWith("LUT_1D") || upper.startsWith("LUT_3D_INPUT")) {
      continue;
    }
    const nums = line.split(/\s+/).map(Number);
    if (nums.length >= 3 && nums.every((n) => Number.isFinite(n))) {
      values.push(nums[0]!, nums[1]!, nums[2]!);
    }
  }

  if (size < 2 || size > 128) {
    throw new Error(`Invalid LUT_3D_SIZE (${size})`);
  }
  const expected = size * size * size * 3;
  if (values.length < expected) {
    throw new Error(
      `LUT data incomplete: expected ${expected} floats, got ${values.length}`
    );
  }

  const needsRemap =
    domainMin[0] !== 0 ||
    domainMin[1] !== 0 ||
    domainMin[2] !== 0 ||
    domainMax[0] !== 1 ||
    domainMax[1] !== 1 ||
    domainMax[2] !== 1;

  const sliced = values.slice(0, expected);
  const data = needsRemap
    ? remapDomain(sliced, size, domainMin, domainMax)
    : Float32Array.from(sliced);

  return {
    title,
    size,
    data,
    domainMin,
    domainMax,
  };
}

/** Generate a size³ identity LUT (passthrough). */
export function identityCubeLut(size = 16): ParsedCubeLut {
  const data = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        data[i++] = r / (size - 1);
        data[i++] = g / (size - 1);
        data[i++] = b / (size - 1);
      }
    }
  }
  return { title: "Identity", size, data };
}

/** Warm cinematic-ish shift baked as a small 3D LUT. */
export function cinematicCubeLut(size = 16): ParsedCubeLut {
  const data = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        let R = r / (size - 1);
        let G = g / (size - 1);
        let B = b / (size - 1);
        R = Math.pow(R, 0.92) * 1.05;
        G = Math.pow(G, 0.95);
        B = Math.pow(B, 1.05) * 0.95;
        data[i++] = Math.min(1, Math.max(0, R));
        data[i++] = Math.min(1, Math.max(0, G));
        data[i++] = Math.min(1, Math.max(0, B));
      }
    }
  }
  return { title: "Cinematic", size, data };
}

export const BUILTIN_LUT_IDS = ["builtin:identity", "builtin:cinematic"] as const;

export function isBuiltinLutId(lutId: string): boolean {
  return (BUILTIN_LUT_IDS as readonly string[]).includes(lutId);
}

export function getBuiltinLut(lutId: string): ParsedCubeLut | null {
  if (lutId === "builtin:identity") return identityCubeLut(16);
  if (lutId === "builtin:cinematic") return cinematicCubeLut(16);
  return null;
}

/** Mix LUT toward identity for export intensity (0 = no grade, 1 = full). */
export function blendCubeLut(lut: ParsedCubeLut, intensity: number): ParsedCubeLut {
  const t = Math.min(1, Math.max(0, intensity));
  if (t >= 0.999) return lut;
  if (t <= 0.001) return identityCubeLut(lut.size);
  const id = identityCubeLut(lut.size);
  const data = new Float32Array(lut.data.length);
  for (let i = 0; i < data.length; i++) {
    data[i] = id.data[i]! * (1 - t) + lut.data[i]! * t;
  }
  return { title: lut.title, size: lut.size, data };
}

/** Serialize a parsed LUT back to .cube text (for FFmpeg lut3d). */
export function serializeCubeLut(lut: ParsedCubeLut): string {
  const lines: string[] = [
    `TITLE "${lut.title.replace(/"/g, "")}"`,
    `LUT_3D_SIZE ${lut.size}`,
  ];
  for (let i = 0; i < lut.data.length; i += 3) {
    lines.push(
      `${lut.data[i]!.toFixed(6)} ${lut.data[i + 1]!.toFixed(6)} ${lut.data[i + 2]!.toFixed(6)}`
    );
  }
  return lines.join("\n") + "\n";
}
