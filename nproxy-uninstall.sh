#!/usr/bin/env bash
# nproxy-uninstall.sh — revert transparent binary wrappers
set -e

NPROXY_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER_INFO="$HOME/.nproxy_wrapper"

echo "=== nproxy uninstall ==="
echo ""

# ---- Helper: read with YES=1 env var support ----
# Usage: prompt VAR DEFAULT PROMPT_TEXT
# Sets VAR to DEFAULT if YES=1, otherwise prompts.
prompt() {
  local var="$1" default="$2" text="$3"
  if [ -n "$YES" ]; then
    eval "$var=\"$default\""
  else
    local val
    read -p "$text" val
    val=${val:-$default}
    eval "$var=\"$val\""
  fi
}

# ---- Restore wrapped binaries ----
if [ -f "$WRAPPER_INFO" ]; then
  source "$WRAPPER_INFO"
  if [ "$IS_SYMLINK" = "1" ]; then
    # Was a symlink: restore symlink to original binary
    echo "Restoring: $WRAP_BIN_NAME (symlink → $REAL_BIN)"
    if [ -f "$WRAP_BIN" ]; then
      rm -f "$WRAP_BIN"
      echo "  Removed wrapper: $WRAP_BIN"
    fi
    if [ -f "$REAL_BIN" ]; then
      ln -sf "$REAL_BIN" "$WRAP_BIN"
      echo "  Restored symlink: $WRAP_BIN → $REAL_BIN"
    else
      echo "  ERROR: Real binary not found at $REAL_BIN"
    fi
  elif [ -n "$BACKUP_BIN" ] && [ -f "$BACKUP_BIN" ]; then
    echo "Restoring: $WRAP_BIN_NAME ($BACKUP_BIN → $WRAP_BIN)"
    if [ -f "$WRAP_BIN" ]; then
      rm -f "$WRAP_BIN"
      echo "  Removed wrapper: $WRAP_BIN"
    fi
    mv "$BACKUP_BIN" "$WRAP_BIN"
    echo "  Restored original: $WRAP_BIN"
  else
    echo "  Backup not found at $BACKUP_BIN"
    echo "  Checking for binary..."
    if [ -f "$WRAP_BIN" ] && head -1 "$WRAP_BIN" | grep -q "nproxy wrapper"; then
      echo "  Wrapper found at $WRAP_BIN but no backup."
      prompt REMOVE "n" "  Remove wrapper (binary will be lost)? [y/N]: "
      if [[ "$REMOVE" =~ ^[Yy] ]]; then
        rm -f "$WRAP_BIN"
        echo "  Removed."
      fi
    fi
  fi
  rm -f "$WRAPPER_INFO"
  echo ""
else
  echo "No wrapper info found ($WRAPPER_INFO)."
  echo "Searching for nproxy wrappers..."
  for F in /usr/local/bin/opencode /usr/local/bin/openclaude; do
    if [ -f "$F" ] && head -1 "$F" 2>/dev/null | grep -q "nproxy wrapper"; then
      BACKUP="${F%/*}/${F##*/}.real"
      if [ -f "$BACKUP" ]; then
        prompt RESTORE "y" "Restore ${F##*/}? [Y/n]: "
        if [[ "$RESTORE" =~ ^[Yy] ]]; then
          rm -f "$F"
          mv "$BACKUP" "$F"
          echo "  Restored $F"
        fi
      else
        echo "  Found wrapper $F but no backup ($BACKUP)."
        prompt RM "n" "  Remove wrapper only? [y/N]: "
        if [[ "$RM" =~ ^[Yy] ]]; then
          rm -f "$F"
          echo "  Removed."
        fi
      fi
    fi
  done
fi

# ---- Clean up LD_PRELOAD references ----
echo "Checking for LD_PRELOAD references..."
NPROXY_ENV="$HOME/.nproxy.sh"
if [ -f "$NPROXY_ENV" ]; then
  if grep -q "nproxy_ld" "$NPROXY_ENV" 2>/dev/null; then
    echo "  LD_PRELOAD references found in $NPROXY_ENV"
    prompt RM_LD "y" "  Remove LD_PRELOAD config from .nproxy.sh? [Y/n]: "
    if [[ "$RM_LD" =~ ^[Yy] ]]; then
      # Remove lines between "# LD_PRELOAD execve hook" and next blank line or end
      sed -i '/^# LD_PRELOAD execve hook/,/^$/d' "$NPROXY_ENV"
      sed -i '/^export NPROXY_LD_/d' "$NPROXY_ENV"
      sed -i '/^export LD_PRELOAD.*nproxy_ld/d' "$NPROXY_ENV"
      echo "  Removed LD_PRELOAD references."
    fi
  else
    echo "  No LD_PRELOAD references in $NPROXY_ENV"
  fi
fi

# ---- Done ----
echo ""
echo "Done. Uninstall complete."
echo "To remove nproxy aliases, edit ~/.bash_aliases manually."
echo "To fully remove nproxy, delete $NPROXY_DIR."
