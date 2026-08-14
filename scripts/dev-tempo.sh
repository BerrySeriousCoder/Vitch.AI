#!/usr/bin/env bash
set -uo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/.." && pwd)"
tempo_web_url="${TEMPO_WEB_URL:-http://localhost:3000}"
debug_port="${TEMPO_CHROME_DEBUG_PORT:-9222}"
cdp_url="${CHROME_CDP_URL:-http://127.0.0.1:${debug_port}}"
chrome_log="${TEMPO_CHROME_LOG:-${TMPDIR:-/tmp}/tempo-chrome-webgpu.log}"

dev_pid=""
chrome_pid=""

endpoint_ready() {
  curl --silent --fail --max-time 1 "${cdp_url%/}/json/version" >/dev/null 2>&1
}

web_ready() {
  curl --silent --fail --max-time 1 "$tempo_web_url" >/dev/null 2>&1
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if [[ -n "$chrome_pid" ]] && kill -0 "$chrome_pid" 2>/dev/null; then
    kill -TERM "$chrome_pid" 2>/dev/null || true
    wait "$chrome_pid" 2>/dev/null || true
  fi
  if [[ -n "$dev_pid" ]] && kill -0 "$dev_pid" 2>/dev/null; then
    kill -TERM "$dev_pid" 2>/dev/null || true
    wait "$dev_pid" 2>/dev/null || true
  fi

  exit "$status"
}

trap cleanup EXIT INT TERM

cd "$repo_dir"
pnpm exec turbo run dev &
dev_pid=$!

echo "Tempo: starting development services…"
for _ in $(seq 1 120); do
  if web_ready; then
    break
  fi
  if ! kill -0 "$dev_pid" 2>/dev/null; then
    wait "$dev_pid"
    exit $?
  fi
  sleep 0.5
done

if endpoint_ready; then
  echo "Tempo: reusing GPU Chrome at ${cdp_url}."
elif [[ -z "${DISPLAY:-}" ]]; then
  echo "Tempo: DISPLAY is unavailable; GPU Chrome was not started."
  echo "Tempo: critique/export will require pnpm browser:gpu from a graphical session."
else
  echo "Tempo: launching the dedicated GPU Chrome used by preview, critique, and export."
  echo "Tempo: Chrome diagnostics are written to ${chrome_log}."
  TEMPO_WEB_URL="$tempo_web_url" TEMPO_CHROME_DEBUG_PORT="$debug_port" \
    bash "$script_dir/launch-tempo-chrome.sh" >"$chrome_log" 2>&1 &
  chrome_pid=$!

  for _ in $(seq 1 40); do
    if endpoint_ready; then
      echo "Tempo: GPU Chrome endpoint ready at ${cdp_url}."
      break
    fi
    if ! kill -0 "$chrome_pid" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done

  if ! endpoint_ready; then
    echo "Tempo: GPU Chrome did not expose ${cdp_url}."
    echo "Tempo: inspect ${chrome_log}, then run pnpm browser:gpu manually."
  fi
fi

wait "$dev_pid"
