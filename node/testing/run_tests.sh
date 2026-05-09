#!/usr/bin/env bash
# nproxy Rust MVP smoke tests
set -uo pipefail
NPROXY="${CARGO_TARGET_DIR:-/home/mmixx/workfolder/Nproxy/rs/target/debug}/nproxy"
TEST_APPS="/home/mmixx/workfolder/Nproxy/test_apps"
PASS=0
FAIL=0

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }

echo "=== nproxy Rust MVP smoke tests ==="
echo ""

# 1. Basic passthrough
echo "--- Test 1: basic passthrough ---"
output=$(echo "hello rust" | timeout 5 "$NPROXY" cat 2>/dev/null) || true
if [[ "$output" == "hello rust" ]]; then
    green "  PASS: stdin->stdout passthrough"
    ((PASS++))
else
    red "  FAIL: stdin->stdout passthrough (got: '$output')"
    ((FAIL++))
fi

# 2. stderr contains startup message
echo "--- Test 2: stderr startup message ---"
stderr_out=$(echo "x" | timeout 5 "$NPROXY" cat 2>&1 1>/dev/null) || true
if [[ "$stderr_out" == *"nproxy:"* ]]; then
    green "  PASS: stderr startup message"
    ((PASS++))
else
    red "  FAIL: stderr startup message missing (got: '$stderr_out')"
    ((FAIL++))
fi

# 3. Node echo app
echo "--- Test 3: node echo app ---"
output=$(echo "hello from node" | timeout 10 "$NPROXY" node "$TEST_APPS/app_echo.js" 2>/dev/null) || true
if [[ "$output" == "hello from node" ]]; then
    green "  PASS: node app_echo passthrough"
    ((PASS++))
else
    red "  FAIL: node app_echo passthrough (got: '$output')"
    ((FAIL++))
fi

# 4. Node stderr mix
echo "--- Test 4: stderr mix ---"
if timeout 10 "$NPROXY" node "$TEST_APPS/app_stderr_mix.js" 5 2>/dev/null 1>/dev/null; then
    green "  PASS: stderr mix"
    ((PASS++))
else
    red "  FAIL: stderr mix exit code"
    ((FAIL++))
fi

# 5. Large stdout (5MB)
echo "--- Test 5: big stdout (5MB) ---"
output_size=$(timeout 15 "$NPROXY" node "$TEST_APPS/app_big_stdout.js" 5 2>/dev/null | wc -c) || true
if [[ "$output_size" -ge 5200000 ]]; then
    green "  PASS: big stdout 5MB (got ${output_size} bytes)"
    ((PASS++))
else
    red "  FAIL: big stdout 5MB (got ${output_size} bytes)"
    ((FAIL++))
fi

# 6. --text=off explicit
echo "--- Test 6: --text=off ---"
output=$(echo "text off" | timeout 5 "$NPROXY" --text=off cat 2>/dev/null) || true
if [[ "$output" == "text off" ]]; then
    green "  PASS: --text=off mode"
    ((PASS++))
else
    red "  FAIL: --text=off mode (got: '$output')"
    ((FAIL++))
fi

# 7. Invalid --text mode fails
echo "--- Test 7: invalid --text ---"
rc=0
echo "data" | timeout 5 "$NPROXY" --text=invalid cat 2>/dev/null 1>/dev/null || rc=$?
if [[ "$rc" -ne 0 ]]; then
    green "  PASS: invalid --text exits non-zero"
    ((PASS++))
else
    red "  FAIL: invalid --text does not exit"
    ((FAIL++))
fi

# 8. NPROXY_DEBUG tracing
echo "--- Test 8: NPROXY_DEBUG ---"
debug_out=$(NPROXY_DEBUG=1 echo "debug" | timeout 5 "$NPROXY" cat 2>&1 1>/dev/null) || true
if [[ "$debug_out" == *"nproxy:"* ]]; then
    green "  PASS: NPROXY_DEBUG tracing"
    ((PASS++))
else
    red "  FAIL: NPROXY_DEBUG tracing (got: '$debug_out')"
    ((FAIL++))
fi

# 9. Non-existent command fails
echo "--- Test 9: non-existent command ---"
rc=0
echo "data" | timeout 5 "$NPROXY" nonexistent_cmd_xyz 2>&1 1>/dev/null || rc=$?
if [[ "$rc" -ne 0 ]]; then
    green "  PASS: non-existent command exits non-zero"
    ((PASS++))
else
    red "  FAIL: non-existent command exits non-zero"
    ((FAIL++))
fi

# 10. Large passthrough: 10GB /dev/zero through cat (cp-alike)
echo "--- Test 10: large passthrough (10GB) ---"
output_size=$(timeout 60 "$NPROXY" sh -c 'dd if=/dev/zero bs=1M count=10240 2>/dev/null | cat' 2>/dev/null | wc -c) || true
if [[ "$output_size" -ge 10700000000 ]]; then
    green "  PASS: 10GB passthrough (got ${output_size} bytes)"
    ((PASS++))
else
    red "  FAIL: 10GB passthrough (got ${output_size} bytes)"
    ((FAIL++))
fi

# 11. Large parallel: stdout + stderr simultaneously (5GB each)
echo "--- Test 11: large parallel (5GB stdout + 5GB stderr) ---"
output_size=$(timeout 60 "$NPROXY" sh -c 'dd if=/dev/zero bs=1M count=5120 2>/dev/null | tee /dev/stderr' 2>/dev/null | wc -c) || true
if [[ "$output_size" -ge 5000000000 ]]; then
    green "  PASS: 5GB parallel stdout (got ${output_size} bytes)"
    ((PASS++))
else
    red "  FAIL: 5GB parallel stdout (got ${output_size} bytes)"
    ((FAIL++))
fi

# Summary
echo ""
echo "=== Results: $PASS pass, $FAIL fail ==="
[[ "$FAIL" -eq 0 ]] || exit 1
