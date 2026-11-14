#!/usr/bin/env bash
# Standalone session resume for Linux/macOS. Installs and configures nothing:
# run start.sh once first.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
case "$(uname -s)" in Darwin) PLATFORM=darwin;; Linux) PLATFORM=linux;; *) echo "Unsupported operating system"; exit 1;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64;; x86_64|amd64) ARCH=x64;; *) echo "Unsupported CPU architecture"; exit 1;; esac
NODE_BIN="$PROJECT_ROOT/engine/node-$PLATFORM-$ARCH/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  echo "[ERROR] Portable Node.js was not found: $NODE_BIN"
  echo "[ERROR] Run start.sh once to install the portable runtime, then try again."
  exit 1
fi
exec "$NODE_BIN" "$PROJECT_ROOT/tools/resume.mjs" "$@"
