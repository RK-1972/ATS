#!/usr/bin/env bash
# Installs minimal LibreOffice for DOCX→PDF on Render native Node (Debian 12 bookworm).
# Intended build usage (service root = ats-backend):
#   bash scripts/render-install-libreoffice.sh && npm ci
set -euo pipefail

log() {
  printf 'render-install-libreoffice: %s\n' "$*"
}

fail() {
  printf 'render-install-libreoffice: ERROR: %s\n' "$*" >&2
  exit 1
}

if ! command -v apt-get >/dev/null 2>&1; then
  fail "apt-get not found (expected Debian 12 on Render native Node)."
fi

export DEBIAN_FRONTEND=noninteractive

log "Updating apt package index..."
apt-get update -qq

# libreoffice-writer: DOCX/Writer filters for offer-letter template merge output.
# libreoffice-common: /usr/bin/soffice and /usr/bin/libreoffice (Debian bookworm).
PACKAGES=(
  libreoffice-writer
  libreoffice-common
)

log "Installing packages: ${PACKAGES[*]} ..."
apt-get install -y -qq --no-install-recommends "${PACKAGES[@]}"

discover_soffice_launcher() {
  local candidate

  for candidate in /usr/bin/soffice /usr/bin/libreoffice; do
    if [[ -f "$candidate" && -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  if command -v soffice >/dev/null 2>&1; then
    command -v soffice
    return 0
  fi

  if command -v libreoffice >/dev/null 2>&1; then
    command -v libreoffice
    return 0
  fi

  return 1
}

SOFFICE_LAUNCHER="$(discover_soffice_launcher || true)"

if [[ -z "${SOFFICE_LAUNCHER:-}" ]]; then
  fail "LibreOffice install finished but no soffice launcher was found (expected /usr/bin/soffice or /usr/bin/libreoffice on Debian bookworm)."
fi

if [[ ! -x /usr/lib/libreoffice/program/soffice.bin ]]; then
  fail "Missing core binary /usr/lib/libreoffice/program/soffice.bin after package install."
fi

LO_USER_INSTALL="file:///tmp/optalynx-lo-render-verify"
VERIFY_ARGS=(
  --headless
  "-env:UserInstallation=${LO_USER_INSTALL}"
  --version
)

if ! VERSION_OUTPUT="$("${SOFFICE_LAUNCHER}" "${VERIFY_ARGS[@]}" 2>&1)"; then
  fail "Verification failed: ${SOFFICE_LAUNCHER} ${VERIFY_ARGS[*]}"
fi

VERSION_LINE="$(printf '%s\n' "$VERSION_OUTPUT" | head -n 1)"

if [[ -z "${VERSION_LINE// }" ]]; then
  fail "Verification produced empty version output from ${SOFFICE_LAUNCHER}."
fi

log "Verified launcher: ${SOFFICE_LAUNCHER}"
log "Core binary present: /usr/lib/libreoffice/program/soffice.bin"
log "Version: ${VERSION_LINE}"
log "Done (application resolves soffice via PATH; LIBREOFFICE_PATH not required)."
