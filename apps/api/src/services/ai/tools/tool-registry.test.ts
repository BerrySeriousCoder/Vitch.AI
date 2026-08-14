import { describe, expect, it } from "vitest";
import type { AudioMixer } from "@tempo/types";
import {
  MUTATING_TOOL_NAMES,
  createProjectState,
  getAllTools,
  getToolDefinitions,
} from "./index.js";

describe("AI tool registry reliability", () => {
  it("registers every definition exactly once", () => {
    const definitions = getToolDefinitions();
    const names = definitions.map((definition) => definition.name);

    expect(new Set(names).size).toBe(names.length);
    expect(getAllTools().map((tool) => tool.definition.name).sort()).toEqual(
      [...names].sort()
    );
  });

  it("classifies state-changing meta tools as mutations", () => {
    for (const name of [
      "set_effect_params",
      "set_track_pan",
      "set_clip_audio_automation",
      "set_track_audio_automation",
      "add_adjustment_layer",
      "set_graphic_layout",
    ]) {
      expect(MUTATING_TOOL_NAMES.has(name), name).toBe(true);
    }
  });

  it("preserves the complete persisted mixer when an agent turn starts", () => {
    const mixer: AudioMixer = {
      masterVolume: 0.8,
      trackVolumes: { voice: 0.9 },
      trackPans: { voice: -0.25 },
      trackMutes: { music: true },
      trackAutomation: {
        voice: {
          volume: [
            { time: 0, value: 1 },
            { time: 2, value: 0.6 },
          ],
          pan: [{ time: 1, value: 0.4 }],
        },
      },
      trackRoles: { voice: "voice" },
    };

    const state = createProjectState([], mixer);

    expect(state.audioMixer).toEqual(mixer);
    expect(state.audioMixer).not.toBe(mixer);
    expect(state.audioMixer.trackAutomation).not.toBe(mixer.trackAutomation);
  });
});
