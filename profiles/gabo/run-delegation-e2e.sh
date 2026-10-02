#!/usr/bin/env bash
# Full native OpenCode V2 delegation contract.  The Node runner creates a
# disposable XDG/HOME tree, local deterministic provider, and V2 server; it
# never reads V1 configuration, credentials, accounts, or the active service.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
binary="${RIGEL_V2_BINARY:-$HOME/.opencode/bin/opencode}"

if [ ! -x "$binary" ]; then
  echo "OpenCode V2 is required at RIGEL_V2_BINARY (default: $binary)" >&2
  exit 2
fi
case "$("$binary" --version)" in
  *"v2."*) ;;
  *) echo "Expected OpenCode V2" >&2; exit 2 ;;
esac

exec node "$root/profiles/gabo/qa-v2-native-delegation.mjs"
