#!/bin/bash
# nproxy-run.sh — Run any command through nproxy
#
# Usage:
#   ./nproxy-run.sh [options] <command> [args...]
#   ./nproxy-run.sh passthrough -- /usr/bin/someapp --flag
#   ./nproxy-run.sh --pty myapp              # PTY mode for interactive CLIs
#   ./nproxy-run.sh passthrough --pty -- myapp
#
# Without a text-mode argument, defaults to NPROXY_TEXT=passthrough.
# If the first argument matches a known mode (passthrough|strip-ansi|transform),
# it is consumed as --text=. Otherwise passthrough is assumed.
#
# Environment:
#   NPROXY_TEXT    text mode override (takes precedence over positional arg)

MODE="passthrough"
PTY=""
COMMAND_ARGS=()

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 [passthrough|strip-ansi|transform] [--pty] -- <command> [args...]" >&2
  exit 1
fi

case "$1" in
  passthrough|strip-ansi|transform)
    MODE="$1"
    shift
    ;;
esac

# Handle --pty flag
if [ "$1" = "--pty" ]; then
  PTY="--pty"
  shift
fi

# Handle -- separator
if [ "$1" = "--" ]; then
  shift
fi

COMMAND_ARGS=("$@")

if [ "${#COMMAND_ARGS[@]}" -eq 0 ]; then
  echo "nproxy-run.sh: no command specified" >&2
  exit 1
fi

cd "$(dirname "$0")" && SCRIPT_DIR="$(pwd -P)"
NODE_BIN="$(command -v node)"
# Auto-set max-old-space-size to 75% of total RAM (overridable via NODE_OPT_MAX_OLD env var)
NODE_OPT_MAX_OLD="${NODE_OPT_MAX_OLD:-$("$NODE_BIN" -e "console.log(Math.floor(require('os').totalmem() / 1024 / 1024 * 0.75))" 2>/dev/null)}"
: "${NODE_OPT_MAX_OLD:=2048}"
# Ensure node-pty can be resolved from global modules
NPM_GLOBAL_ROOT="$("$NODE_BIN" -e "console.log(require('module').GlobalPaths || require('path').resolve(process.execPath, '../lib/node_modules'))" 2>/dev/null || echo /usr/local/lib/node_modules)"
export NODE_PATH="${NODE_PATH:-$NPM_GLOBAL_ROOT}"
exec "$NODE_BIN" --expose-gc "--max-old-space-size=${NODE_OPT_MAX_OLD}" "$SCRIPT_DIR/node/nproxy.js" "--text=$MODE" $PTY "${COMMAND_ARGS[@]}"
