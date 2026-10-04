#!/usr/bin/env bash
# Boots the host's OpenCode V2 binary inside Docker with a disposable home and
# the local Oh My Rigel source plugin. The container has no mount of the
# caller's OpenCode state, credentials, account pools, or project directory.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sandbox="$(mktemp -d "${TMPDIR:-/tmp}/oh-my-rigel-v2.XXXXXX")"
port="${OH_MY_RIGEL_V2_PORT:-${HO_MY_RIGEL_V2_PORT:-4317}}"
password="oh-my-rigel-isolated"
container_name="oh-my-rigel-v2-$$"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$sandbox"
}
trap cleanup EXIT INT TERM

opencode_binary="${RIGEL_V2_BINARY:-$HOME/.opencode/bin/opencode}"
if [ ! -x "$opencode_binary" ]; then
  echo "OpenCode V2 binary is required at RIGEL_V2_BINARY (default: $opencode_binary)" >&2
  exit 2
fi
version="$("$opencode_binary" --version)"
case "$version" in
  *"v2."*) ;;
  *) echo "Expected OpenCode V2, got: $version" >&2; exit 2 ;;
esac

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required for the isolated V2 fixture" >&2
  exit 2
}

mkdir -p "$sandbox/home/.omo/opencode/prompts" "$sandbox/xdg/config/opencode" "$sandbox/xdg/data" "$sandbox/xdg/state" "$sandbox/xdg/cache" "$sandbox/project"
# The profile is consumed inside the container, where the host sandbox is
# deliberately exposed only as /sandbox.
sed 's|__OMO_PROFILE_ROOT__|/sandbox/home/.omo|g' "$root/profiles/gabo/omo.jsonc" > "$sandbox/home/.omo/omo.jsonc"
cp "$root/profiles/gabo/opencode/prompts/sisyphus-orchestration.md" "$sandbox/home/.omo/opencode/prompts/sisyphus-orchestration.md"
mkdir -p "$sandbox/home/.agents"
cp -R "$root/profiles/gabo/skills" "$sandbox/home/.agents/skills"
sed 's|file://__OMO_PLUGIN_ENTRY__|file:///workspace/packages/omo-opencode/src/index.ts|g' "$root/profiles/gabo/opencode/opencode.json" > "$sandbox/xdg/config/opencode/opencode.json"

docker run -d --rm --name "$container_name" -p "127.0.0.1:${port}:${port}" \
  -v "$sandbox:/sandbox" \
  -v "$root:/workspace:ro" \
  -v "$opencode_binary:/usr/local/bin/opencode:ro" \
  -w /sandbox/project \
  -e HOME=/sandbox/home \
  -e XDG_CONFIG_HOME=/sandbox/xdg/config \
  -e XDG_DATA_HOME=/sandbox/xdg/data \
  -e XDG_STATE_HOME=/sandbox/xdg/state \
  -e XDG_CACHE_HOME=/sandbox/xdg/cache \
  -e OPENCODE_CONFIG_DIR=/sandbox/xdg/config/opencode \
  -e OMO_PROFILE=gabo \
  -e OPENCODE_SERVER_PASSWORD="$password" \
  omo-dev /usr/local/bin/opencode serve --hostname 0.0.0.0 --port "$port" >/dev/null

for _ in $(seq 1 40); do
  if curl -fsS -u "opencode:$password" "http://127.0.0.1:$port/openapi.json" >"$sandbox/openapi.json" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

if [ ! -s "$sandbox/openapi.json" ]; then
  echo "OpenCode V2 did not become healthy in the isolated sandbox" >&2
  docker logs "$container_name" >&2 || true
  exit 1
fi

curl -fsS -u "opencode:$password" "http://127.0.0.1:$port/api/config" >"$sandbox/config.json"
node -e '
  const fs = require("node:fs");
  const openapi = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const sources = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (!String(openapi.openapi ?? "").startsWith("3.")) process.exit(1);
  if (!sources.some((source) => source.path?.startsWith("/sandbox/xdg/config/opencode"))) process.exit(1);
  if (sources.some((source) => source.path?.startsWith(os.homedir()))) process.exit(1);
' "$sandbox/openapi.json" "$sandbox/config.json"

docker run --rm \
  -v "$sandbox:/sandbox" \
  -v "$root:/workspace:ro" \
  -w /workspace \
  -e HOME=/sandbox/home \
  -e OPENCODE_CONFIG_DIR=/sandbox/xdg/config/opencode \
  -e OMO_PROFILE=gabo \
  omo-dev bun -e '
    import fs from "node:fs";
    import { validatePluginConfig } from "./packages/omo-opencode/src/config/validate.ts";
    const result = validatePluginConfig("/sandbox/project");
    const contract = result.config.agents?.sisyphus?.prompt_append;
    if (!result.valid || result.config.agent_definitions?.length || result.config.agents?.juez) process.exit(1);
    if (contract !== "file:///sandbox/home/.omo/opencode/prompts/sisyphus-orchestration.md") process.exit(1);
    const judge = JSON.parse(fs.readFileSync("./profiles/gabo/opencode/agents/judge.v2.json", "utf8"));
    if (judge.mode !== "primary" || judge.permission?.edit !== "deny" || judge.permission?.task !== "ask") process.exit(1);
  '

if find "$sandbox/xdg/config/opencode" -type f -name '*token*' -o -name '*credential*' | grep -q .; then
  echo "Unexpected credential-like file inside isolated configuration" >&2
  exit 1
fi

echo "Oh My Rigel V2 isolated smoke passed: $version (profile contract and portable Judge source verified)"
