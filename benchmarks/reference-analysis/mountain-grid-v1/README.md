# mountain-grid-v1

Benchmark V1 covers the first 6.17 seconds of the retained mountain edit.

## Milestone status

Achieved on 2026-08-15. The reviewed fixture passes at **99/100**, and a
production Edit Like This run was manually verified for the defining title,
z-order, grid placement, reveal directions, motion trajectory, and beat timing.
See [`MILESTONES.md`](../../../MILESTONES.md) for the acceptance record and the
boundary of what V1 proves.

It tests:

- cumulative editorial text states;
- Google Font matching and measured glyph geometry;
- media-filled typography with no stroke;
- persistent title/matte lifetime beneath foreground panels;
- one global z-order domain;
- four independent quadrant surfaces;
- anchored `cover` cropping;
- sequential panel timing;
- a fast–hesitate–fast reveal trajectory;
- monotonic visibility without opacity flicker.

## Measured interpretation

The panels are not ordinary stationary-image wipes. During expansion, the visible source slice is anchored to the opposite crop edge:

- top-left and top-right expand left-to-right while initially showing the source's right side;
- bottom-right expands top-to-bottom while initially showing the source's bottom;
- bottom-left expands right-to-left while initially showing the source's left side.

Tempo can express this using its existing animated viewport plus `fit: cover` and `focalPoint`; no benchmark-specific transition or mask primitive is required.

The edge trajectory is approximately cubic ease-out to 50%, followed by cubic ease-in from 50%. The `benchmark.json` progress arrays, measured at 30 fps, are authoritative; the easing name is only a convenient approximation.

`MOUNTAIN` remains active beneath the final panel while it expands. Once all four panels fill the frame at 5.667 seconds, removing or retaining the fully occluded title is visually equivalent. The gold blueprint ends it at that measurable boundary.

## Provenance

- Reference dimensions: 1916×1078
- Frame rate: 30 fps
- Visual interval: 0–6.17 seconds
- Audio retained for later beat/alignment scoring
- Reference hash recorded in `benchmark.json`

## Current gold result

| Metric | Result |
|:---|---:|
| Exact text states | Pass |
| Text timing MAE | 0.000 frames |
| Typography matches | 1.00 |
| Matched panels | 4/4 |
| Mean viewport IoU | 1.00 |
| Panel timing MAE | 0.0063 frames |
| Direction / focal / z accuracy | 1.00 / 1.00 / 1.00 |
| Reveal-progress MAE | 0.0066 |
| Monotonic panels / integrity errors | 4/4 / 0 |
