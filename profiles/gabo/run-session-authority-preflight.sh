#!/usr/bin/env bash
# Ensures the profile preserves external Goal/Context Mode root authority while
# retaining OmO's delegated-session continuation mechanics.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

node "$root/profiles/gabo/validate-profile.mjs"

docker run --rm \
  -v "$root:/workspace" \
  -w /workspace \
  omo-dev bun test \
  packages/omo-opencode/src/config/validate-pipeline.test.ts \
  packages/omo-opencode/src/plugin/default-mode-priority.test.ts \
  packages/omo-opencode/src/hooks/compaction-todo-preserver/index.test.ts \
  packages/omo-opencode/src/tools/delegate-task/background-continuation.test.ts \
  packages/omo-opencode/src/tools/delegate-task/sync-continuation.test.ts

echo "Oh My Rigel session-authority preflight passed"
