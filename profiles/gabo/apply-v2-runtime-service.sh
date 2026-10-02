#!/usr/bin/env bash
# Refresh Rigel only inside the parallel OpenCode V2 laboratory. This script
# never addresses opencode-lan.service, which is the user's V1 service.
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
lab_root="${RIGEL_V2_LAB_ROOT:-/home/gabodev/.local/share/opencode-v2-lab}"
lab_home="$lab_root/home"
lab_config="$lab_root/config/opencode/opencode.json"
service="${RIGEL_V2_SERVICE:-opencode-v2-lab.service}"

if [[ ! -f "$lab_config" ]]; then
  echo "Rigel V2 refresh refused: isolated V2 config not found: $lab_config" >&2
  exit 1
fi

completed=false
trap 'if [[ "$completed" != true ]]; then systemctl --user start "$service" >/dev/null 2>&1 || true; fi' EXIT

systemctl --user stop "$service"
env RIGEL_V2_LAB_ROOT="$lab_root" RIGEL_V2_HOME="$lab_home" RIGEL_V2_CONFIG="$lab_config" \
  node "$root/profiles/gabo/apply-v2-agent-layer.mjs"
env RIGEL_V2_LAB_ROOT="$lab_root" RIGEL_V2_HOME="$lab_home" RIGEL_V2_CONFIG="$lab_config" \
  node "$root/profiles/gabo/switch-live-plugin-to-native-v2.mjs"
systemctl --user start "$service"
completed=true

echo "Rigel native V2 runtime and agent manifest are active through $service. V1 was not addressed."
