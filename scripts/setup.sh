#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/.." && pwd)"
cv_dir="$repo_dir/apps/api/scripts/reference-cv"
cv_venv="$cv_dir/.venv"
requirements_file="$repo_dir/apps/api/scripts/reference-cv-requirements.txt"

install_cv=true
install_browser=true
pull_services=true
check_only=false

usage() {
  cat <<'EOF'
Usage: bash scripts/setup.sh [options]

Install Tempo's project dependencies in their expected locations.

Options:
  --without-cv        Skip the optional OpenCV/PaddleOCR Python environment
  --without-browser   Skip the Playwright Chromium download
  --without-services  Skip pulling the PostgreSQL and Redis Docker images
  --check             Check the current installation without downloading anything
  -h, --help          Show this help
EOF
}

for argument in "$@"; do
  case "$argument" in
    --without-cv) install_cv=false ;;
    --without-browser) install_browser=false ;;
    --without-services) pull_services=false ;;
    --check) check_only=true ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Tempo setup: unknown option: $argument" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

node_major_version() {
  node -p 'Number(process.versions.node.split(".")[0])'
}

python_version_is_supported() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'
}

print_system_status() {
  local missing=()
  local optional_missing=()

  for tool in ffmpeg ffprobe; do
    command_exists "$tool" || missing+=("$tool")
  done
  for tool in docker yt-dlp; do
    command_exists "$tool" || optional_missing+=("$tool")
  done

  if ((${#missing[@]})); then
    echo "Tempo setup: missing required system tools: ${missing[*]}" >&2
    echo "Install them with your operating-system package manager, then run this script again." >&2
    return 1
  fi
  if ((${#optional_missing[@]})); then
    echo "Tempo setup: optional tools not found: ${optional_missing[*]}"
    echo "  Docker is needed for the local database/queue; yt-dlp is needed for reference URLs."
  fi
}

resolve_pnpm() {
  if command_exists pnpm; then
    PNPM=(pnpm)
    return
  fi
  if ! command_exists corepack; then
    echo "Tempo setup: pnpm is missing and Corepack is unavailable." >&2
    echo "Install pnpm 10.8.0, then run this script again." >&2
    exit 1
  fi
  if ! "$check_only"; then
    corepack prepare pnpm@10.8.0 --activate
  fi
  PNPM=(corepack pnpm)
}

check_installation() {
  local status=0

  [[ -d "$repo_dir/node_modules" ]] \
    && echo "[ok] Node workspace dependencies" \
    || { echo "[missing] Node workspace dependencies"; status=1; }

  if "$install_browser"; then
    if (cd "$repo_dir/apps/api" && "${PNPM[@]}" exec playwright install --list 2>/dev/null | grep -q chromium); then
      echo "[ok] Playwright browser"
    else
      echo "[missing] Playwright browser"
      status=1
    fi
  fi

  if "$install_cv"; then
    if [[ -x "$cv_venv/bin/python" ]] \
      && "$cv_venv/bin/python" -c 'import cv2, paddle, paddleocr' >/dev/null 2>&1; then
      echo "[ok] OpenCV/PaddleOCR environment"
    else
      echo "[missing] OpenCV/PaddleOCR environment"
      status=1
    fi
  fi

  return "$status"
}

cd "$repo_dir"

if ! command_exists node; then
  echo "Tempo setup: Node.js 20 or newer is required." >&2
  exit 1
fi
if (( $(node_major_version) < 20 )); then
  echo "Tempo setup: Node.js 20 or newer is required; found $(node --version)." >&2
  exit 1
fi

resolve_pnpm

if "$check_only"; then
  print_system_status || true
  check_installation
  exit $?
fi

print_system_status

echo "Tempo setup: installing the pnpm workspace from pnpm-lock.yaml..."
"${PNPM[@]}" install --frozen-lockfile --store-dir "$repo_dir/.pnpm-store"

if [[ ! -f "$repo_dir/.env" ]]; then
  cp "$repo_dir/.env.example" "$repo_dir/.env"
  echo "Tempo setup: created .env from .env.example (add your secrets before starting Tempo)."
else
  echo "Tempo setup: keeping the existing .env file."
fi

if "$install_browser"; then
  echo "Tempo setup: installing the Chromium revision used by the API renderer..."
  (cd "$repo_dir/apps/api" && "${PNPM[@]}" exec playwright install chromium)
fi

if "$install_cv"; then
  if ! command_exists python3; then
    echo "Tempo setup: Python 3.10+ is required for --with-cv." >&2
    exit 1
  fi
  if ! python_version_is_supported python3; then
    echo "Tempo setup: Python 3.10 or newer is required; found $(python3 --version)." >&2
    exit 1
  fi

  echo "Tempo setup: installing OpenCV and PaddleOCR in $cv_venv..."
  python3 -m venv "$cv_venv"
  "$cv_venv/bin/python" -m pip install --no-cache-dir --upgrade pip setuptools wheel
  "$cv_venv/bin/python" -m pip install --no-cache-dir \
    paddlepaddle==3.2.0 \
    --index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/
  "$cv_venv/bin/python" -m pip install --no-cache-dir -r "$requirements_file"
  "$cv_venv/bin/python" -c \
    'import cv2, paddle, paddleocr; print(f"Tempo setup: OpenCV {cv2.__version__}, Paddle {paddle.__version__}, PaddleOCR ready")'

  echo "Tempo setup: add these values to .env to require the optional worker:"
  echo "  REFERENCE_CV_MODE=opencv"
  echo "  REFERENCE_CV_OCR=true"
  printf '  REFERENCE_CV_PYTHON=%s\n' "$cv_venv/bin/python"
  echo "  REFERENCE_CV_DEVICE=auto"
fi

if "$pull_services"; then
  if command_exists docker && docker compose version >/dev/null 2>&1; then
    echo "Tempo setup: pulling PostgreSQL and Redis images..."
    docker compose pull
  else
    echo "Tempo setup: Docker Compose is unavailable; skipping service images."
  fi
fi

echo
echo "Tempo setup complete."
echo "1. Fill in .env (at minimum JWT_SECRET and JWT_REFRESH_SECRET)."
echo "2. Run: docker compose up -d"
echo "3. Run: pnpm db:push"
echo "4. Run: pnpm dev"

