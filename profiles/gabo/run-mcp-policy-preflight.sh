#!/usr/bin/env bash
# Validates portable MCP ownership and boots V2 without importing external MCP
# accounts, credentials, targets, or duplicated singleton definitions.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node "$root/profiles/gabo/validate-profile.mjs"
bash "$root/profiles/gabo/run-v2-isolated.sh"
echo "Oh My Rigel MCP policy preflight passed"
