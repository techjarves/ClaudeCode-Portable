#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE_VERSION="22.23.2"
case "$(uname -s)" in Darwin) PLATFORM=darwin;; Linux) PLATFORM=linux;; *) echo "Unsupported operating system"; exit 1;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64;; x86_64|amd64) ARCH=x64;; *) echo "Unsupported CPU architecture"; exit 1;; esac
NODE_DIR="$PROJECT_ROOT/engine/node-$PLATFORM-$ARCH"
NODE_BIN="$NODE_DIR/bin/node"
if [ ! -x "$NODE_BIN" ] || [ "$("$NODE_BIN" --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  mkdir -p "$PROJECT_ROOT/engine"
  ARCHIVE_NAME="node-v$NODE_VERSION-$PLATFORM-$ARCH.tar.gz"
  ARCHIVE="$PROJECT_ROOT/engine/$ARCHIVE_NAME"
  BASE="https://nodejs.org/dist/v$NODE_VERSION"
  echo "Downloading portable Node.js from nodejs.org…"
  curl --fail --location --retry 2 "$BASE/$ARCHIVE_NAME" -o "$ARCHIVE"
  EXPECTED="$(curl --fail --location "$BASE/SHASUMS256.txt" | awk -v file="$ARCHIVE_NAME" '$2 == file {print $1}')"
  if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$ARCHIVE" | awk '{print $1}')"; else ACTUAL="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"; fi
  if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then echo "Node.js checksum verification failed"; exit 1; fi
  STAGING="$(mktemp -d "$PROJECT_ROOT/engine/node-extract.XXXXXX")"
  trap 'rm -rf "$STAGING"' EXIT
  if ln -s portable-symlink-test "$STAGING/.portable-symlink-test" 2>/dev/null; then
    rm "$STAGING/.portable-symlink-test"
    tar -xzf "$ARCHIVE" -C "$STAGING" --strip-components=1
  else
    echo "This drive does not support symbolic links; using the NTFS-compatible Node.js layout…"
    tar -xzf "$ARCHIVE" -C "$STAGING" --strip-components=1 \
      --exclude='*/bin/npm' --exclude='*/bin/npx' --exclude='*/bin/corepack'
  fi
  "$STAGING/bin/node" --version
  if [ -d "$NODE_DIR" ]; then mv "$NODE_DIR" "$NODE_DIR.incomplete.$(date +%s)"; fi
  mv "$STAGING" "$NODE_DIR"
  rm "$ARCHIVE"
  trap - EXIT
fi
export PATH="$NODE_DIR/bin:$PATH"
exec "$NODE_BIN" "$PROJECT_ROOT/tools/launcher.mjs" "$@"
