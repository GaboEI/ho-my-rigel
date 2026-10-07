#!/usr/bin/env bash
# Acceptance validation against the isolated V2 laboratory service
# (opencode-v2-lab.service). Never launches OpenCode, never uses Docker, and
# never addresses or mutates V1. Read-only V1 integrity checks wrap the run.
#
#   bash run-lab-acceptance.sh            validate the running lab
#   bash run-lab-acceptance.sh --refresh  refresh the runtime first through
#                                         apply-v2-runtime-service.sh, then validate
set -uo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
service="opencode-v2-lab.service"
lab_root="${RIGEL_V2_LAB_ROOT:-$HOME/.local/share/opencode-v2-lab}"
secret_file="$lab_root/secret.env"
evidence_dir="$root/.omo/evidence/$(date +%Y%m%d)-rigel-lab-acceptance"
fail=0
pass() { echo "lab: $1: PASS"; }
bad() { echo "lab: $1: FAIL" >&2; fail=$((fail + 1)); }

# Path-segment containment: /a/opencode must never match /a/opencode-v2-lab.
under() { case "$2" in "$1"|"$1"/*) return 0;; *) return 1;; esac; }

v1_roots=(
  "$HOME/.config/opencode"
  "$HOME/.local/share/opencode"
  "$HOME/.local/share/opencode-goal-plugin"
  "$HOME/.cache/opencode"
)

goal_gate="$root/profiles/gabo/lab-goal-gate.mjs"
goal_mode=$(node "$goal_gate" --mode "$HOME")
goal_probe() { node "$goal_gate" --probe "$HOME"; }

mkdir -p "$evidence_dir"
echo "== Rigel lab acceptance =="

before_goals=$(goal_probe)
before_config_hash=$(sha256sum "$HOME/.config/opencode/opencode.json" 2>/dev/null | cut -d' ' -f1)
before_counts=$(for r in "${v1_roots[@]}"; do [ -d "$r" ] && find "$r" -type f 2>/dev/null | wc -l; done | tr '\n' ',')
echo "v1: config_hash=${before_config_hash:0:16} goal_mode=$goal_mode goal_state=$before_goals counts=$before_counts"

if [ "${1:-}" = "--refresh" ]; then
  echo "-- refresh through apply-v2-runtime-service.sh (only touches $service) --"
  if bash "$root/profiles/gabo/apply-v2-runtime-service.sh"; then pass "runtime refresh"; else bad "runtime refresh"; fi
fi

[ "$(systemctl --user is-active "$service" 2>/dev/null)" = "active" ] && pass "service active" || bad "service active"

unit_env=$(systemctl --user show "$service" -p Environment --value 2>/dev/null)
case "$unit_env" in *"opencode-lan.service"*) bad "unit references the V1 service";; *) pass "unit does not reference V1 service";; esac
unit_values=$(printf '%s' "$unit_env" | tr ' ' '\n' | sed -n 's/^[A-Za-z_]*=//p')
unit_leak=0
for value in $unit_values; do
  case "$value" in /*) for r in "${v1_roots[@]}"; do under "$r" "$value" && unit_leak=1; done;; esac
done
[ "$unit_leak" = 0 ] && pass "unit environment resolves no V1 root" || bad "unit environment touches a V1 root"
unit_lab=0
for value in $unit_values; do
  case "$value" in /*) under "$lab_root" "$value" && unit_lab=1;; esac
done
[ "$unit_lab" = 1 ] && pass "unit environment is rooted in $lab_root" || bad "unit environment is not rooted in the lab"

exec_line=$(systemctl --user show "$service" -p ExecStart --value 2>/dev/null)
case "$exec_line" in *"$HOME/.opencode/bin/opencode"*) pass "service uses the V2 binary";; *) bad "service binary is not the isolated V2 binary";; esac
case "$exec_line" in *"--port 4097"*) pass "service listens on the lab port 4097";; *) bad "service port is not 4097";; esac

password=$(grep -m1 '^OPENCODE_PASSWORD=' "$secret_file" 2>/dev/null | cut -d= -f2-)
[ -n "${password:-}" ] && pass "lab credentials available" || bad "lab credentials unavailable"
curl_json() { curl -fsS -u "opencode:${password}" "http://127.0.0.1:4097$1" 2>/dev/null; }

ready=0
for _ in $(seq 1 60); do
  if curl -fsS -u "opencode:${password}" "http://127.0.0.1:4097/openapi.json" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
[ "$ready" = 1 ] && pass "lab API ready" || bad "lab API never became ready"

openapi=$(curl_json /openapi.json)
case "$openapi" in *'"openapi":"3'*|*'"openapi": "3'*) pass "lab API openapi 3";; *) bad "lab API did not answer openapi 3";; esac

# V2 identity, not port identity: the lab must answer /api/info with its own
# version and pid. A port number is never treated as proof of the server.
info=$(curl_json /api/info)
case "$info" in
  *'"version"'*'"pid"'*) pass "lab API identifies as V2 via /api/info";;
  *) bad "lab API /api/info did not return a V2 identity document";;
esac

curl_json /api/config > "$evidence_dir/api-config.json"
if [ -s "$evidence_dir/api-config.json" ]; then
  verdicts=$(python3 - "$lab_root" "$HOME" "$evidence_dir/api-config.json" <<'PY'
import json, sys
lab, home, path = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.load(open(path))
v1 = [home + "/.config/opencode", home + "/.local/share/opencode", home + "/.local/share/opencode-goal-plugin", home + "/.cache/opencode"]
def under(p, r): return p == r or p.startswith(r + "/")
paths = [s.get("path", "") for s in data if isinstance(s, dict)]
print("sources", len(paths))
print("v1_hits", sum(1 for p in paths if any(under(p, v) for v in v1)))
print("lab_hits", sum(1 for p in paths if under(p, lab)))
PY
)
  echo "config-sources: $(printf '%s' "$verdicts" | tr '\n' ' ')"
  case "$verdicts" in *"v1_hits 0"*) pass "config sources resolve no V1 path";; *) bad "config sources touch a V1 path";; esac
  case "$verdicts" in *"lab_hits 0"*) bad "config sources are not rooted in the lab";; *) pass "config sources include the lab root";; esac
else
  bad "lab API did not return config"
fi

# Installed CLI acceptance: drives the launcher materialized by the authorized
# refresh (not the source file) and proves it resolves inside the lab while V1
# stays byte-identical.
if [ -x "$lab_root/rigel/bin/rigel-v2" ] && command -v bun >/dev/null 2>&1; then
  if bun "$root/profiles/gabo/qa-v2-cli-installed.mjs"; then pass "installed CLI acceptance"; else bad "installed CLI acceptance"; fi
else
  bad "installed CLI launcher missing at $lab_root/rigel/bin/rigel-v2"
fi

after_goals=$(goal_probe)
after_config_hash=$(sha256sum "$HOME/.config/opencode/opencode.json" 2>/dev/null | cut -d' ' -f1)
after_counts=$(for r in "${v1_roots[@]}"; do [ -d "$r" ] && find "$r" -type f 2>/dev/null | wc -l; done | tr '\n' ',')

[ "$before_config_hash" = "$after_config_hash" ] && pass "V1 config hash unchanged" || bad "V1 config hash changed"
[ "$before_counts" = "$after_counts" ] && pass "V1 root file counts unchanged" || bad "V1 root file counts changed"
if goal_verdict=$(node "$goal_gate" --verify "$goal_mode" "$before_goals" "$after_goals" 2>&1); then
  pass "goal invariant ($goal_mode): $goal_verdict"
else
  bad "goal invariant ($goal_mode): $goal_verdict"
fi

{
  echo "service=$service"
  echo "lab_root=$lab_root"
  echo "v1_config_hash_before=$before_config_hash"
  echo "v1_config_hash_after=$after_config_hash"
  echo "v1_counts_before=$before_counts"
  echo "v1_counts_after=$after_counts"
  echo "goal_mode=$goal_mode"
  echo "goal_state_before=$before_goals"
  echo "goal_state_after=$after_goals"
  echo "goal_verdict=${goal_verdict:-}"
  echo "failed_steps=$fail"
} > "$evidence_dir/lab-acceptance.txt"

if [ "$fail" -gt 0 ]; then
  echo "Rigel lab acceptance FAILED: $fail step(s). Evidence: $evidence_dir/lab-acceptance.txt" >&2
  exit 1
fi
echo "Rigel lab acceptance passed (isolated V2 service; V1 intact). Evidence: $evidence_dir/lab-acceptance.txt"
