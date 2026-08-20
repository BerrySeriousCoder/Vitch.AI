# Tempo — AI Video Editor

Tempo is a browser-based, AI-assisted nonlinear video editor. It combines a
multi-track editing interface, a hardware WebGPU preview compositor, FFmpeg
export, and an AI Creative Director that can plan and perform structured edits.

The project is an actively developed pnpm monorepo. Its first retained
reference-recreation benchmark scores 99/100; see
[`MILESTONES.md`](MILESTONES.md) for the exact scope and evidence behind that
result.

## What Tempo can do

- Edit video, audio, images, text, shapes, SVG, Lottie, and adjustment layers on
  a multi-track timeline with trim, split, move, duplicate, snapping, markers,
  linked A/V edits, undo, and reusable sequences.
- Preview complex compositions through a WebGPU-only renderer with transforms,
  blend modes, parent/controller rigs, alpha/luma mattes, masks, chroma key,
  LUTs, color grading, curves, glow, grain, and geometric transitions.
- Animate clips and graphics with raw keyframes, easing, motion paths,
  cubic-Bezier graph editing, text animators, speed ramps, reverse playback,
  freeze holds, and frame blending.
- Mix and finish audio with fades, automation, ducking, three-band EQ, denoise,
  de-essing, compression, limiting, loudness metering, and export
  normalization.
- Generate timed captions from speech and apply broadcast, minimal, podcast,
  social-pop, and karaoke-style caption presets.
- Organize multicamera edits, synchronize angles from local audio analysis, and
  perform source-monitor insert/overwrite editing.
- Track motion with global optical flow, four-corner planar tracking, and
  optional Replicate SAM 2 subject mattes with editable cleanup regions.
- Import custom fonts, `.cube` LUTs, reusable graphics, project templates, and
  evolving `.tempo-pack` preset bundles.
- Export MP4, WebM, MOV, or GIF through a hybrid pipeline: FFmpeg handles simple
  operations, while complex effects reuse the Chromium/WebGPU compositor for
  preview/export parity.

### AI Creative Director

With a Gemini API key, Tempo can inspect project media, propose an edit plan,
modify the timeline through typed tools, validate its changes, watch rendered
frames, critique the result, and make a bounded correction pass. Changes remain
represented by the same timeline model used by the UI.

**Edit Like This** accepts a reference video or supported public URL, detects
cuts and audio impacts, measures layout and motion, analyzes the reference at
high temporal detail, matches compatible source footage, then compiles the
result into editable tracks, clips, typography, animation, and transitions. It
retains the source reference, transcript, evidence, model usage, and estimated
API cost for later inspection and corrections.

The built-in FFmpeg/TypeScript analyzer works without Python. An optional
project-local OpenCV/PaddleOCR worker adds dense optical-flow trajectories and
repeated text geometry. OpenAI Whisper provides word/segment-timed
transcription, and Replicate can provide SAM 2 video subject mattes.

## Technology

| Area | Stack |
|:---|:---|
| Web editor | Next.js 16, React 19, TypeScript, Tailwind CSS, Zustand |
| Preview | WebGPU/WGSL, Web Audio, Canvas media decode |
| API | Express 5, Socket.IO, Zod |
| Data | PostgreSQL 16, Drizzle ORM |
| Jobs | Redis 7, BullMQ |
| Media/export | FFmpeg/ffprobe, Playwright Chromium |
| AI | Google Gemini, OpenAI Whisper, optional Replicate SAM 2 |
| Optional local CV | Python, OpenCV, PaddlePaddle, PaddleOCR |
| Workspace/tooling | pnpm 10, Turborepo, Vitest, Playwright |

## Prerequisites

- Node.js 20 or newer
- Bash and Python 3.10 or newer (Python is optional when local CV is skipped)
- Docker with Docker Compose for PostgreSQL and Redis
- `ffmpeg` and `ffprobe` on `PATH`
- `yt-dlp` on `PATH` for YouTube, Instagram, TikTok, and X reference URLs
- A recent Google Chrome installation and hardware WebGPU support for the full
  preview, critique, and complex-export path

API keys are feature-specific. Core manual editing does not require every key:

- `GEMINI_API_KEY` enables AI chat and Edit Like This.
- `OPENAI_API_KEY` enables timed Whisper transcription.
- `REPLICATE_API_TOKEN` enables SAM 2 subject mattes.
- `GOOGLE_FONTS_API_KEY` is optional; Tempo has public-catalog and offline
  fallbacks.

## Install all project dependencies

