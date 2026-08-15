import { describe, it, expect } from "vitest";
import {
  linear,
  easeIn,
  easeOut,
  easeInOut,
  cubicBezier,
  getEasingFunction,
} from "./easing";

describe("easing functions", () => {
  it("linear maps 0→0, 0.5→0.5, 1→1", () => {
    expect(linear(0)).toBe(0);
    expect(linear(0.5)).toBe(0.5);
    expect(linear(1)).toBe(1);
  });

  it("clamps out-of-range inputs", () => {
    expect(linear(-1)).toBe(0);
    expect(linear(2)).toBe(1);
    expect(easeIn(-0.5)).toBe(0);
    expect(easeOut(1.5)).toBe(1);
  });

  it("easeIn starts slow", () => {
    expect(easeIn(0.5)).toBeLessThan(0.5);
    expect(easeIn(0)).toBe(0);
    expect(easeIn(1)).toBe(1);
  });

  it("easeOut ends slow", () => {
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
  });

  it("easeInOut is symmetric around midpoint", () => {
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 5);
    expect(easeInOut(0.25)).toBeLessThan(0.5);
    expect(easeInOut(0.75)).toBeGreaterThan(0.5);
  });

  it("cubicBezier respects endpoints", () => {
    const fn = cubicBezier(0.42, 0, 0.58, 1);
    expect(fn(0)).toBe(0);
    expect(fn(1)).toBe(1);
    expect(Number.isFinite(fn(0.5))).toBe(true);
  });

  it("getEasingFunction returns matching curves", () => {
    expect(getEasingFunction("linear")(0.5)).toBe(0.5);
    expect(getEasingFunction("ease-in")(0.5)).toBe(easeIn(0.5));
    expect(getEasingFunction("ease-out")(0.5)).toBe(easeOut(0.5));
    expect(getEasingFunction("ease-in-out")(0.5)).toBeCloseTo(0.5, 5);
  });

  it("getEasingFunction cubic-bezier falls back without handles", () => {
    expect(getEasingFunction("cubic-bezier")(0.5)).toBe(0.5);
  });
});
