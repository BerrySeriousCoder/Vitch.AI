import { describe, expect, it } from "vitest";
import type { Track } from "@tempo/types";
import { adjustmentLayerToolExecutors } from "./adjustment-layers.tool.js";

describe("adjustment layer tools", () => {
  it("creates an effect-host clip with an explicit below-stack scope", () => {
    const state = {
      tracks: [] as Track[],
      transitions: [],
      audioMixer: { masterVolume: 1, trackVolumes: {}, trackMutes: {} },
    };
    const out = adjustmentLayerToolExecutors.add_adjustment_layer!(
      { name: "Global Grade", startTime: 1, duration: 5 },
      state
    );
    expect(out.result).not.toMatch(/^Error/);
    expect(out.state.tracks[0]!.type).toBe("adjustment");
    expect(out.state.tracks[0]!.clips[0]!.adjustmentLayer).toEqual({ target: "below" });
  });
});