After cloning the repository, run the setup script from the repository root:

```bash
bash scripts/setup.sh
```

The script is safe to run again. It:

1. validates Node, FFmpeg, Python, Docker, and related system tools;
2. installs every pnpm workspace package from `pnpm-lock.yaml` into the correct
   `node_modules` locations;
3. creates `.env` from `.env.example` without overwriting an existing file;
4. downloads the Playwright Chromium revision expected by the API renderer;
5. creates `apps/api/scripts/reference-cv/.venv` and installs CPU OpenCV,
   PaddlePaddle, and PaddleOCR there; and
6. pulls the PostgreSQL and Redis images when Docker Compose is available.

For a smaller install, skip components you do not need:

```bash
bash scripts/setup.sh --without-cv
bash scripts/setup.sh --without-browser --without-services
bash scripts/setup.sh --without-cv --without-browser --without-services
```

Check an existing installation without downloading anything:

```bash
bash scripts/setup.sh --check
```

The script installs project-managed dependencies, but it does not use `sudo` or
install operating-system packages. Install missing Node, Python, Docker,
FFmpeg, Chrome, or yt-dlp packages using the instructions for your operating
system.

## Configure the environment

Open `.env` and replace the placeholder secrets. At minimum, local auth needs
strong values for:

```dotenv
JWT_SECRET=replace-with-a-long-random-secret
JWT_REFRESH_SECRET=replace-with-another-long-random-secret
```

Add the API keys for the features you want. The default local database, Redis,
ports, and storage values in `.env.example` work with `docker-compose.yml`.

To require the optional CV/OCR worker, add the values printed by the setup
script. The Python path must be absolute:

```dotenv
REFERENCE_CV_MODE=opencv
REFERENCE_CV_OCR=true
REFERENCE_CV_PYTHON=/absolute/path/to/tempo/apps/api/scripts/reference-cv/.venv/bin/python
REFERENCE_CV_DEVICE=auto
```

`REFERENCE_CV_MODE=auto` safely falls back to Tempo's built-in analyzer if the
worker is unavailable. Setup automatically installs CUDA-enabled PaddlePaddle
when an NVIDIA GPU is visible and otherwise installs the CPU wheel. Use
`--cv-cpu` or `--cv-gpu` to override detection. The GPU wheel uses Paddle's
CUDA 12.6 package channel and requires a compatible NVIDIA driver.

See [`.env.example`](.env.example) for model overrides, S3/R2 storage,
authorized yt-dlp cookies, browser paths, and other optional settings.

## Run locally

On the first run, start the services, create the database schema, and launch the
apps:

```bash
docker compose up -d
pnpm db:push
pnpm dev
```

| Service | URL |
|:---|:---|
| Web editor | <http://localhost:3000> |
| API | <http://localhost:3001> |
| API health | <http://localhost:3001/health> |

On Linux, `pnpm dev` also opens a dedicated Chrome profile configured for
hardware WebGPU. Keep that window open: interactive preview, reference
critique, and complex export reuse the same hardware adapter and local CDP
endpoint. If it was closed, run:

```bash
pnpm browser:gpu
```

The preview badge should identify an NVIDIA, Intel, or AMD backend. Tempo rejects
Google SwiftShader for interactive preview because it is a CPU renderer. The
launcher uses Vulkan for Dawn/WebGPU and OpenGL for Chrome's display compositor
to avoid known external-memory failures on some Linux/NVIDIA combinations.

Stop the local containers with:

```bash
pnpm dev:down
```

## Useful commands

| Command | Description |
|:---|:---|
| `bash scripts/setup.sh` | Install all project-managed dependencies |
| `bash scripts/setup.sh --check` | Verify dependencies without downloads |
| `pnpm dev` | Start web/API development and the Linux GPU browser |
| `pnpm dev:up` | Start Docker services and the development apps |
| `pnpm dev:down` | Stop Docker services without deleting their data |
| `pnpm browser:gpu` | Relaunch the dedicated hardware-WebGPU Chrome |
| `pnpm db:push` | Push the Drizzle schema to the local database |
| `pnpm build` | Build all packages and apps |
| `pnpm typecheck` | Type-check the API and web app |
| `pnpm lint` | Lint the workspace |
| `pnpm test` | Run the Vitest suite |
| `pnpm benchmark:reference` | Run the retained reference-analysis benchmark |
| `pnpm deps:clean` | Remove reproducible dependencies and build caches |

## Free disk space and reinstall later

