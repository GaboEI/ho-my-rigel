#!/usr/bin/env bash
# Run as: sudo bash profiles/gabo/switch-system-service-to-dist.sh
set -euo pipefail
if [[ ${EUID:-} -ne 0 ]]; then
  echo "Run with sudo: sudo bash profiles/gabo/switch-system-service-to-dist.sh" >&2
  exit 1
fi
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
systemctl stop opencode-lan.service
runuser -u gabodev -- env HOME=/home/gabodev node "$root/profiles/gabo/switch-live-plugin-to-dist.mjs"
systemctl start opencode-lan.service
echo "Rigel service restarted with the built plugin."
