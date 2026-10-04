#!/usr/bin/env bash
# Creates a disposable review worktree from a named upstream revision. It never
# changes the caller's checkout, active OpenCode config, accounts, or sessions.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
upstream_remote="${RIGEL_UPSTREAM_REMOTE:-upstream}"
upstream_ref="${RIGEL_UPSTREAM_REF:-dev}"
timestamp="$(date +%Y%m%d-%H%M%S)"
review_branch="rigel/upstream-review-$timestamp"
review_root="${RIGEL_REVIEW_ROOT:-$root/../oh-my-rigel-upstream-review-$timestamp}"

git -C "$root" diff --quiet && git -C "$root" diff --cached --quiet || {
  echo "Refusing upstream review: the current checkout has uncommitted changes" >&2
  exit 2
}
git -C "$root" remote get-url "$upstream_remote" >/dev/null || {
  echo "Missing upstream remote '$upstream_remote'. Add the original OmO repository under that name first." >&2
  exit 2
}

git -C "$root" fetch "$upstream_remote" "$upstream_ref"
git -C "$root" worktree add -b "$review_branch" "$review_root" HEAD
git -C "$review_root" merge --no-commit --no-ff "$upstream_remote/$upstream_ref" || {
  echo "Upstream conflicts are contained in $review_root. Resolve there; the primary checkout is unchanged." >&2
  exit 1
}

echo "Review worktree ready: $review_root"
echo "Run: bash profiles/gabo/run-all-isolated.sh"
echo "If it is accepted, commit the merge in this worktree and inspect it before merging that commit into the maintained Rigel branch."
