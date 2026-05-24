#!/bin/bash
# nproxy-run.sh — Run any command through nproxy
#
# Usage:
#   ./nproxy-run.sh [options] <command> [args...]
#   ./nproxy-run.sh passthrough -- /usr/bin/someapp --flag
#
# Without a text-mode argument, defaults to NPROXY_TEXT=passthrough.
# If the first argument matches a known mode (passthrough|strip-ansi|transform),
# it is consumed as --text=. Otherwise passthrough is assumed.
#
# Environment:
#   NPROXY_TEXT    text mode override (takes precedence over positional arg)

MODE="passthrough"
COMMAND_ARGS=()

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 [passthrough|strip-ansi|transform] -- <command> [args...]" >&2
  exit 1
fi

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

cd "$(dirname "$0")" && SCRIPT_DIR="$(pwd -P)"
NODE_BIN="$(command -v node)"
# --max-old-space-size / NPROXY_EMERGENCY_MB を自動設定（環境変数で上書き可能）
# ヒープ上限（デフォルト: Node実行時に動的取得、フォールバック2048MB）
NODE_OPT_MAX_OLD="${NODE_OPT_MAX_OLD:-$("$NODE_BIN" -e "console.log(require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024 | 0)" 2>/dev/null)}"
: "${NODE_OPT_MAX_OLD:=2048}"
# emergency閾値（デフォルト: ヒープ上限の80%、環境変数で任意値に上書き可能）
export NPROXY_EMERGENCY_MB="${NPROXY_EMERGENCY_MB:-$((NODE_OPT_MAX_OLD * 80 / 100))}"
exec "$NODE_BIN" --expose-gc "--max-old-space-size=${NODE_OPT_MAX_OLD}" "$SCRIPT_DIR/node/nproxy.js" "--text=$MODE" "${COMMAND_ARGS[@]}"
