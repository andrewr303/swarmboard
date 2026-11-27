#!/bin/sh
# Swarmboard one-line installer & uninstaller.
# Requires ONLY Node.js >= 22.18 (no git, pnpm, or npm install needed).
#
# Quick install:
#   curl -fsSL https://raw.githubusercontent.com/andrewr303/swarmboard/main/install.sh | sh
#
# Options (pass via `sh -s -- <flags>` or direct `sh install.sh <flags>`):
#   --version <vX.Y.Z|latest>   Install a specific release tag (default: latest)
#   --dir <path>                App install dir (default: ~/.local/share/swarmboard/app)
#   --bin-dir <path>            Binary symlink dir (default: ~/.local/bin)
#   --home <path>               Override target HOME directory (useful for isolated installs)
#   --tarball <path>            Install from a local standalone .tar.gz archive (offline/CI)
#   --no-setup                  Extract and link binaries only; skip `swarmboard setup`
#   --dry-run                   Preview actions without modifying files
#   --uninstall                 Uninstall Swarmboard (preserves DB unless --purge-data)
#   --purge-data                With --uninstall, also delete ~/.local/state/swarmboard & config
#   -h, --help                  Show this help message
set -eu

REPO="${SWARMBOARD_REPO:-andrewr303/swarmboard}"
VERSION="${SWARMBOARD_VERSION:-latest}"
HOME_DIR="${HOME:-}"
INSTALL_DIR="${SWARMBOARD_INSTALL_DIR:-}"
BIN_DIR="${SWARMBOARD_BIN_DIR:-}"
TARBALL_PATH=""
RUN_SETUP=1
DRY_RUN=0
DO_UNINSTALL=0
PURGE_DATA=0

usage() {
  cat <<'EOF'
Swarmboard Installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/andrewr303/swarmboard/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/andrewr303/swarmboard/main/install.sh | sh -s -- [options]

Options:
  --version <vX.Y.Z|latest>   Release tag to install (default: latest)
  --dir <path>                App install dir (default: $HOME/.local/share/swarmboard/app)
  --bin-dir <path>            Binary symlink dir (default: $HOME/.local/bin)
  --home <path>               Override HOME directory
  --tarball <path>            Install from a local swarmboard-v*.tar.gz file
  --no-setup                  Skip `swarmboard setup` (only install binaries)
  --dry-run                   Preview without writing changes
  --uninstall                 Uninstall Swarmboard (preserves DB by default)
  --purge-data                With --uninstall, also remove board database and config
  -h, --help                  Show this help
EOF
}

log() {
  printf '%s\n' "[swarmboard] $*"
}

die() {
  printf '%s\n' "[swarmboard] error: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#--version=}"
      shift
      ;;
    --dir)
      [ "$#" -ge 2 ] || die "--dir requires a path"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --dir=*)
      INSTALL_DIR="${1#--dir=}"
      shift
      ;;
    --bin-dir)
      [ "$#" -ge 2 ] || die "--bin-dir requires a path"
      BIN_DIR="$2"
      shift 2
      ;;
    --bin-dir=*)
      BIN_DIR="${1#--bin-dir=}"
      shift
      ;;
    --home)
      [ "$#" -ge 2 ] || die "--home requires a path"
      HOME_DIR="$2"
      shift 2
      ;;
    --home=*)
      HOME_DIR="${1#--home=}"
      shift
      ;;
    --tarball)
      [ "$#" -ge 2 ] || die "--tarball requires a path"
      TARBALL_PATH="$2"
      shift 2
      ;;
    --tarball=*)
      TARBALL_PATH="${1#--tarball=}"
      shift
      ;;
    --no-setup)
      RUN_SETUP=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --uninstall)
      DO_UNINSTALL=1
      shift
      ;;
    --purge-data)
      PURGE_DATA=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1 (run with --help for usage)"
      ;;
  esac
done

[ -n "$HOME_DIR" ] || die "HOME is not set; pass --home <dir>"
[ -n "$INSTALL_DIR" ] || INSTALL_DIR="${HOME_DIR}/.local/share/swarmboard/app"
[ -n "$BIN_DIR" ] || BIN_DIR="${HOME_DIR}/.local/bin"

