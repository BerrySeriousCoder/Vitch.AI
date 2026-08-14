#!/usr/bin/env bash
set -euo pipefail

chrome_bin="${CHROME_EXECUTABLE_PATH:-/usr/bin/google-chrome-stable}"
if [[ ! -x "$chrome_bin" ]]; then
  chrome_bin="$(command -v google-chrome-stable || command -v google-chrome || true)"
fi
if [[ -z "$chrome_bin" || ! -x "$chrome_bin" ]]; then
  echo "Tempo: Google Chrome was not found. Set CHROME_EXECUTABLE_PATH." >&2
  exit 1
fi

profile_dir="${TEMPO_CHROME_PROFILE:-${TMPDIR:-/tmp}/tempo-chrome-webgpu-gl}"
tempo_url="${TEMPO_WEB_URL:-http://localhost:3000}"
debug_port="${TEMPO_CHROME_DEBUG_PORT:-9222}"

echo "Tempo: launching Chrome with Vulkan WebGPU + OpenGL display compositing."
echo "Tempo: the preview badge must show NVIDIA, Intel, or AMD; SwiftShader is rejected."
echo "Tempo: offline critique/export will reuse this GPU session on localhost:${debug_port}."

exec "$chrome_bin" \
  --user-data-dir="$profile_dir" \
  --no-first-run \
  --no-default-browser-check \
  --new-window \
  --enable-unsafe-webgpu \
  --ignore-gpu-blocklist \
  --enable-features=Vulkan \
  --use-angle=gl \
  --ozone-platform=x11 \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$debug_port" \
  "$tempo_url" "$@"
