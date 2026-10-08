#!/usr/bin/env bash
# Setup script for the Claude Code cloud environment (runs as root on a fresh VM; must exit 0).
# Paste into the environment's "Setup script" field:   bash scripts/cloud-setup.sh
# Anything that fails here is only warned about; scripts/cloud-preflight.mjs reports the real state at session start.
set -u
cd "$(dirname "$0")/.." || exit 0
npm ci --no-audit --no-fund || npm install --no-audit --no-fund || echo "WARN: npm install failed"
# LibreOffice converts the client PowerPoint to PDF; without it the deck is delivered as PPTX only.
(apt-get install -y --no-install-recommends libreoffice-impress fonts-liberation >/dev/null 2>&1 || echo "WARN: LibreOffice not installed; client deck PDF will be skipped") 
node scripts/ensure-browser.mjs || echo "WARN: no browser available yet; see docs/LIMITATIONS.md"
exit 0
