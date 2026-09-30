#!/usr/bin/env bash
# Run as: sudo bash profiles/gabo/rollback-system-service.sh
# Returns opencode-lan.service and user-owned OpenCode state to the freeze.
set -euo pipefail

if [[ ${EUID:-} -ne 0 ]]; then
  echo "Run with sudo: sudo bash profiles/gabo/rollback-system-service.sh" >&2
  exit 1
fi

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
user_home=/home/gabodev
unit_dropin=/etc/systemd/system/opencode-lan.service.d/ho-my-rigel.conf

systemctl stop opencode-lan.service
runuser -u gabodev -- env HOME="$user_home" node "$root/profiles/gabo/rollback-live-trial.mjs"
rm -f -- "$unit_dropin"
systemctl daemon-reload
systemctl start opencode-lan.service
echo "Pre-Rigel OpenCode service restored."
