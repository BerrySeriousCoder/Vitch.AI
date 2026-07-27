export interface ThreePointEditMarks {
  sourceIn: number;
  sourceOut?: number;
  timelineIn: number;
  timelineOut?: number;
  speed?: number;
}

export function resolveThreePointEdit(marks: ThreePointEditMarks):
  | { ok: true; sourceIn: number; sourceOut: number; timelineIn: number; timelineOut: number; duration: number }
  | { ok: false; message: string } {
  const speed = Math.abs(Number(marks.speed ?? 1));
  if (!(speed > 0) || !Number.isFinite(speed)) return { ok: false, message: "speed must be a positive finite number" };
  const sourceIn = Number(marks.sourceIn);
  const timelineIn = Number(marks.timelineIn);
  if (sourceIn < 0 || timelineIn < 0 || !Number.isFinite(sourceIn) || !Number.isFinite(timelineIn)) return { ok: false, message: "sourceIn and timelineIn must be non-negative finite numbers" };
  const hasSourceOut = marks.sourceOut != null;
  const hasTimelineOut = marks.timelineOut != null;
  if (!hasSourceOut && !hasTimelineOut) return { ok: false, message: "Set sourceOut or timelineOut (three-point edit requires three marks)" };
  const sourceOut = hasSourceOut ? Number(marks.sourceOut) : sourceIn + (Number(marks.timelineOut) - timelineIn) * speed;
  const timelineOut = hasTimelineOut ? Number(marks.timelineOut) : timelineIn + (sourceOut - sourceIn) / speed;
  if (!(sourceOut > sourceIn) || !(timelineOut > timelineIn) || !Number.isFinite(sourceOut) || !Number.isFinite(timelineOut)) return { ok: false, message: "Out marks must be after their matching in marks" };
  const sourceDuration = (sourceOut - sourceIn) / speed;
  const timelineDuration = timelineOut - timelineIn;
  if (Math.abs(sourceDuration - timelineDuration) > 1e-3) return { ok: false, message: "Four-point marks disagree after speed conversion; adjust one out point" };
  return { ok: true, sourceIn, sourceOut, timelineIn, timelineOut, duration: timelineDuration };
}
