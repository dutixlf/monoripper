#!/usr/bin/env bash
# Approved solo landing workflow. Run from a clean feature branch after user authorization.
# Preserves commits, supports an absent remote main, and never force-pushes or deletes refs.
set -euo pipefail

deny() { printf 'Landing refused: %s\n' "$*" >&2; exit 1; }
feature=${1:-}
[ "$#" -eq 1 ] && [ -n "$feature" ] || deny 'usage: bash scripts/land-branch.sh <feature-branch>'
git check-ref-format --branch "$feature" >/dev/null
[[ "$feature" != main && "$feature" != master ]] || deny 'source must be a feature branch'
cd "$(git rev-parse --show-toplevel)"
[ "$(git branch --show-current)" = "$feature" ] || deny 'check out the source feature branch first'
[ -z "$(git status --porcelain)" ] || deny 'commit or remove working-tree changes first'
tip=$(git rev-parse HEAD)
origin=$(git remote get-url origin)
[ "$(git remote get-url --push --all origin)" = "$origin" ] || deny 'origin must have one push URL matching its fetch URL'

remote_main() {
  git ls-remote --heads origin refs/heads/main | awk '$2 == "refs/heads/main" { print $1 }'
}
remote_tip=$(remote_main)
if [ -n "$remote_tip" ]; then
  git fetch --no-tags origin refs/heads/main
  git merge-base --is-ancestor FETCH_HEAD "$tip" || deny 'remote main is not an ancestor of the source; integrate it first'
fi
if git show-ref --verify --quiet refs/heads/main; then
  git merge-base --is-ancestor refs/heads/main "$tip" || deny 'local main would not fast-forward'
fi

# No skip flag: checks must succeed before the protected-branch exception is enabled.
bun run typecheck
bun test tests
bun run test:package
bun run check:specs
bun run test:landing
git diff --check
[ "$(git branch --show-current)" = "$feature" ] && [ "$(git rev-parse HEAD)" = "$tip" ] || deny 'source changed during verification'
[ -z "$(git status --porcelain)" ] || deny 'verification changed the working tree'
[ "$(git remote get-url origin)" = "$origin" ] && [ "$(git remote get-url --push --all origin)" = "$origin" ] || deny 'origin changed during verification'

# The Git guard permits protected pushes only within this authorized landing workflow.
export GIT_BIGPOWERS_LAND=1
if git show-ref --verify --quiet refs/heads/main; then
  git switch main
  git merge --ff-only "$tip"
else
  git switch -c main "$tip"
fi
# Pin both updates to the verified commit; concurrent remote changes reject the whole push.
git push --atomic origin "$tip:refs/heads/main" "$tip:refs/heads/$feature"
published=$(remote_main)
[ "$published" = "$tip" ] || deny 'remote main does not match the verified commit after push'
git branch --set-upstream-to=origin/main main
printf 'Landed %s on main: %s\n' "$feature" "$tip"
