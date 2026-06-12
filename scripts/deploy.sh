#!/usr/bin/env bash
set -euo pipefail

BRANCH="${DEPLOY_BRANCH:-main}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to deploy with a dirty worktree."
  git status --short
  exit 1
fi

OLD_HEAD="$(git rev-parse HEAD)"

git fetch origin "$BRANCH"
git pull --ff-only origin "$BRANCH"

NEW_HEAD="$(git rev-parse HEAD)"

if [[ ! -d node_modules ]] || ! git diff --quiet "$OLD_HEAD" "$NEW_HEAD" -- package.json package-lock.json npm-shrinkwrap.json; then
  echo "Dependencies changed or node_modules missing; running npm ci."
  npm ci
else
  echo "Dependencies unchanged; skipping npm ci."
fi

npm run build
pm2 restart playtop-web playtop-worker
pm2 status --no-color
