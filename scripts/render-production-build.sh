#!/usr/bin/env bash
# Production Render build for optalynx-api (native Node, no apt-get).
# Installs portable LibreOffice into .libreoffice/ then Node dependencies.
# Apply on Render only after spike validation; keep Start Command: npm start
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${PROJECT_ROOT}"

bash scripts/render-fetch-portable-libreoffice.sh
npm install