Dependencies are generated files and do not belong in Git. To remove the
project-local Node packages, pnpm store, Python CV environment, and Paddle model
cache, run:

```bash
pnpm deps:clean
```

The cleanup script displays the exact directories and sizes, then asks for
confirmation. It removes project-local dependencies plus `.next`, Turbo, and
other reproducible build output. It does not remove source code, `.env`,
uploaded media, Docker volumes, or the global Playwright browser cache.
Reinstall later with:

```bash
bash scripts/setup.sh
```

To remove only build output while keeping dependencies installed, run this
before dependency cleanup:

```bash
pnpm clean
```

### Important before the first GitHub push

This repository's Python virtual environment was accidentally committed in an
earlier local commit. `.gitignore` now prevents that from happening again, but
deleting the directory does not remove its large binaries from existing Git
history. GitHub will reject individual objects over its file-size limit.

Before publishing this existing history, make a backup and remove these paths
from every commit with `git filter-repo` (history rewriting changes commit IDs):

```bash
git filter-repo \
  --path apps/api/scripts/reference-cv/.venv \
  --path apps/api/scripts/reference-cv/.cache \
  --invert-paths
```

If the repository has already been shared, coordinate the rewrite first because
everyone will need to re-clone or reset to the rewritten history. A brand-new
Git history created after the dependency directories are deleted is another
option.

## Repository layout

```text
apps/
  web/                  Next.js editor, WebGPU preview, timeline, inspectors
  api/                  Express API, AI tools, media services, render workers
packages/
  db/                   Drizzle schema and database package
  editor-core/          Pure timeline/edit/render-domain operations
  types/                Shared TypeScript contracts
  validators/           Shared Zod schemas
  config-eslint/        Shared lint configuration
  config-typescript/    Shared TypeScript configuration
scripts/                Setup, development, browser, and benchmark helpers
benchmarks/             Versioned reference-analysis fixtures and scoring
```

## Storage and generated data

- Local uploads are stored under `apps/uploads/` and are ignored by Git.
- Set `STORAGE_PROVIDER=s3` and the S3/R2 variables for object storage.
- PostgreSQL and Redis data live in named Docker volumes and survive
  `pnpm dev:down`. Run `docker compose down -v` only when you intentionally want
  to erase local database and queue data.
- PaddleOCR model weights are kept under
  `apps/api/scripts/reference-cv/.cache`.

## Verify a local installation

Run the automated checks:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Then smoke-test the main workflow:

1. Register, sign in, create a project, and open the editor.
2. Upload media, place it on the timeline, and play the preview.
3. Add text/effects or ask AI Chat to make an edit.
4. Analyze a reference with Edit Like This and inspect the generated editable
   timeline.
5. Export a short video and verify both image and audio output.

## Reference-analysis details

FFmpeg supplies deterministic cut boundaries, while local evidence measures
pixel-change peaks, foreground geometry, large surfaces, black/luma state, and
audio impacts. Gemini performs the authoritative full-detail pass at up to 24
FPS. Long references begin as balanced groups split at detected cuts; malformed
or incomplete responses retry only their missing range. Tempo preflights
cross-scene typography, depth, visibility, and locally measured panel motion
before compilation. Complex compiled ranges are rendered, compared with the
retained reference, repaired once from evidence, and rechecked before they can
be called polished.

Uploads retain rotation-corrected display dimensions, original quality, and
orientation metadata. Source ranking can prefer or require delivery-compatible
portrait, landscape, or square footage. Reference scenes retain independent
layers, z-order, normalized viewports, visibility phases, mattes, event-timed
typography, and measured motion instead of flattening the result into a video.

## Further documentation

- [`PERFORMANCE_AND_EXPORT.md`](PERFORMANCE_AND_EXPORT.md) — renderer
  architecture, export contracts, and performance roadmap
- [`EDITOR_CAPABILITY_INVENTORY.md`](EDITOR_CAPABILITY_INVENTORY.md) — complete
  engine capability ledger and known gaps
- [`AGENTIC_INTELLIGENCE_INVENTORY.md`](AGENTIC_INTELLIGENCE_INVENTORY.md) — AI
  understand/plan/edit/critique architecture
- [`AGENT_HARNESS.md`](AGENT_HARNESS.md) — agent tools, events, and persistence
- [`MILESTONES.md`](MILESTONES.md) — evidence-backed product milestones
- [`benchmarks/reference-analysis/README.md`](benchmarks/reference-analysis/README.md)
  — provider-neutral fixtures and scoring

`CHECKPOINT.md` is a gitignored local progress tracker.
