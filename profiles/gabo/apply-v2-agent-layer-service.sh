#!/usr/bin/env bash
# Run as: sudo bash profiles/gabo/apply-v2-agent-layer-service.sh
set -euo pipefail
if [[ ${EUID:-} -ne 0 ]]; then
  echo "Run with sudo: sudo bash profiles/gabo/apply-v2-agent-layer-service.sh" >&2
  exit 1
fi
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
systemctl stop opencode-lan.service
runuser -u gabodev -- env HOME=/home/gabodev node "$root/profiles/gabo/apply-v2-agent-layer.mjs"
systemctl start opencode-lan.service
echo "Rigel V2 static agent layer is active through opencode-lan.service."
