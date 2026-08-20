#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/.." && pwd)"
cv_dir="$repo_dir/apps/api/scripts/reference-cv"
cv_venv="$cv_dir/.venv"
requirements_file="$repo_dir/apps/api/scripts/reference-cv-requirements.txt"
reference_cv_worker="$repo_dir/apps/api/scripts/reference_cv_worker.py"

install_cv=true
install_browser=true
pull_services=true
check_only=false
cv_paddle_backend="auto"
paddle_version="3.2.0"

usage() {
  cat <<'EOF'
Usage: bash scripts/setup.sh [options]

Install Tempo's project dependencies in their expected locations.

Options:
  --without-cv        Skip the optional OpenCV/PaddleOCR Python environment
  --cv-cpu            Force the CPU-only PaddlePaddle wheel
  --cv-gpu            Force the CUDA-enabled PaddlePaddle wheel
  --without-browser   Skip the Playwright Chromium download
  --without-services  Skip pulling the PostgreSQL and Redis Docker images
  --check             Check the current installation without downloading anything
  -h, --help          Show this help
EOF
}

for argument in "$@"; do
  case "$argument" in
    --without-cv) install_cv=false ;;
    --cv-cpu) cv_paddle_backend="cpu" ;;
    --cv-gpu) cv_paddle_backend="gpu" ;;
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

cv_protocol_is_valid() {
  "$cv_venv/bin/python" "$reference_cv_worker" --protocol-self-test 2>/dev/null \
    | "$cv_venv/bin/python" -c 'import json, sys; value = json.load(sys.stdin); raise SystemExit(0 if value.get("provider") == "tempo-opencv-paddleocr" else 1)'
}

resolve_cv_paddle_backend() {
  if [[ "$cv_paddle_backend" != "auto" ]]; then
    return
  fi
  if command_exists nvidia-smi && nvidia-smi -L >/dev/null 2>&1; then
    cv_paddle_backend="gpu"
  else
    cv_paddle_backend="cpu"
  fi
}

installed_paddle_backend() {
  "$cv_venv/bin/python" -c \
    'import paddle; print("gpu" if paddle.is_compiled_with_cuda() else "cpu")' \
    2>/dev/null
}

paddle_install_matches() {
  local expected_backend="$1"
  "$cv_venv/bin/python" - "$paddle_version" "$expected_backend" <<'PY'
import sys
import paddle

expected_version, expected_backend = sys.argv[1:]
actual_backend = "gpu" if paddle.is_compiled_with_cuda() else "cpu"
raise SystemExit(0 if paddle.__version__ == expected_version and actual_backend == expected_backend else 1)
PY
}

install_paddle() {
  resolve_cv_paddle_backend
  if paddle_install_matches "$cv_paddle_backend" 2>/dev/null; then
    echo "Tempo setup: keeping Paddle $paddle_version ($cv_paddle_backend)."
    return
  fi

  # CPU and GPU Paddle use different distribution names but both provide the
  # same Python modules. Remove either variant before switching backends.
  "$cv_venv/bin/python" -m pip uninstall --yes paddlepaddle paddlepaddle-gpu >/dev/null 2>&1 || true
  if [[ "$cv_paddle_backend" == "gpu" ]]; then
    echo "Tempo setup: NVIDIA GPU detected; installing CUDA 12.6 Paddle $paddle_version..."
    "$cv_venv/bin/python" -m pip install --no-cache-dir \
      "paddlepaddle-gpu==$paddle_version" \
      --index-url https://www.paddlepaddle.org.cn/packages/stable/cu126/
  else
    echo "Tempo setup: installing CPU Paddle $paddle_version..."
    "$cv_venv/bin/python" -m pip install --no-cache-dir \
      "paddlepaddle==$paddle_version" \
      --index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/
  fi
}

verify_paddle_device() {
  local backend
  backend="$(installed_paddle_backend)"
  if [[ "$backend" == "gpu" ]]; then
    "$cv_venv/bin/python" -c \
      'import paddle; count = paddle.device.cuda.device_count(); assert count > 0, "CUDA Paddle installed but no GPU is visible"; paddle.set_device("gpu:0"); print(f"Tempo setup: Paddle CUDA ready ({count} device(s))")'
  else
    echo "Tempo setup: Paddle is using CPU. OCR on long references will be substantially slower."
  fi
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
      && "$cv_venv/bin/python" -c 'import cv2, paddle, paddleocr' >/dev/null 2>&1 \
      && cv_protocol_is_valid; then
      echo "[ok] OpenCV/PaddleOCR environment (Paddle $(installed_paddle_backend))"
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
  install_paddle
  "$cv_venv/bin/python" -m pip install --no-cache-dir -r "$requirements_file"
  "$cv_venv/bin/python" -c \
    'import cv2, paddle, paddleocr; print(f"Tempo setup: OpenCV {cv2.__version__}, Paddle {paddle.__version__}, PaddleOCR ready")'
  verify_paddle_device
  cv_protocol_is_valid
  echo "Tempo setup: OpenCV worker JSON protocol ready"

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
