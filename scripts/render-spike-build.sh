#!/usr/bin/env bash
# Spike / CI build: portable LibreOffice + npm ci + PDF verification.
# Production optalynx-api should keep "npm install" until spike validates on Render.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${PROJECT_ROOT}"

bash scripts/render-fetch-portable-libreoffice.sh
npm ci
node scripts/verifyPdfGenerationServiceResolution.js
