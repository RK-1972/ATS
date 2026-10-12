#!/usr/bin/env bash
# Deprecated: apt-get install is not supported on Render native Node builds (read-only /var/lib/apt).
set -euo pipefail

printf 'render-install-libreoffice: ERROR: apt-based install was removed.\n' >&2
printf 'Use scripts/render-fetch-portable-libreoffice.sh or scripts/render-spike-build.sh instead.\n' >&2
exit 1
