#!/usr/bin/env bash
# Run as: sudo bash profiles/gabo/switch-system-service-to-v2-adapter.sh
set -euo pipefail
if [[ ${EUID:-} -ne 0 ]]; then
  echo "Run with sudo: sudo bash profiles/gabo/switch-system-service-to-v2-adapter.sh" >&2
  exit 1
fi
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
systemctl stop opencode-lan.service
runuser -u gabodev -- env HOME=/home/gabodev node "$root/profiles/gabo/switch-live-plugin-to-v2-adapter.mjs"
systemctl start opencode-lan.service
echo "Rigel V2 adapter is now active through opencode-lan.service."
