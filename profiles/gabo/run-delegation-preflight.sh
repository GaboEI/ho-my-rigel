#!/usr/bin/env bash
# Verifies the real OmO delegation engine and the Gabo profile without loading
# any user configuration, credentials, or provider account.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required for the delegation preflight" >&2
  exit 2
}

node "$root/profiles/gabo/validate-profile.mjs"
bash "$root/profiles/gabo/run-v2-isolated.sh"

docker run --rm \
  -v "$root:/workspace" \
  -w /workspace \
  omo-dev bun test \
  packages/omo-opencode/src/tools/delegate-task/background-task.test.ts \
  packages/omo-opencode/src/tools/delegate-task/sync-session-lifecycle.test.ts \
  packages/omo-opencode/src/tools/delegate-task/sync-prompt-route.test.ts

echo "Oh My Rigel delegation preflight passed"
