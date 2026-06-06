#!/usr/bin/env bash
# nproxy_ld.so tests — verify LD_PRELOAD execve hook
set -e

NPROXY_DIR="$(cd "$(dirname "$0")"/../.. && pwd)"
LD_SO="$NPROXY_DIR/ld_preload/nproxy_ld.so"
NPROXY_JS="$NPROXY_DIR/node/nproxy.js"
PASS=0
FAIL=0

red()  { echo -e "\e[31m$1\e[0m"; }
grn()  { echo -e "\e[32m$1\e[0m"; }
bold() { echo -e "\e[1m$1\e[0m"; }

check() {
  local desc="$1" rc="$2"
  if [ "$rc" -eq 0 ]; then
    grn "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    red "  FAIL: $desc"
    FAIL=$((FAIL + 1))
  fi
}

bold "=== nproxy_ld.so tests ==="
echo ""

# 1. Build .so
bold "[1] Build nproxy_ld.so"
make -C "$NPROXY_DIR/ld_preload" -s 2>/dev/null
check "build" $?

# 2. LD_PRELOAD must not break normal commands
bold "[2] Normal command under LD_PRELOAD"
LD_PRELOAD="$LD_SO" sh -c 'true'
check "sh -c true" $?

# 3. Non-target process must pass through (no wrap)
bold "[3] Non-target process (not in NPROXY_LD_TARGETS)"
NPROXY_LD_TARGETS=node LD_PRELOAD="$LD_SO" sh -c 'echo ok' | grep -q '^ok$'
check "echo ok via sh (not wrapped)" $?

# Find Node.js binary
NODE_BIN="$(command -v node)"
# Note: Bun's process.execPath returns Bun itself, not Node.
# Always use explicit NODE_BIN path for child spawn tests.

# 4. Node child via Bun spawn: must inject NODE_OPTIONS + nproxy
bold "[4] Bun spawns Node child → nproxy injected"
RESULT_FILE=$(mktemp)
NPROXY_LD_TARGETS=node LD_PRELOAD="$LD_SO" timeout 10 \
  bun -e '
    const {spawnSync} = require("child_process");
    const r = spawnSync("'"$NODE_BIN"'", ["-e", "process.stdout.write(String(!!process.env.NPROXY_LD_ACTIVE))"], {stdio: ["pipe", "pipe", "pipe"]});
    process.stdout.write((r.stdout||"").toString());
  ' > "$RESULT_FILE" 2>/dev/null || true
grep -q 'true' "$RESULT_FILE" 2>/dev/null && PASS=$((PASS+1)) && grn "  PASS: nproxy injected" || { red "  FAIL: nproxy injected"; FAIL=$((FAIL+1)); }
rm -f "$RESULT_FILE"

# 5. Node child has nproxy.js in NODE_OPTIONS
bold "[5] Node child has nproxy.js in NODE_OPTIONS"
RESULT_FILE=$(mktemp)
NPROXY_LD_TARGETS=node LD_PRELOAD="$LD_SO" timeout 10 \
  bun -e '
    const {spawnSync} = require("child_process");
    const r = spawnSync("'"$NODE_BIN"'", ["-e", "process.stdout.write(process.env.NODE_OPTIONS||\"\")"], {stdio: ["pipe", "pipe", "pipe"]});
    process.stdout.write((r.stdout||"").toString());
  ' > "$RESULT_FILE" 2>/dev/null || true
grep -q 'nproxy.js' "$RESULT_FILE" 2>/dev/null && PASS=$((PASS+1)) && grn "  PASS: NODE_OPTIONS contains nproxy.js" || { red "  FAIL: NODE_OPTIONS missing nproxy.js"; FAIL=$((FAIL+1)); }
rm -f "$RESULT_FILE"

# 6. No infinite recursion (NPROXY_LD_ACTIVE guard)
bold "[6] No infinite recursion (NPROXY_LD_ACTIVE guard)"
RESULT_FILE=$(mktemp)
NPROXY_LD_TARGETS=node LD_PRELOAD="$LD_SO" timeout 10 \
  bun -e '
    const {spawnSync} = require("child_process");
    const r = spawnSync("'"$NODE_BIN"'", ["-e", "process.stdout.write(process.env.NPROXY_LD_ACTIVE === \"1\" ? \"1\" : \"0\")"], {stdio: ["pipe", "pipe", "pipe"]});
    process.stdout.write((r.stdout||"").toString());
  ' > "$RESULT_FILE" 2>/dev/null || true
grep -q '^1$' "$RESULT_FILE" 2>/dev/null && PASS=$((PASS+1)) && grn "  PASS: NPROXY_LD_ACTIVE=1" || { red "  FAIL: NPROXY_LD_ACTIVE not 1"; FAIL=$((FAIL+1)); }
rm -f "$RESULT_FILE"

echo ""
bold "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ] || exit 1
