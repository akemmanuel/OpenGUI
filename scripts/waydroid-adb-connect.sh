#!/usr/bin/env bash
set -euo pipefail

if ! command -v waydroid >/dev/null; then
  echo "waydroid not found" >&2
  exit 1
fi
if ! command -v adb >/dev/null; then
  echo "adb not found" >&2
  exit 1
fi

adb start-server >/dev/null
waydroid adb connect >/dev/null || true

# waydroid hides adb's connect output, so verify and also try the status IP directly.
if ! adb devices | awk 'NR>1 && $2=="device" {found=1} END {exit !found}'; then
  ip="${WAYDROID_IP:-$(waydroid status 2>/dev/null | awk -F'\t' '/IP address:/ {print $2}') }"
  ip="${ip//[[:space:]]/}"
  if [[ -n "$ip" ]]; then
    adb connect "$ip" >/dev/null || true
  fi
fi

adb devices -l
if ! adb devices | awk 'NR>1 && $2=="device" {found=1} END {exit !found}'; then
  echo "No authorized Waydroid ADB device is visible." >&2
  echo "If Waydroid showed an authorization prompt, accept it, then rerun this script." >&2
  exit 2
fi
