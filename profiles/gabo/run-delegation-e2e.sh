#!/usr/bin/env bash
# Full OpenCode V2 delegation fixture. It uses an in-container deterministic
# OpenAI-compatible provider and never mounts a user config or credential.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sandbox="$(mktemp -d "${TMPDIR:-/tmp}/ho-my-rigel-e2e.XXXXXX")"
port="${HO_MY_RIGEL_E2E_PORT:-4329}"
password="ho-my-rigel-e2e"
container_name="ho-my-rigel-e2e-$$"
fixture_config="$root/profiles/gabo/fixtures/opencode.fake-model.json"
container_network_args=()
container_port_args=(-p "127.0.0.1:${port}:${port}")
container_command='bun /workspace/profiles/gabo/fixtures/fake-openai-tool-loop.mjs & exec opencode serve --hostname 0.0.0.0 --port '"$port"

if [ "${HO_MY_RIGEL_USE_OPENGO:-0}" = "1" ]; then
  fixture_config="$root/profiles/gabo/fixtures/opencode.opengo-model.json"
  container_network_args=(--network host)
  container_port_args=()
  container_command='exec opencode serve --hostname 127.0.0.1 --port '"$port"
fi

cleanup() {
  status=$?
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$sandbox"
  exit "$status"
}
trap cleanup EXIT INT TERM

command -v opencode >/dev/null 2>&1 || { echo "OpenCode V2 is required" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo "Docker is required" >&2; exit 2; }
case "$(opencode --version)" in *"v2."*) ;; *) echo "Expected OpenCode V2" >&2; exit 2;; esac

mkdir -p "$sandbox/home/.omo/opencode/prompts" "$sandbox/xdg/config/opencode" "$sandbox/xdg/data" "$sandbox/xdg/state" "$sandbox/xdg/cache" "$sandbox/project"
sed 's|__OMO_PROFILE_ROOT__|/sandbox/home/.omo|g' "$root/profiles/gabo/omo.jsonc" > "$sandbox/home/.omo/omo.jsonc"
cp "$root/profiles/gabo/opencode/prompts/sisyphus-orchestration.md" "$sandbox/home/.omo/opencode/prompts/sisyphus-orchestration.md"
mkdir -p "$sandbox/home/.agents"
cp -R "$root/profiles/gabo/skills" "$sandbox/home/.agents/skills"
node - "$root/profiles/gabo/opencode/opencode.json" "$fixture_config" "$sandbox/xdg/config/opencode/opencode.json" <<'NODE'
const fs=require('fs'); const path=require('path'); const [base, fixture, output]=process.argv.slice(2);
const config=JSON.parse(fs.readFileSync(base,'utf8').replace('file://__OMO_PLUGIN_ENTRY__','file:///workspace/packages/omo-opencode/src/index.ts'));
Object.assign(config, JSON.parse(fs.readFileSync(fixture,'utf8')));
config.agent={...(config.agent ?? {}), judge: JSON.parse(fs.readFileSync(path.join(path.dirname(base),'agents/judge.v2.json'),'utf8'))};
fs.writeFileSync(output, JSON.stringify(config,null,2));
NODE

docker run -d --rm --name "$container_name" "${container_network_args[@]}" "${container_port_args[@]}" \
  -v "$sandbox:/sandbox" -v "$root:/workspace:ro" -v "$(command -v opencode):/usr/local/bin/opencode:ro" -w /sandbox/project \
  -e HOME=/sandbox/home -e XDG_CONFIG_HOME=/sandbox/xdg/config -e XDG_DATA_HOME=/sandbox/xdg/data -e XDG_STATE_HOME=/sandbox/xdg/state -e XDG_CACHE_HOME=/sandbox/xdg/cache -e OPENCODE_CONFIG_DIR=/sandbox/xdg/config/opencode -e OMO_PROFILE=gabo -e OPENCODE_SERVER_PASSWORD="$password" \
  omo-dev sh -lc "$container_command" >/dev/null

for _ in $(seq 1 60); do curl -fsS -u "opencode:$password" "http://127.0.0.1:$port/openapi.json" > "$sandbox/openapi.json" 2>/dev/null && break; sleep .25; done
[ -s "$sandbox/openapi.json" ] || { docker logs "$container_name" >&2; exit 1; }
session_response="$(curl -sS -u "opencode:$password" -H 'content-type: application/json' -d '{"agent":"sisyphus","model":{"providerID":"rigel-fixture","id":"fixture"}}' "http://127.0.0.1:$port/api/session")"
session="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const value=JSON.parse(s);const id=value.data?.id;if(!id){console.error(JSON.stringify(value));process.exit(1)}console.log(id)})' <<<"$session_response")"
prompt_response="$(curl -sS -u "opencode:$password" -H 'content-type: application/json' -d '{"text":"Delegate this isolated verification to the appropriate specialist."}' "http://127.0.0.1:$port/api/session/$session/prompt")"
node -e 'const value=JSON.parse(process.argv[1]); if(value.error || value._tag){console.error(JSON.stringify(value));process.exit(1)}' "$prompt_response"
for _ in $(seq 1 80); do curl -fsS -u "opencode:$password" "http://127.0.0.1:$port/api/session/$session/message" > "$sandbox/messages.json" 2>/dev/null && rg -q 'SPECIALIST_EVIDENCE|SELF_AUDIT_PASS' "$sandbox/messages.json" && break; sleep .25; done
rg -q 'SPECIALIST_EVIDENCE' "$sandbox/messages.json"
rg -q 'SELF_AUDIT_PASS' "$sandbox/messages.json"
rg -q 'explore' "$sandbox/messages.json"
judge_response="$(curl -sS -u "opencode:$password" -H 'content-type: application/json' -d '{"agent":"judge","model":{"providerID":"'"$(node -e 'const c=require(process.argv[1]);console.log(c.model.split("/")[0])' "$fixture_config")"'","id":"'"$(node -e 'const c=require(process.argv[1]);console.log(c.model.split("/").slice(1).join("/"))' "$fixture_config")"'"}}' "http://127.0.0.1:$port/api/session")"
judge_session="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const id=JSON.parse(s).data?.id;if(!id)process.exit(1);console.log(id)})' <<<"$judge_response")"
judge_prompt="$(curl -sS -u "opencode:$password" -H 'content-type: application/json' -d '{"text":"Review this isolated delegation evidence: SPECIALIST_EVIDENCE; SELF_AUDIT_PASS. Return only APPROVED, REJECTED, or BLOCKED."}' "http://127.0.0.1:$port/api/session/$judge_session/prompt")"
node -e 'const value=JSON.parse(process.argv[1]); if(value.error || value._tag)process.exit(1)' "$judge_prompt"
for _ in $(seq 1 80); do curl -fsS -u "opencode:$password" "http://127.0.0.1:$port/api/session/$judge_session/message" > "$sandbox/judge-messages.json" 2>/dev/null && rg -q 'APPROVED|REJECTED|BLOCKED' "$sandbox/judge-messages.json" && break; sleep .25; done
rg -q 'APPROVED|REJECTED|BLOCKED' "$sandbox/judge-messages.json"
curl -fsS -u "opencode:$password" "http://127.0.0.1:$port/api/session/$judge_session" > "$sandbox/judge-session.json"
rg -q '"agent":"judge"' "$sandbox/judge-session.json"
echo "Ho My Rigel delegation E2E passed: Sisyphus delegated, self-audited, and Juez returned an independent verdict"