check_node() {
  command -v node >/dev/null 2>&1 || die "Node.js >= 22.18 is required (install from https://nodejs.org)"
  NODE_VER="$(node -p 'process.versions.node')"
  node -e '
    const [maj, min] = process.versions.node.split(".").map(Number);
    if (maj < 22 || (maj === 22 && min < 18)) process.exit(1);
  ' || die "Node.js >= 22.18 is required (found v${NODE_VER})"
  node -e 'import("node:sqlite").then(() => process.exit(0), () => process.exit(1))' \
    || die "Node.js built-in node:sqlite module is unavailable in v${NODE_VER}"
}

download_file() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    die "either curl or wget is required to download release artifacts"
  fi
}

resolve_latest_tag() {
  latest_url="https://github.com/${REPO}/releases/latest"
  if command -v curl >/dev/null 2>&1; then
    final_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$latest_url" 2>/dev/null || true)"
    case "$final_url" in
      */releases/tag/*)
        printf '%s' "${final_url##*/releases/tag/}"
        return 0
        ;;
    esac
    api_json="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)"
  elif command -v wget >/dev/null 2>&1; then
    api_json="$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)"
  else
    die "either curl or wget is required to resolve latest release"
  fi
  tag="$(printf '%s' "$api_json" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(s);
        if (typeof j.tag_name === "string") process.stdout.write(j.tag_name);
      } catch {}
    });
  ')"
  [ -n "$tag" ] || die "could not resolve latest release tag from https://github.com/${REPO}/releases"
  printf '%s' "$tag"
}

compute_sha256() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    node -e '
      const fs = require("node:fs");
      const crypto = require("node:crypto");
      const h = crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex");
      process.stdout.write(h);
    ' "$file"
  fi
}

