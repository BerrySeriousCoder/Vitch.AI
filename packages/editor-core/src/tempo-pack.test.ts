import { describe, expect, it } from "vitest";
import {
  validateTempoPackManifest,
  safePackPath,
  listPresets,
  listTempoPacks,
  applyPreset,
  getTempoPack,
  registerTempoPack,
  clearProjectPacks,
} from "./tempo-pack";

describe("tempo-pack", () => {
  it("validates manifest", () => {
    const ok = validateTempoPackManifest({
      id: "x",
      name: "X",
      version: "1",
      presets: [{ id: "p", name: "P", kind: "animation", animationPresetId: "fade-in" }],
    });
    expect(ok.ok).toBe(true);
  });

  it("rejects zip-slip paths", () => {
    expect(safePackPath("/packs/a", "../etc/passwd")).toBeNull();
    expect(safePackPath("/packs/a", "assets/x.cube")).toBe("/packs/a/assets/x.cube");
  });

  it("lists builtin presets and applies kinetic", () => {
    expect(getTempoPack("builtin:core")).toBeTruthy();
    const presets = listPresets("builtin:core");
    expect(presets.length).toBeGreaterThan(5);
    const kinetic = presets.find((p) => p.kineticPresetId === "typewriter");
    expect(kinetic).toBeTruthy();
    const applied = applyPreset("builtin:core", kinetic!.id, {
      clipDuration: 2,
      textParams: {
        text: "Hi",
        fontFamily: "Inter",
        fontSize: 40,
        fontWeight: "600",
        color: "#fff",
        textAlign: "center",
        lineHeight: 1.2,
      },
    });
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.textParams?.split).toBe("char");
  });

  it("scopes packs per project (no cross-project leak)", () => {
    const a = "proj-a";
    const b = "proj-b";
    clearProjectPacks(a);
    clearProjectPacks(b);

    registerTempoPack(
      {
        manifest: {
          id: "custom:pack",
          name: "A only",
          version: "1",
          kind: "mixed",
          presets: [
            {
              id: "p1",
              name: "P1",
              kind: "effect",
              effectPresetId: "cinematic",
            },
          ],
        },
      },
      a
    );

    expect(listTempoPacks(a).some((p) => p.id === "custom:pack")).toBe(true);
    expect(listTempoPacks(b).some((p) => p.id === "custom:pack")).toBe(false);
    expect(getTempoPack("custom:pack", b)).toBeUndefined();
    expect(getTempoPack("custom:pack", a)?.manifest.name).toBe("A only");
    expect(applyPreset("custom:pack", "p1", { clipDuration: 1 }, b).ok).toBe(
      false
    );
    expect(applyPreset("custom:pack", "p1", { clipDuration: 1 }, a).ok).toBe(
      true
    );

    clearProjectPacks(a);
    expect(listTempoPacks(a).some((p) => p.id === "custom:pack")).toBe(false);
    expect(listTempoPacks().every((p) => p.id.startsWith("builtin:"))).toBe(
      true
    );
  });
});
