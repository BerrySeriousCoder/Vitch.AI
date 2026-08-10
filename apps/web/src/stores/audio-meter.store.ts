import { create } from "zustand";

export interface LoudnessMeterState {
  momentaryLufs: number | null;
  shortTermLufs: number | null;
  integratedLufs: number | null;
  peakDbfs: number | null;
  updatedAt: number | null;
}

const empty: LoudnessMeterState = {
  momentaryLufs: null,
  shortTermLufs: null,
  integratedLufs: null,
  peakDbfs: null,
  updatedAt: null,
};

export const useAudioMeterStore = create<LoudnessMeterState & {
  setMeter: (next: LoudnessMeterState) => void;
  resetMeter: () => void;
}>((set) => ({
  ...empty,
  setMeter: (next) => set(next),
  resetMeter: () => set(empty),
}));
