#!/usr/bin/env bash
# Ensures the Gabo profile owns the Goal internally: the native Goal is enabled,
# the retired external `@prevalentware/opencode-goal-plugin` and its state/cache
# stay absent, and OmO's delegated-child continuation is retained.
#
# No Docker. Docker and every container-based runner are prohibited for this
# project; the previous container-based form of this preflight was historical and
# is intentionally replaced.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

# The profile must declare internal Goal ownership. validate-profile fails if a
# profile artifact reverts to the external (goal disabled) shape.
node "$root/profiles/gabo/validate-profile.mjs"

# Goal ownership gate: the checked home must resolve to the internal mode, which
# requires the external plugin/state/cache absent and `goal.enabled === true`.
goal_mode="$(node "$root/profiles/gabo/lab-goal-gate.mjs" --mode "$HOME")"
if [ "$goal_mode" != "internal" ]; then
  echo "session-authority preflight failed: goal mode is '$goal_mode', expected 'internal'" >&2
  exit 1
fi

# Behavior of record for the internal Goal command and the stop-continuation
# goal clear (fails if the object-vs-text command-shape regression returns).
bun test \
  "$root/profiles/gabo/opencode/tools/goal.tools.test.mjs" \
  "$root/profiles/gabo/opencode/rigel-v2-native-conditional-tools.test.mjs" \
  "$root/profiles/gabo/opencode/rigel-v2-native-runtime.test.mjs"

echo "Oh My Rigel session-authority preflight passed"
