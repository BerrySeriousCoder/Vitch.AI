import { describe, it, expect } from "vitest";
import {
  loginSchema,
  registerSchema,
  createProjectSchema,
  updateProjectSchema,
  primaryColorGradeSchema,
  hslSecondarySchema,
  liftGammaGainSchema,
  levelsSchema,
  colorCurvesSchema,
  trackMatteSchema,
  stabilizationSchema,
  mediaUploadSchema,
  referenceVideoSchema,
} from "./index.js";

describe("loginSchema", () => {
  it("accepts valid credentials", () => {
    const result = loginSchema.safeParse({
      email: "user@example.com",
      password: "password123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid email", () => {
    const result = loginSchema.safeParse({
      email: "not-an-email",
      password: "password123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects short password", () => {
    const result = loginSchema.safeParse({
      email: "user@example.com",
      password: "short",
    });
    expect(result.success).toBe(false);
  });
});

describe("registerSchema", () => {
  it("accepts strong password with name", () => {
    const result = registerSchema.safeParse({
      email: "user@example.com",
      password: "Password1",
      name: "Tempo User",
    });
    expect(result.success).toBe(true);
  });

  it("rejects password without uppercase", () => {
    const result = registerSchema.safeParse({
      email: "user@example.com",
      password: "password1",
      name: "Tempo User",
    });
    expect(result.success).toBe(false);
  });

  it("rejects short name", () => {
    const result = registerSchema.safeParse({
      email: "user@example.com",
      password: "Password1",
      name: "A",
    });
    expect(result.success).toBe(false);
  });
});

describe("createProjectSchema", () => {
  it("accepts name only", () => {
    const result = createProjectSchema.safeParse({ name: "My Project" });
    expect(result.success).toBe(true);
  });

  it("accepts custom settings", () => {
    const result = createProjectSchema.safeParse({
      name: "My Project",
      settings: { width: 1280, height: 720, fps: 24 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = createProjectSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid fps", () => {
    const result = createProjectSchema.safeParse({
      name: "X",
      settings: { fps: 0 },
    });
    expect(result.success).toBe(false);
  });
});

describe("updateProjectSchema", () => {
  it("accepts partial update", () => {
    const result = updateProjectSchema.safeParse({ name: "Renamed" });
    expect(result.success).toBe(true);
  });

  it("accepts data payload", () => {
    const result = updateProjectSchema.safeParse({
      data: { tracks: [] },
    });
    expect(result.success).toBe(true);
  });
});

describe("primaryColorGradeSchema", () => {
  it("accepts partial primary correction", () => {
    expect(
      primaryColorGradeSchema.safeParse({ exposure: 0.4, temperature: 18 }).success
    ).toBe(true);
  });

  it("rejects out-of-range or unknown grade controls", () => {
    expect(primaryColorGradeSchema.safeParse({ highlights: -140 }).success).toBe(false);
    expect(primaryColorGradeSchema.safeParse({ clarity: 20 }).success).toBe(false);
  });
});

describe("hslSecondarySchema", () => {
  it("accepts a bounded secondary qualifier and correction", () => {
    expect(hslSecondarySchema.safeParse({
      hueCenter: 28,
      hueRange: 18,
      saturationMin: 0.15,
      saturationMax: 0.85,
      lightnessMin: 0.1,
      lightnessMax: 0.9,
      feather: 0.2,
      hueShift: -8,
      saturationShift: 12,
      lightnessShift: 4,
      mix: 0.8,
    }).success).toBe(true);
  });

  it("rejects inverted ranges and unknown controls", () => {
    expect(hslSecondarySchema.safeParse({ saturationMin: 0.8, saturationMax: 0.2 }).success).toBe(false);
    expect(hslSecondarySchema.safeParse({ clarity: 10 }).success).toBe(false);
  });
});

describe("liftGammaGainSchema", () => {
  it("accepts partial wheel controls", () => {
    expect(liftGammaGainSchema.safeParse({ liftBlue: 0.2, gammaMaster: -0.1, gainRed: 0.4 }).success).toBe(true);
  });

  it("rejects out-of-range or unknown controls", () => {
    expect(liftGammaGainSchema.safeParse({ gainMaster: 1.2 }).success).toBe(false);
    expect(liftGammaGainSchema.safeParse({ shadows: 0.2 }).success).toBe(false);
  });
});

describe("levelsSchema", () => {
  it("accepts a partial levels correction", () => {
    expect(levelsSchema.safeParse({ inputBlack: 0.06, inputWhite: 0.94, gamma: 1.15 }).success).toBe(true);
  });

  it("rejects invalid ranges", () => {
    expect(levelsSchema.safeParse({ inputBlack: 0.8, inputWhite: 0.2 }).success).toBe(false);
    expect(levelsSchema.safeParse({ gamma: 0.01 }).success).toBe(false);
  });
});

describe("colorCurvesSchema", () => {
  it("accepts an ordered luma curve", () => {
    expect(
      colorCurvesSchema.safeParse({
        luma: [{ x: 0, y: 0 }, { x: 0.5, y: 0.65 }, { x: 1, y: 1 }],
      }).success
    ).toBe(true);
  });

  it("rejects non-monotonic curves", () => {
    expect(
      colorCurvesSchema.safeParse({
        red: [{ x: 0, y: 0 }, { x: 0.6, y: 0.4 }, { x: 0.4, y: 1 }, { x: 1, y: 1 }],
      }).success
    ).toBe(false);
  });
});

describe("mediaUploadSchema", () => {
  it("accepts valid video upload meta", () => {
    const result = mediaUploadSchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      fileName: "clip.mp4",
      fileSize: 1024,
      mimeType: "video/mp4",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-media mime type", () => {
    const result = mediaUploadSchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      fileName: "doc.pdf",
      fileSize: 1024,
      mimeType: "application/pdf",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid project id", () => {
    const result = mediaUploadSchema.safeParse({
      projectId: "not-a-uuid",
      fileName: "clip.mp4",
      fileSize: 1024,
      mimeType: "video/mp4",
    });
    expect(result.success).toBe(false);
  });
});

describe("referenceVideoSchema", () => {
  const projectId = "550e8400-e29b-41d4-a716-446655440000";

  it.each([
    "https://www.youtube.com/watch?v=abc123",
    "https://youtube.com/shorts/abc123",
    "https://youtu.be/abc123",
    "https://www.instagram.com/reel/abc123/",
    "https://www.tiktok.com/@user/video/123",
    "https://x.com/user/status/123",
  ])("accepts %s", (url) => {
    expect(referenceVideoSchema.safeParse({ url, projectId }).success).toBe(true);
  });

  it("rejects unsupported host", () => {
    const result = referenceVideoSchema.safeParse({
      url: "https://example.com/video",
      projectId,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid url", () => {
    const result = referenceVideoSchema.safeParse({
      url: "not-a-url",
      projectId,
    });
    expect(result.success).toBe(false);
  });

  it("rejects lookalike hosts and non-video platform pages", () => {
    expect(referenceVideoSchema.safeParse({
      url: "https://evil.example/?next=https://youtube.com/watch?v=x",
      projectId,
    }).success).toBe(false);
    expect(referenceVideoSchema.safeParse({
      url: "https://www.instagram.com/explore/",
      projectId,
    }).success).toBe(false);
    expect(referenceVideoSchema.safeParse({
      url: "http://www.youtube.com/watch?v=abc123",
      projectId,
    }).success).toBe(false);
  });

  it("requires permission for reference soundtrack reuse", () => {
    const result = referenceVideoSchema.safeParse({
      url: "https://www.instagram.com/reel/abc123/",
      projectId,
      audioPolicy: {
        soundtrack: "reference",
        sourceAudio: "mute",
        referenceAudioAuthorized: false,
        soundtrackVolume: 0.85,
        sourceVolume: 1,
        duckLevel: 0.25,
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("compositing persistence schemas", () => {
  it("accepts an AI matte refinement contract", () => {
    expect(trackMatteSchema.safeParse({
      sourceClipId: "matte", type: "luma", refinement: { threshold: 0.55, feather: 0.03, inverted: false },
    }).success).toBe(true);
  });

  it("rejects invalid stabilization crop ranges", () => {
    expect(stabilizationSchema.safeParse({
      enabled: true, smoothness: 0.5, cropScale: 0.9,
      samples: [{ time: 0, x: 0.5, y: 0.5 }, { time: 1, x: 0.55, y: 0.5 }],
    }).success).toBe(false);
  });
});
