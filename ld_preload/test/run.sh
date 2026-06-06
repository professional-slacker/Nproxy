#!/usr/bin/env bash
# nproxy_ld.so tests — verify LD_PRELOAD execve hook
set -e

NPROXY_DIR="$(cd "$(dirname "$0")"/../.. && pwd)"
LD_SO="$NPROXY_DIR/ld_preload/nproxy_ld.so"
NPROXY_JS="$NPROXY_DIR/node/nproxy.js"
NODE_BIN="$(command -v node)"
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

# Run a node script under bash+LD_PRELOAD and check child output.
# Script must call process.exit(0) because nproxy's stdin listener
# (attached in preload mode) keeps the event loop alive on non-TTY stdin.
# Args: desc env_extra node_code expected_pattern
run_test() {
  local desc="$1" env_extra="$2" node_code="$3" expected="$4"
  local script=$(mktemp /tmp/nproxy_test_XXXX.js)
  local rf=$(mktemp)
  printf '%s\nprocess.exit(0);' "$node_code" > "$script"
  set +e
  env NPROXY_LD_TARGETS=node NPROXY_HEAP_MB=4096 $env_extra \
    LD_PRELOAD="$LD_SO" timeout 10 \
    bash -c '"$1" "$2"' _ "$NODE_BIN" "$script" > "$rf" 2>/dev/null
  local rc=$?
  set -e
  # Strip ANSI codes and nproxy banner lines from output
  local clean=$(sed 's/\x1b\[[0-9;]*m//g' "$rf" | grep -v '^\[nproxy\]' | grep -v '^╔' | grep -v '^║' | grep -v '^╚' | grep -v '^\s*$')
  if echo "$clean" | grep -q "$expected" 2>/dev/null; then
    PASS=$((PASS+1)); grn "  PASS: $desc"
  else
    FAIL=$((FAIL+1)); red "  FAIL: $desc"
    red "    rc=$rc"
    [ -n "$clean" ] && red "    output: $(echo "$clean" | head -3)"
  fi
  rm -f "$rf" "$script"
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

# NOTE: LD_PRELOAD execve hooks only intercept libc execve() calls.
# Node.js and Bun use posix_spawn/internal syscalls, bypassing libc execve.
# Tests must use bash/sh as parent (which does use libc execve).

# 4. libc execve (bash spawns node child): NPROXY_LD_ACTIVE injected
bold "[4] bash spawns node child (libc execve) → NPROXY_LD_ACTIVE injected"
run_test \
  "execve: NPROXY_LD_ACTIVE injected" \
  "" \
  'process.stdout.write(String(!!process.env.NPROXY_LD_ACTIVE))' \
  "true"

# 5. NODE_OPTIONS contains nproxy.js
bold "[5] bash spawns node child → NODE_OPTIONS contains nproxy.js"
run_test \
  "execve: NODE_OPTIONS has nproxy.js" \
  "" \
  'process.stdout.write(process.env.NODE_OPTIONS || "")' \
  "nproxy.js"

# 6. NPROXY_LD_ACTIVE guard prevents injection
bold "[6] NPROXY_LD_ACTIVE guard → no NODE_OPTIONS injection"
run_test \
  "guard: NODE_OPTIONS empty when NPROXY_LD_ACTIVE=1" \
  "NPROXY_LD_ACTIVE=1" \
  'process.stdout.write(process.env.NODE_OPTIONS || "(empty)")' \
  "(empty)"

# 7. execvp with bare "node" name (PATH resolution)
bold "[7] execvp with bare name → NPROXY_HEAP_MB respected"
T7_SCRIPT=$(mktemp /tmp/nproxy_test_XXXX.js)
T7_RF=$(mktemp)
printf '%s\nprocess.exit(0);' 'process.stdout.write(process.env.NPROXY_HEAP_MB || "no")' > "$T7_SCRIPT"
set +e
NPROXY_LD_TARGETS=node NPROXY_HEAP_MB=4096 \
  LD_PRELOAD="$LD_SO" timeout 10 \
  bash -c '"$1" "$2"' execvp-test node "$T7_SCRIPT" > "$T7_RF" 2>/dev/null
T7_RC=$?
set -e
T7_CLEAN=$(sed 's/\x1b\[[0-9;]*m//g' "$T7_RF" | grep -v '^\[nproxy\]' | grep -v '^╔' | grep -v '^║' | grep -v '^╚' | grep -v '^\s*$')
if echo "$T7_CLEAN" | grep -q '^4096$' 2>/dev/null; then
  PASS=$((PASS+1)); grn "  PASS: execvp with NPROXY_HEAP_MB=4096"
else
  FAIL=$((FAIL+1)); red "  FAIL: execvp"
  red "    rc=$T7_RC"
  [ -n "$T7_CLEAN" ] && red "    output: $(echo "$T7_CLEAN" | head -3)"
fi
rm -f "$T7_RF" "$T7_SCRIPT"

echo ""
bold "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ] || exit 1
