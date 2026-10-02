#!/usr/bin/env bash
# Backward-compatible alias for the complete isolated V2 refresh.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
exec bash "$root/profiles/gabo/apply-v2-runtime-service.sh"
