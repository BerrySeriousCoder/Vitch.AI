import { describe, expect, it } from "vitest";
import { cosineSimilarity, rankShots } from "./style-dna";
import type { ShotIndexEntry } from "@tempo/types";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });
  it("returns 0 for orthogonal or invalid", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
  });
});

describe("rankShots with embeddings", () => {
  it("boosts embedding match", () => {
    const shots: ShotIndexEntry[] = [
      {
        id: "a",
        assetId: "m",
        start: 0,
        end: 1,
        tags: [],
        subjects: [],
        bestFor: [],
        embedding: [1, 0, 0],
        analyzedAt: "",
      },
      {
        id: "b",
        assetId: "m",
        start: 1,
        end: 2,
        tags: [],
        subjects: [],
        bestFor: [],
        embedding: [0, 1, 0],
        analyzedAt: "",
      },
    ];
    const ranked = rankShots(shots, {
      role: "broll",
      queryEmbedding: [1, 0, 0],
      embeddingWeight: 0.9,
    });
    expect(ranked[0]!.shot.id).toBe("a");
  });
});
