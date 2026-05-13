#!/bin/bash
# env-info.sh — Collect environment information for nproxy/OpenClaude diagnostics
#
# Usage:
#   bash tools/env-info.sh
#   bash tools/env-info.sh 2>/dev/null   # strip stderr (commands that may warn)
#
# Output: plain-text report to stdout, one section per category.
# Errors: go to stderr (wrapped in subshells with || true).

report() {
  local section="$1"
  echo "--- $section ---"
}

# ---- os ----
report "os"
echo "Kernel: $(uname -a 2>/dev/null || echo 'N/A')"
if [ -f /etc/os-release ]; then
  echo "Distro: $( (. /etc/os-release && echo "$NAME $VERSION_ID") 2>/dev/null || echo 'unknown')"
else
  echo "Distro: N/A"
fi

# WSL detection
if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  echo "WSL: 2 (Microsoft kernel)"
elif grep -qi wsl /proc/sys/kernel/osrelease 2>/dev/null; then
  echo "WSL: 1"
else
  echo "WSL: no"
fi

# ---- node ----
report "node"
echo "Version: $(node -e 'console.log(process.version)' 2>/dev/null || echo 'N/A')"
echo "Platform: $(node -e 'console.log(process.platform)' 2>/dev/null || echo 'N/A')"
echo "Arch: $(node -e 'console.log(process.arch)' 2>/dev/null || echo 'N/A')"
echo "Path: $(command -v node 2>/dev/null || echo 'not found')"

# ---- openclaude ----
report "openclaude"
OC_PATH=""
for p in /usr/bin/openclaude /usr/local/bin/openclaude; do
  if [ -x "$p" ]; then
    OC_PATH="$p"
    break
  fi
done
if [ -n "$OC_PATH" ]; then
  echo "Path: $OC_PATH"
  echo "Version: $("$OC_PATH" --version 2>/dev/null || echo '--version failed')"
  echo "Shebang: $(head -1 "$OC_PATH" 2>/dev/null || echo 'N/A')"
  echo "Size: $(wc -c < "$OC_PATH" 2>/dev/null) bytes"
  echo "Realpath: $(readlink -f "$OC_PATH" 2>/dev/null || echo 'N/A')"
else
  echo "Path: not found"
fi

# ---- nproxy ----
report "nproxy"
if [ -d "$(dirname "$0")/.." ]; then
  NPROXY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  echo "Project dir: $NPROXY_DIR"
  if [ -f "$NPROXY_DIR/node/nproxy.js" ]; then
    echo "nproxy.js: $NPROXY_DIR/node/nproxy.js"
    echo "nproxy.js lines: $(wc -l < "$NPROXY_DIR/node/nproxy.js" 2>/dev/null)"
  else
    echo "nproxy.js: not found at expected location"
  fi
  if [ -f "$NPROXY_DIR/nproxy-run.sh" ]; then
    echo "nproxy-run.sh: present"
  else
    echo "nproxy-run.sh: not found"
  fi
  echo "git branch: $(cd "$NPROXY_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'not a git repo')"
  echo "git hash: $(cd "$NPROXY_DIR" && git rev-parse --short HEAD 2>/dev/null || echo 'N/A')"
else
  echo "Project dir: could not determine"
fi

# ---- terminal ----
report "terminal"
echo "TERM: ${TERM:-not set}"
echo "SHELL: ${SHELL:-not set}"
echo "LANG: ${LANG:-not set}"
if tty -s 2>/dev/null; then
  echo "tty: $(tty 2>/dev/null)"
else
  echo "tty: not a tty (piped or script)"
fi
echo "COLUMNS: ${COLUMNS:-not set}"
echo "LINES: ${LINES:-not set}"

# ---- process ----
report "process"
echo "PATH: $PATH"
echo "ulimit -n: $(ulimit -n 2>/dev/null || echo 'N/A')"
echo "ulimit -u: $(ulimit -u 2>/dev/null || echo 'N/A')"
echo "HOME: $HOME"
echo "USER: ${USER:-unknown}"
echo "Disk /: $(df -h / 2>/dev/null | tail -1 | awk '{print $3 " used / " $2 " total (" $5 ")"}')"

# ---- WSL-specific ----
report "wsl"
# Windows-side wsl.exe (only accessible from WSL)
if command -v wsl.exe &>/dev/null; then
  echo "wsl.exe: available"
  wsl.exe -l -v 2>/dev/null || echo "  (wsl.exe -l -v failed)"
else
  echo "wsl.exe: not available (not WSL or not in PATH)"
fi
if [ -f /etc/wsl.conf ]; then
  echo "wsl.conf: present"
  cat /etc/wsl.conf 2>/dev/null || echo "  (unreadable)"
else
  echo "wsl.conf: not present"
fi
# /mnt/ availability
if [ -d /mnt/c ]; then
  echo "/mnt/c: accessible"
  echo "/mnt/c contents: $(ls /mnt/c/ 2>/dev/null | head -5 | tr '\n' ' ')"
else
  echo "/mnt/c: not accessible"
fi
# Windows-side PATH forwarding
if command -v cmd.exe &>/dev/null; then
  echo "cmd.exe: available"
  echo "Windows PATH: $(cmd.exe /c 'echo %PATH%' 2>/dev/null | head -c 200 || echo '  (echo failed)')"
fi

# ---- node-pty ----
report "node-pty"
if node -e "const p = require('node-pty'); console.log(p.version || 'ok')" 2>/dev/null; then
  echo "  ... installed and loadable"
else
  echo "node-pty: not installed or not loadable"
fi
# Also check global npm packages for node-pty
echo "npm list -g node-pty: $(npm list -g node-pty 2>/dev/null | tail -1 || echo 'not found')"

# ---- /dev/tty ----
report "dev-tty"
if echo ok > /dev/tty 2>/dev/null; then
  echo "/dev/tty: writable"
else
  echo "/dev/tty: not writable or not available"
fi

# ---- node-pty alternatives (Windows ConPTY) ----
report "conpty"
if uname -r 2>/dev/null | grep -qi microsoft; then
  echo "Node.js Windows: $(node -e 'console.log(process.platform === "win32" ? "win32" : "not win32")' 2>/dev/null)"
  echo "Windows Terminal default: ${WT_SESSION:-not set}"
  echo "VS Code integration: ${TERM_PROGRAM:-not set}"
  echo "ConPTY available: Windows 10+ (assumed yes on WSL2)"
else
  echo "Not WSL — ConPTY check skipped"
fi

# ---- summary ----
report "done"
echo "Report generated: $(date -Iseconds)"
echo "Hostname: $(hostname 2>/dev/null || echo 'unknown')"
