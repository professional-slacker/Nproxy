#!/bin/bash
# nproxy-run.sh — Run OpenClaude through nproxy
#
# Usage:
#   ./nproxy-run.sh                    # passthrough
#   ./nproxy-run.sh strip-ansi         # strip ANSI
#   ./nproxy-run.sh transform          # strip ANSI + NFC normalize
#
# Without arguments, passes through unmodified to test baseline behavior.

cd "$(dirname "$0")"
MODE="${1:-passthrough}"
exec node node/nproxy.js "--text=$MODE" /usr/bin/openclaude
