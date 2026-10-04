#!/usr/bin/env bash
# Run as: sudo bash profiles/gabo/activate-system-service.sh
# Stops only opencode-lan.service, activates the user-owned Rigel files, then
# installs a minimal environment-only systemd drop-in and starts that service.
set -euo pipefail
if [[ "${RIGEL_ALLOW_LEGACY_SYSTEM_TRIAL:-}" != "1" ]]; then
  echo "Historical V1 service activation is disabled; use apply-v2-runtime-service.sh for the V2 laboratory." >&2
  exit 1
fi

if [[ ${EUID:-} -ne 0 ]]; then
  echo "Run with sudo: sudo bash profiles/gabo/activate-system-service.sh" >&2
  exit 1
fi

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
user_home=/home/gabodev
unit_dir=/etc/systemd/system/opencode-lan.service.d

systemctl stop opencode-lan.service
runuser -u gabodev -- env HOME="$user_home" node "$root/profiles/gabo/activate-live-trial.mjs"
install -D -m 0644 "$root/profiles/gabo/systemd/oh-my-rigel.conf" "$unit_dir/oh-my-rigel.conf"
systemctl daemon-reload
systemctl start opencode-lan.service
echo "Rigel is live through opencode-lan.service (OMO_PROFILE=gabo)."
