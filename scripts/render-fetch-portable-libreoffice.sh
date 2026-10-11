#!/usr/bin/env bash
# Portable LibreOffice for Render native Node (no apt-get).
# Extracts official TDF Linux x86-64 .deb packages via dpkg -x into .libreoffice/root
set -euo pipefail

LO_VERSION="25.8.7"
# TDF .deb filenames use a short series (e.g. libobasis25.8-core), not the full patch version.
LO_DEB_SERIES="25.8"
LO_TARBALL="LibreOffice_${LO_VERSION}_Linux_x86-64_deb.tar.gz"
LO_BASE_URL="https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/deb/x86_64"
LO_DOWNLOAD_URL="${LO_BASE_URL}/${LO_TARBALL}"

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_ROOT="${PROJECT_ROOT}/.libreoffice"
CACHE_DIR="${INSTALL_ROOT}/cache"
EXTRACT_ROOT="${INSTALL_ROOT}/root"
TARBALL_PATH="${CACHE_DIR}/${LO_TARBALL}"

log() {
  printf 'render-fetch-portable-libreoffice: %s\n' "$*"
}

fail() {
  printf 'render-fetch-portable-libreoffice: ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command not found: $1"
  fi
}

require_cmd wget
require_cmd tar
require_cmd dpkg
require_cmd find
require_cmd head

mkdir -p "${CACHE_DIR}" "${EXTRACT_ROOT}"

if [[ ! -f "${TARBALL_PATH}" ]]; then
  log "Downloading ${LO_DOWNLOAD_URL}"
  wget -q -O "${TARBALL_PATH}" "${LO_DOWNLOAD_URL}"
else
  log "Using cached tarball ${TARBALL_PATH}"
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

log "Extracting tarball..."
tar -xzf "${TARBALL_PATH}" -C "${WORK_DIR}"
DEBS_DIR="$(find "${WORK_DIR}" -type d -name DEBS | head -1)"
if [[ -z "${DEBS_DIR}" || ! -d "${DEBS_DIR}" ]]; then
  fail "DEBS directory not found inside ${LO_TARBALL}"
fi

log "Installing selected .deb payloads into ${EXTRACT_ROOT} (dpkg -x, no apt)..."
rm -rf "${EXTRACT_ROOT:?}"/*
INSTALLED_COUNT=0
for pattern in \
  "libobasis${LO_DEB_SERIES}-core" \
  "libobasis${LO_DEB_SERIES}-base" \
  "libobasis${LO_DEB_SERIES}-writer" \
  "libobasis${LO_DEB_SERIES}-en-us" \
  "libreoffice${LO_DEB_SERIES}-ure" \
  "libreoffice${LO_DEB_SERIES}_" \
  "libobasis${LO_DEB_SERIES}-ooofonts" \
  "libobasis${LO_DEB_SERIES}-images" \
  "libobasis${LO_DEB_SERIES}-xsltfilter" \
  "libobasis${LO_DEB_SERIES}-ooolinguistic"; do
  for deb in "${DEBS_DIR}"/${pattern}*.deb; do
    if [[ -f "${deb}" ]]; then
      dpkg -x "${deb}" "${EXTRACT_ROOT}"
      INSTALLED_COUNT=$((INSTALLED_COUNT + 1))
      log "  extracted $(basename "${deb}")"
    fi
  done
done

if [[ "${INSTALLED_COUNT}" -lt 1 ]]; then
  fail "No LibreOffice .deb packages were extracted (LO_VERSION=${LO_VERSION}, LO_DEB_SERIES=${LO_DEB_SERIES})."
fi

SOFFICE="$(find "${EXTRACT_ROOT}" -type f -path '*/program/soffice' | head -1)"
SOFFICE_BIN="$(find "${EXTRACT_ROOT}" -type f -path '*/program/soffice.bin' | head -1)"

if [[ -z "${SOFFICE}" || ! -f "${SOFFICE}" ]]; then
  fail "soffice launcher not found under ${EXTRACT_ROOT}"
fi

if [[ -z "${SOFFICE_BIN}" || ! -f "${SOFFICE_BIN}" ]]; then
  fail "soffice.bin not found under ${EXTRACT_ROOT}"
fi

if [[ ! -x "${SOFFICE}" ]]; then
  chmod +x "${SOFFICE}" || true
fi

PROGRAM_DIR="$(dirname "${SOFFICE_BIN}")"
export LD_LIBRARY_PATH="${PROGRAM_DIR}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"

log "Checking dynamic libraries for ${SOFFICE_BIN}..."
LDD_OUTPUT="$(ldd "${SOFFICE_BIN}" 2>&1)" || fail "ldd failed on ${SOFFICE_BIN}"
if printf '%s\n' "${LDD_OUTPUT}" | grep -q 'not found'; then
  printf '%s\n' "${LDD_OUTPUT}" | grep 'not found' >&2 || true
  fail "Missing shared libraries for soffice.bin"
fi

LO_USER_INSTALL="file:///tmp/optalynx-lo-portable-verify"
if ! VERSION_OUTPUT="$(
  cd "${PROGRAM_DIR}" &&
    "${SOFFICE}" --headless "-env:UserInstallation=${LO_USER_INSTALL}" --version 2>&1
)"; then
  fail "soffice --version failed"
fi

VERSION_LINE="$(printf '%s\n' "${VERSION_OUTPUT}" | head -n 1)"
if [[ -z "${VERSION_LINE// }" ]]; then
  fail "Empty version output from soffice"
fi

PREFIX_SIZE="$(du -sh "${EXTRACT_ROOT}" | cut -f1)"
log "Verified soffice: ${SOFFICE}"
log "Verified soffice.bin: ${SOFFICE_BIN}"
log "Install size: ${PREFIX_SIZE}"
log "Version: ${VERSION_LINE}"
log "Done (runtime discovery uses .libreoffice/root/opt/libreoffice*/program/soffice)."
