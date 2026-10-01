#!/usr/bin/env bash
# Run as: sudo bash profiles/gabo/apply-v2-runtime-service.sh
# Atomically refreshes the native V2 runtime and static agent layer for an
# already-active Rigel trial. It intentionally never changes authentication
# plugins or the Obsidian MCP block; both are fingerprint-guarded by the
# called scripts.
set -euo pipefail

if [[ ${EUID:-} -ne 0 ]]; then
  echo "Run with sudo: sudo bash profiles/gabo/apply-v2-runtime-service.sh" >&2
  exit 1
fi

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
completed=false
trap 'if [[ "$completed" != true ]]; then systemctl start opencode-lan.service >/dev/null 2>&1 || true; fi' EXIT

systemctl stop opencode-lan.service
runuser -u gabodev -- env HOME=/home/gabodev node "$root/profiles/gabo/switch-live-plugin-to-native-v2.mjs"
runuser -u gabodev -- env HOME=/home/gabodev node "$root/profiles/gabo/apply-v2-agent-layer.mjs"
systemctl start opencode-lan.service
completed=true

echo "Rigel native V2 runtime and static agent layer are active through opencode-lan.service."
