#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/.." && pwd)"

if [[ ! -f "$repo_dir/pnpm-workspace.yaml" || ! -f "$repo_dir/package.json" ]]; then
  echo "Tempo cleanup: repository markers were not found; refusing to remove anything." >&2
  exit 1
fi

targets=(
  "$repo_dir/node_modules"
  "$repo_dir/apps/api/node_modules"
  "$repo_dir/apps/web/node_modules"
  "$repo_dir/packages/config-eslint/node_modules"
  "$repo_dir/packages/config-typescript/node_modules"
  "$repo_dir/packages/db/node_modules"
  "$repo_dir/packages/editor-core/node_modules"
  "$repo_dir/packages/types/node_modules"
  "$repo_dir/packages/validators/node_modules"
  "$repo_dir/.pnpm-store"
  "$repo_dir/apps/api/scripts/reference-cv/.venv"
  "$repo_dir/apps/api/scripts/reference-cv/.cache"
  "$repo_dir/apps/api/scripts/__pycache__"
  "$repo_dir/.turbo"
  "$repo_dir/apps/api/.turbo"
  "$repo_dir/apps/web/.turbo"
  "$repo_dir/apps/web/.next"
  "$repo_dir/apps/api/dist"
  "$repo_dir/packages/db/dist"
  "$repo_dir/packages/editor-core/dist"
  "$repo_dir/packages/types/dist"
  "$repo_dir/packages/validators/dist"
  "$repo_dir/coverage"
)

existing=()
for target in "${targets[@]}"; do
  [[ -e "$target" || -L "$target" ]] && existing+=("$target")
done

if ((${#existing[@]} == 0)); then
  echo "Tempo cleanup: no project-local dependency directories were found."
  exit 0
fi

echo "Tempo cleanup will remove these reproducible dependency and build directories:"
du -sh "${existing[@]}" 2>/dev/null || true
echo
read -r -p "Continue? [y/N] " answer
case "$answer" in
  y|Y|yes|YES) ;;
  *) echo "Tempo cleanup cancelled."; exit 0 ;;
esac

for target in "${existing[@]}"; do
  rm -rf -- "$target"
done

echo "Tempo cleanup complete. Restore dependencies with: bash scripts/setup.sh"
