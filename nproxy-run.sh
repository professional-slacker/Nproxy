#!/bin/bash
# nproxy-run.sh — Run OpenClaude through nproxy
#
# Usage:
#   ./nproxy-run.sh                    # passthrough
#   ./nproxy-run.sh strip-ansi         # strip ANSI
#   ./nproxy-run.sh transform          # strip ANSI + NFC normalize
#
# Without arguments, passes through unmodified to test baseline behavior.

cd "$(dirname "$0")" && SCRIPT_DIR="$(pwd -P)"
MODE="${1:-passthrough}"
NODE_BIN="$(command -v node)"
# Resolve OpenClaude binary: follow PATH, common locations
OC_BIN=""
for p in $(command -v openclaude 2>/dev/null) /usr/bin/openclaude /usr/local/bin/openclaude; do
  if [ -x "$p" ]; then OC_BIN="$p"; break; fi
done
if [ -z "$OC_BIN" ]; then
  echo "nproxy-run.sh: openclaude not found in PATH or standard locations" >&2
  exit 1
fi
exec "$NODE_BIN" "$SCRIPT_DIR/node/nproxy.js" "--text=$MODE" "$OC_BIN"
