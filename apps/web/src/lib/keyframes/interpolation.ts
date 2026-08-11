/** Re-export shared keyframe interpolation from editor-core (single source of truth). */
export {
  interpolateValue,
  resolveKeyframeValues,
  resolveEffectParamsAtTime,
  getEasingFunction,
  linear,
  easeIn,
  easeOut,
  easeInOut,
  cubicBezier,
  type EasingFunction,
} from "@tempo/editor-core";
