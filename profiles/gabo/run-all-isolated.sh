#!/usr/bin/env bash
# Complete non-account acceptance suite for the portable Gabo profile.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

bash "$root/profiles/gabo/run-v2-isolated.sh"
bash "$root/profiles/gabo/run-delegation-preflight.sh"
bash "$root/profiles/gabo/run-session-authority-preflight.sh"
bash "$root/profiles/gabo/run-mcp-policy-preflight.sh"

echo "Ho My Rigel complete isolated acceptance suite passed"