# Handle --uninstall mode
if [ "$DO_UNINSTALL" -eq 1 ]; then
  check_node
  CLI_CANDIDATE=""
  if [ -x "${INSTALL_DIR}/dist/bin/swarmboard.mjs" ]; then
    CLI_CANDIDATE="${INSTALL_DIR}/dist/bin/swarmboard.mjs"
  elif [ -x "${BIN_DIR}/swarmboard" ]; then
    CLI_CANDIDATE="${BIN_DIR}/swarmboard"
  elif command -v swarmboard >/dev/null 2>&1; then
    CLI_CANDIDATE="$(command -v swarmboard)"
  fi

  if [ -n "$CLI_CANDIDATE" ]; then
    set -- uninstall --home "$HOME_DIR" --bin-dir "$BIN_DIR" --app-dir "$INSTALL_DIR"
    [ "$DRY_RUN" -eq 1 ] && set -- "$@" --dry-run
    [ "$PURGE_DATA" -eq 1 ] && set -- "$@" --purge-data
    HOME="$HOME_DIR" node "$CLI_CANDIDATE" "$@"
    exit 0
  fi

  log "Swarmboard CLI not found; cleaning up local symlinks and app directory directly"
  for name in swarmboard swarmboard-mcp swarmboard-daemon; do
    if [ -L "${BIN_DIR}/${name}" ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        log "[dry-run] would remove ${BIN_DIR}/${name}"
      else
        rm -f "${BIN_DIR}/${name}"
      fi
    fi
  done
  if [ -d "$INSTALL_DIR" ] && [ ! -d "${INSTALL_DIR}/.git" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      log "[dry-run] would remove ${INSTALL_DIR}"
    else
      rm -rf "$INSTALL_DIR"
    fi
  fi
  if [ "$PURGE_DATA" -eq 1 ]; then
    for d in "${HOME_DIR}/.local/state/swarmboard" "${HOME_DIR}/.config/swarmboard" "${HOME_DIR}/.swarmboard"; do
      if [ -e "$d" ]; then
        if [ "$DRY_RUN" -eq 1 ]; then
          log "[dry-run] would remove ${d}"
        else
          rm -rf "$d"
        fi
      fi
    done
  fi
  log "Uninstall complete."
  exit 0
fi

# Install flow
check_node
command -v tar >/dev/null 2>&1 || die "tar is required to extract Swarmboard"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/swarmboard-install.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

if [ -n "$TARBALL_PATH" ]; then
  [ -f "$TARBALL_PATH" ] || die "tarball not found: ${TARBALL_PATH}"
  ARCHIVE_FILE="$TARBALL_PATH"
  log "Using local standalone archive: ${ARCHIVE_FILE}"
else
  if [ "$VERSION" = "latest" ]; then
    TAG="$(resolve_latest_tag)"
  else
    case "$VERSION" in
      v*) TAG="$VERSION" ;;
      *) TAG="v${VERSION}" ;;
    esac
  fi

  ARCHIVE_NAME="swarmboard-${TAG}.tar.gz"
  BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
  ARCHIVE_FILE="${TMP_DIR}/${ARCHIVE_NAME}"
  SUMS_FILE="${TMP_DIR}/SHA256SUMS.txt"

  log "Downloading Swarmboard ${TAG} from ${REPO}..."
  download_file "${BASE_URL}/${ARCHIVE_NAME}" "$ARCHIVE_FILE"
  download_file "${BASE_URL}/SHA256SUMS.txt" "$SUMS_FILE"

  EXPECTED_SHA="$(awk -v f="$ARCHIVE_NAME" '$2 == f {print $1; exit}' "$SUMS_FILE")"
  [ -n "$EXPECTED_SHA" ] || die "checksum entry for ${ARCHIVE_NAME} not found in SHA256SUMS.txt"
  ACTUAL_SHA="$(compute_sha256 "$ARCHIVE_FILE")"
  [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || die "SHA-256 mismatch for ${ARCHIVE_NAME} (expected ${EXPECTED_SHA}, got ${ACTUAL_SHA})"
  log "Verified SHA-256 checksum (${ACTUAL_SHA})"
fi

EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$ARCHIVE_FILE" -C "$EXTRACT_DIR"

EXTRACTED_ROOT=""
for candidate in "${EXTRACT_DIR}"/*; do
  if [ -d "$candidate" ] && [ -f "${candidate}/package.json" ] && [ -f "${candidate}/dist/bin/swarmboard.mjs" ]; then
    EXTRACTED_ROOT="$candidate"
    break
  fi
done
[ -n "$EXTRACTED_ROOT" ] || die "extracted archive does not contain a valid Swarmboard standalone layout"

if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] would install standalone app into ${INSTALL_DIR}"
  log "[dry-run] would link binaries into ${BIN_DIR}"
  if [ "$RUN_SETUP" -eq 1 ]; then
    HOME="$HOME_DIR" node "${EXTRACTED_ROOT}/dist/bin/swarmboard.mjs" setup --dry-run --home "$HOME_DIR" --bin-dir "$BIN_DIR"
  fi
  exit 0
fi

chmod 755 \
  "${EXTRACTED_ROOT}/dist/bin/swarmboard.mjs" \
  "${EXTRACTED_ROOT}/dist/bin/swarmboard-mcp.mjs" \
  "${EXTRACTED_ROOT}/dist/bin/swarmboard-daemon.mjs"

# Atomic directory swap into INSTALL_DIR
INSTALL_PARENT="$(dirname "$INSTALL_DIR")"
mkdir -p "$INSTALL_PARENT"
STAGE_TARGET="${INSTALL_DIR}.new.$$"
OLD_BACKUP="${INSTALL_DIR}.old.$$"
rm -rf "$STAGE_TARGET" "$OLD_BACKUP"
cp -R "$EXTRACTED_ROOT" "$STAGE_TARGET"

if [ -e "$INSTALL_DIR" ]; then
  mv "$INSTALL_DIR" "$OLD_BACKUP"
fi
if mv "$STAGE_TARGET" "$INSTALL_DIR"; then
  rm -rf "$OLD_BACKUP"
else
  if [ -e "$OLD_BACKUP" ] && [ ! -e "$INSTALL_DIR" ]; then
    mv "$OLD_BACKUP" "$INSTALL_DIR" || true
  fi
  die "failed to move staged app into ${INSTALL_DIR}"
fi

# Symlink binaries into BIN_DIR
mkdir -p "$BIN_DIR"
for name in swarmboard swarmboard-mcp swarmboard-daemon; do
  ln -sf "${INSTALL_DIR}/dist/bin/${name}.mjs" "${BIN_DIR}/${name}"
done

log "Installed Swarmboard app to ${INSTALL_DIR}"

if [ "$RUN_SETUP" -eq 1 ]; then
  HOME="$HOME_DIR" "${BIN_DIR}/swarmboard" setup --home "$HOME_DIR" --bin-dir "$BIN_DIR"
else
  log "Skipped setup (--no-setup). Run \`${BIN_DIR}/swarmboard setup\` later to configure harnesses and the global board."
fi

case ":${PATH:-}:" in
  *":${BIN_DIR}:"*)
    ;;
  *)
    log "Add ${BIN_DIR} to your PATH to run \`swarmboard\` from anywhere:"
    printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
    ;;
esac

log "Next steps:"
log "  swarmboard doctor   # verify board health"
log "  swarmboard open     # launch Command Center UI (http://127.0.0.1:4180)"
