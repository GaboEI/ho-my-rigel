#!/usr/bin/env bash
# Complete non-account acceptance suite for the portable Gabo profile.
#
# Layers:
#   1. Bun unit tests for the native V2 runtime modules.
#   2. Isolated V2 QA contracts (each spawns the real V2 lab binary with a
#      temporary HOME/XDG sandbox and a deterministic fake provider).
#   3. Docker lab runners (opt-in via RIGEL_SUITE_DOCKER=1; skipped with a
#      declared reason otherwise).
#
# Output: one status line per step plus a final summary; exits non-zero when
# any executed step fails. Never runs the quarantined attic/ surface.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
suite_dir="$root/profiles/gabo"
results=()
failed=0

declare_status() {
  results+=("$1: $2")
  case "$2" in
    PASS|SKIP*) ;;
    *) failed=$((failed + 1)) ;;
  esac
}

run_step() {
  local name="$1"; shift
  if "$@" > /tmp/opencode/suite-step.log 2>&1; then
    declare_status "$name" PASS
  else
    declare_status "$name" FAIL
    echo "---- $name output (tail) ----" >&2
    tail -15 /tmp/opencode/suite-step.log >&2
  fi
}

run_docker_step() {
  local name="$1"; shift
  if [ "${RIGEL_SUITE_DOCKER:-0}" != "1" ]; then
    declare_status "$name" "SKIP (RIGEL_SUITE_DOCKER!=1; requires Docker)"
    return
  fi
  if ! command -v docker >/dev/null 2>&1; then
    declare_status "$name" "SKIP (docker unavailable)"
    return
  fi
  run_step "$name" "$@"
}

echo "== Ho My Rigel isolated acceptance suite =="
echo "layer 0: isolation proof (protect-opencode-v1)"
proof_dir="$root/.omo/evidence/$(date +%Y%m%d)-rigel-isolation-proof"
mkdir -p "$proof_dir"
if node "$suite_dir/isolation-proof.mjs" > "$proof_dir/isolation.txt" 2>&1; then
  declare_status "isolation proof" PASS
else
  declare_status "isolation proof" FAIL
  echo "Refusing to run any OpenCode process: isolation proof failed. See $proof_dir/isolation.txt" >&2
  printf '%s\n' "${results[@]}"
  exit 1
fi

echo "layer 1: bun unit tests"
run_step "bun: profiles unit tests" bun test "$suite_dir/opencode"

echo "layer 2: isolated V2 contracts (node -> spawns the V2 binary)"
# Boundary note (protect-opencode-v1.md): a node contract launches the V2
# binary as its own subprocess. Replacing HOME/XDG/goal-state is not sufficient
# proof of full isolation for that child (it still resolves real-home skill and
# worktree paths), so these contracts are skipped by default and require an
# explicit opt-in. The container runner in layer 3 is the approved path.
for contract in \
  qa-v2-lab-install-contract.mjs \
  qa-v2-agent-domain.mjs \
  qa-v2-agent-transform-contract.mjs \
  qa-v2-agents-md-contract.mjs \
  qa-v2-compaction-hook-contract.mjs \
  qa-v2-native-delegation.mjs \
  qa-v2-native-prompt-contract.mjs \
  qa-v2-native-rules-injector-contract.mjs \
  qa-v2-native-ultrawork.mjs \
  qa-v2-noninteractive-contract.mjs \
  qa-v2-tool-after-result-contract.mjs \
  qa-v2-tool-before-contract.mjs; do
  if [ "${RIGEL_SUITE_ALLOW_NODE_CONTRACTS:-0}" = "1" ]; then
    run_step "node: $contract" node "$suite_dir/$contract"
  else
    declare_status "node: $contract" "SKIP (RIGEL_SUITE_ALLOW_NODE_CONTRACTS!=1; node-spawned V2 child cannot be proven fully isolated, use the container runner)"
  fi
done

echo "layer 3: docker lab runners"
run_docker_step "bash: run-v2-isolated.sh" bash "$suite_dir/run-v2-isolated.sh"
run_docker_step "bash: run-delegation-preflight.sh" bash "$suite_dir/run-delegation-preflight.sh"
run_docker_step "bash: run-session-authority-preflight.sh" bash "$suite_dir/run-session-authority-preflight.sh"
run_docker_step "bash: run-mcp-policy-preflight.sh" bash "$suite_dir/run-mcp-policy-preflight.sh"
run_docker_step "bash: run-delegation-e2e.sh" bash "$suite_dir/run-delegation-e2e.sh"

echo "== Summary =="
printf '%s\n' "${results[@]}"
if [ "$failed" -gt 0 ]; then
  echo "suite FAILED: $failed step(s)"
  exit 1
fi
echo "Ho My Rigel complete isolated acceptance suite passed"