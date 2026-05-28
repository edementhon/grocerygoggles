#!/usr/bin/env bash
# Deploy Grocery Goggles to andromeda.
#
# What it does:
#   1. Bumps CACHE_VERSION in sw.js to a fresh timestamp so installed PWAs
#      pick up the new assets (otherwise the service worker serves stale files).
#   2. Commits + pushes to GitHub.
#   3. SSHes to andromeda, pulls, validates nginx, and reloads.
#
# One-time andromeda setup (see README) must be done first:
#   - git clone into $DEPLOY_DIR
#   - nginx server block + certbot TLS
set -euo pipefail

DEPLOY_DIR="/opt/grocerygoggles"
REMOTE="andromeda"

STAMP="gg-$(date +%Y%m%d-%H%M%S)"
echo "==> Bumping service worker cache to ${STAMP}"
sed -i.bak -E "s/const CACHE_VERSION = \"[^\"]*\"/const CACHE_VERSION = \"${STAMP}\"/" sw.js
rm -f sw.js.bak

if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -A
  git commit -m "deploy: ${STAMP}"
fi

echo "==> Pushing to GitHub"
git push origin main

echo "==> Deploying on ${REMOTE}"
ssh "${REMOTE}" "cd ${DEPLOY_DIR} && git pull --ff-only && sudo nginx -t && sudo systemctl reload nginx"

echo "==> Done: ${STAMP}"
