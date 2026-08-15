# Reference-analysis benchmarks

These fixtures measure how faithfully any vision model/provider converts a reference video into Tempo's provider-neutral `EditBlueprint`. They also protect deterministic reconciliation and compilation from regressions.

The first achieved product milestone is
[`mountain-grid-v1`](mountain-grid-v1/README.md), recorded in the root
[`MILESTONES.md`](../../MILESTONES.md). New successes should be added as new
versioned fixtures; never broaden a fixture's meaning after it passes.

Each benchmark is intentionally split into three layers:

1. **Raw provider analysis** — evaluate the model response before deterministic correction. This exposes provider strengths and weaknesses.
2. **Production blueprint** — evaluate the reconciled blueprint. This proves Tempo repairs measurable errors without hiding the raw provider score.
3. **Compiler/render** — compile the gold blueprint with fixed asset mappings and compare the resulting timeline/render. This isolates editor failures from analysis failures.

## Required fixture files

Every directory contains:

- `reference.mp4` — retained, immutable reference interval.
- `benchmark.json` — measured provider-neutral expectations and pass thresholds.
- `gold-blueprint.json` — reviewed blueprint known to express the reference correctly.
- `README.md` — visual behavior, measurement decisions and any unavoidable ambiguity.

The reference SHA-256 is checked before every run. Never replace media in place: add a new versioned benchmark when the reference or interpretation changes.

## Running

Run the reviewed gold self-check:

```bash
pnpm benchmark:reference
```

Evaluate a provider or exported project blueprint:

```bash
pnpm benchmark:reference -- --candidate /absolute/path/to/blueprint.json
```

Machine-readable output:

```bash
pnpm benchmark:reference -- --candidate /absolute/path/to/blueprint.json --json
```

The command exits non-zero on a failed benchmark. Use `--allow-fail` only for exploratory provider comparisons, never for CI gates.

Benchmarks may declare `reference.sourceUrlContains`. During Edit Like This, a matching retained reference is scored automatically after deterministic reconciliation. A failed score forces draft quality and is stored with the project; it can never be reported as a polished match.

Provider comparisons must also record whether analysis used the single-request
path or the long-reference adaptive full-detail path. Chunking is an execution
boundary, not a lower-detail schema: every request runs at 24 FPS and must return
the same complete scene structure with absolute timestamps/scene ids. Long
references begin with balanced ~30-second groups plus adjacent transition video
and a global storyboard; only a failed range may subdivide. Do not benchmark a
compact summary against a detailed gold blueprint.

## Adding a benchmark

1. Select the smallest interval that isolates the new capability.
2. Retain the exact source interval with audio and original frame rate.
3. Measure event boundaries and motion edges at native fps; do not use model guesses as gold data.
4. Author and review the gold blueprint.
5. Add objective thresholds. Prefer frame errors, viewport IoU, trajectory MAE and pairwise z-order over subjective labels.
6. Add an evaluator test proving the gold passes and one intentionally broken candidate fails for the expected reason.
7. Document observable ambiguity, such as a background that may terminate after it becomes fully occluded.

Do not combine unrelated capabilities merely to make a benchmark look difficult. Complexity is added gradually through additional fixtures.
