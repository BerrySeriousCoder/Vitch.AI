import { describe, it, expect } from "vitest";
import { storageUrlToKey } from "./storage.service.js";

describe("storageUrlToKey", () => {
  it("strips /uploads/ prefix for local URLs", () => {
    expect(storageUrlToKey("/uploads/fonts/abc.ttf")).toBe("fonts/abc.ttf");
  });

  it("extracts fonts/media key from absolute URLs", () => {
    expect(
      storageUrlToKey(
        "https://cdn.example.com/bucket/fonts/abc.ttf"
      )
    ).toBe("fonts/abc.ttf");
  });
});
