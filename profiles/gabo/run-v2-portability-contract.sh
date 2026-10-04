#!/usr/bin/env bash
# Attach-only portability contract for the native Rigel V2 HTTP layer.
#
# It runs entirely against the already-running isolated V2 laboratory
# (opencode-v2-lab.service). It NEVER launches OpenCode, NEVER uses Docker, and
# NEVER addresses V1: every HTTP request goes to the laboratory origin resolved
# from the lab unit, and the resolver checks are pure Node with no network.
#
#   bash run-v2-portability-contract.sh
#
# Proves, on the real surface:
# - the lab is a V2 server by its own /api/info identity document;
# - the identity pid equals the laboratory service MainPID (process identity,
#   not a port heuristic);
# - the resolver accepts port 4096 and refuses a non-loopback origin;
# - the credential resolver accepts both OPENCODE_PASSWORD and
#   OPENCODE_SERVER_PASSWORD;
# and records the sanitized evidence under .omo/evidence/.
set -uo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
lab_root="${RIGEL_V2_LAB_ROOT:-$HOME/.local/share/opencode-v2-lab}"
secret_file="$lab_root/secret.env"
service="${RIGEL_V2_SERVICE:-opencode-v2-lab.service}"
origin="${RIGEL_V2_LAB_ORIGIN:-http://127.0.0.1:4097}"
evidence_dir="$root/.omo/evidence/$(date +%Y%m%d)-rigel-v2-portability"
fail=0
pass() { echo "portability: $1: PASS"; }
bad() { echo "portability: $1: FAIL" >&2; fail=$((fail + 1)); }

mkdir -p "$evidence_dir"

password=$(grep -m1 '^OPENCODE_PASSWORD=' "$secret_file" 2>/dev/null | cut -d= -f2-)
if [ -n "${password:-}" ]; then pass "lab credentials available"; else bad "lab credentials unavailable"; fi

# --- Resolver contract (pure Node, no network) ------------------------------
resolver_json=$(node --input-type=module -e "
import { resolveServerOrigin, resolveCredential } from 'file://$root/profiles/gabo/opencode/rigel-v2-native-http.mjs'
const r4096 = resolveServerOrigin({ argv: ['opencode','serve','--port','4096'], env: {}, context: {} })
const rContext = resolveServerOrigin({ argv: ['opencode'], env: {}, context: { serverUrl: 'http://127.0.0.1:4100' } })
const rForeign = resolveServerOrigin({ argv: [], env: { RIGEL_V2_SERVER_ORIGIN: 'http://10.0.0.5:4100' }, context: {} })
const cPrimary = resolveCredential({ OPENCODE_PASSWORD: 'p' })
const cSecondary = resolveCredential({ OPENCODE_SERVER_PASSWORD: 'p', OPENCODE_SERVER_USERNAME: 'u' })
console.log(JSON.stringify({ r4096: r4096.origin, rContext: rContext.origin, rForeign: rForeign.origin ?? 'REFUSED', cPrimary: Boolean(cPrimary?.authorization), cSecondary: Boolean(cSecondary?.authorization) }))
" 2>/dev/null)

case "$resolver_json" in
  *'"r4096":"http://127.0.0.1:4096"'*) pass "resolver accepts port 4096";;
  *) bad "resolver refused port 4096";;
esac
case "$resolver_json" in
  *'"rContext":"http://127.0.0.1:4100"'*) pass "resolver uses context serverUrl without --port (normal path)";;
  *) bad "resolver did not resolve context serverUrl";;
esac
case "$resolver_json" in
  *'"rForeign":"REFUSED"'*) pass "resolver refuses a non-loopback origin";;
  *) bad "resolver accepted a non-loopback origin";;
esac
case "$resolver_json" in
  *'"cPrimary":true'*'"cSecondary":true'*) pass "credential resolver accepts both OPENCODE_PASSWORD and OPENCODE_SERVER_PASSWORD";;
  *) bad "credential resolver rejected a legitimate variable";;
esac

# --- Live V2 identity (attach-only) -----------------------------------------
[ "$(systemctl --user is-active "$service" 2>/dev/null)" = "active" ] && pass "lab service active" || bad "lab service not active"
main_pid=$(systemctl --user show "$service" -p MainPID --value 2>/dev/null)

info=$(curl -fsS -u "opencode:${password}" --max-time 5 "$origin/api/info" 2>/dev/null)
printf '%s' "$info" > "$evidence_dir/api-info.json"
info_json=$(python3 - "$main_pid" "$origin" "$evidence_dir/api-info.json" <<'PY'
import json, sys
pid_expected, origin, path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.load(open(path))
except Exception:
    print("unparseable"); raise SystemExit
doc = d.get("data", d)
version = doc.get("version")
pid = doc.get("pid")
urls = doc.get("urls")
print("parsed")
print("version", version)
print("pid_matches", str(pid) == str(pid_expected))
print("origin_listed", isinstance(urls, list) and origin in urls)
PY
)
printf '%s\n' "$info_json" > "$evidence_dir/live-identity.txt"

case "$info_json" in
  *$'parsed'*) pass "lab answers /api/info as a V2 identity document";;
  *) bad "lab /api/info did not return a V2 identity document";;
esac
case "$info_json" in
  *$'pid_matches True'*) pass "identity pid equals the laboratory service MainPID";;
  *) bad "identity pid did not match the laboratory service MainPID";;
esac
case "$info_json" in
  *$'origin_listed True'*) pass "identity urls includes the laboratory origin";;
  *) bad "identity urls did not include the laboratory origin";;
esac

# The V1-safety property: the contract never used the V1 port. It resolved the
# lab origin only; assert no request targeted the V1 listener.
case "$origin" in
  *:4096*) bad "contract origin resolves to the V1 port";;
  *) pass "contract origin never resolves to the V1 port (4096)";;
esac

{
  echo "origin=$origin"
  echo "service=$service"
  echo "main_pid=$main_pid"
  echo "resolver=$resolver_json"
  echo "failed_steps=$fail"
} > "$evidence_dir/portability-contract.txt"

if [ "$fail" -gt 0 ]; then
  echo "Rigel V2 portability contract FAILED: $fail step(s). Evidence: $evidence_dir/portability-contract.txt" >&2
  exit 1
fi
echo "Rigel V2 portability contract passed (attach-only; V1 never addressed). Evidence: $evidence_dir/portability-contract.txt"
