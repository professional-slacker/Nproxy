#!/bin/bash
# nproxy-run.sh — Run any command through nproxy
#
# Usage:
#   ./nproxy-run.sh [options] <command> [args...]        # spawn mode (default)
#   ./nproxy-run.sh --preload <command> [args...]        # NODE_OPTIONS preload mode
#
# Spawn mode: nproxy runs the command as a child process, relays I/O.
# Preload mode: nproxy hooks into the command's own process via NODE_OPTIONS.
#   Use preload for Node.js apps (especially ESM apps or when --resume is needed).
#
# Text mode (spawn mode only):
#   ./nproxy-run.sh [passthrough|strip-ansi|transform] -- <command> [args...]
#
# Environment:
#   NPROXY_TEXT              text mode override (takes precedence over positional arg)
#   NPROXY_EMERGENCY_MB      override memory emergency threshold
#   NODE_OPT_MAX_OLD         override V8 heap limit

MODE="passthrough"
COMMAND_ARGS=()
PRELOAD=0

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 [--preload] [passthrough|strip-ansi|transform] -- <command> [args...]" >&2
  exit 1
fi

case "$1" in
  --preload)
    PRELOAD=1
    shift
    ;;
esac

case "$1" in
  passthrough|strip-ansi|transform)
    MODE="$1"
    shift
    ;;
esac

# Handle -- separator
if [ "$1" = "--" ]; then
  shift
fi

COMMAND_ARGS=("$@")

if [ "${#COMMAND_ARGS[@]}" -eq 0 ]; then
  echo "nproxy-run.sh: no command specified" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
NODE_BIN="$(command -v node)"

# Dynamic memory thresholds (both modes)
HEAP_LIMIT_MB="${NODE_OPT_MAX_OLD:-$("$NODE_BIN" -e "console.log(require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024 | 0)" 2>/dev/null)}"
: "${HEAP_LIMIT_MB:=2048}"
export NPROXY_EMERGENCY_MB="${NPROXY_EMERGENCY_MB:-$((HEAP_LIMIT_MB * 80 / 100))}"

if [ "$PRELOAD" -eq 1 ]; then
  # Preload mode: nproxy hooks into the command's own process via NODE_OPTIONS
  NPROXY_SCRIPT="$SCRIPT_DIR/node/nproxy.js"
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--expose-gc --max-old-space-size=${HEAP_LIMIT_MB} -r ${NPROXY_SCRIPT}"
  exec "${COMMAND_ARGS[@]}"
else
  # Spawn mode: nproxy spawns the command as a child process
  exec "$NODE_BIN" --expose-gc "--max-old-space-size=${HEAP_LIMIT_MB}" "$SCRIPT_DIR/node/nproxy.js" "--text=$MODE" "${COMMAND_ARGS[@]}"
fi
