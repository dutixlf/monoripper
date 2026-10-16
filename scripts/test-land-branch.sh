#!/usr/bin/env bash
# Exercise only disposable local Git repositories, never the project's origin.
set -euo pipefail
land="$(cd "$(dirname "$0")" && pwd)/land-branch.sh"
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT
unset GIT_BIGPOWERS_LAND
mkdir "$sandbox/bin"
printf '%s\n' '#!/usr/bin/env bash' 'echo "$*" >> "$LAND_TEST_VERIFY_LOG"' 'if [ "${LAND_TEST_DIRTY:-0}" = 1 ]; then echo changed >> content; fi' '[ "${LAND_TEST_VERIFY_FAIL:-0}" = 0 ]' > "$sandbox/bin/bun"
chmod +x "$sandbox/bin/bun"
export PATH="$sandbox/bin:$PATH"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

setup() {
  case_name=$1
  work="$sandbox/$case_name"
  remote="$sandbox/$case_name.git"
  git init -q --bare --initial-branch=main "$remote"
  git init -q --initial-branch=main "$work"
  cd "$work"
  git config user.name 'Landing fixture'
  git config user.email 'landing@example.invalid'
  git config commit.gpgsign false
  printf 'base\n' > content
  git add content
  git commit -qm 'chore: establish fixture'
  base=$(git rev-parse HEAD)
  git remote add origin "$remote"
  if [ "${2:-existing}" = existing ]; then git push -q origin main; fi
  git switch -qc feature/test
  printf 'feature\n' >> content
  git commit -qam 'feat: add fixture change'
  tip=$(git rev-parse HEAD)
  export LAND_TEST_VERIFY_LOG="$sandbox/$case_name.verify"
  unset LAND_TEST_VERIFY_FAIL LAND_TEST_DIRTY
}
run_land() { bash "$land" feature/test > "$sandbox/$case_name.output" 2>&1; }
remote_sha() { git --git-dir="$remote" rev-parse refs/heads/main; }
reject_before_switch() {
  if run_land; then fail "$case_name unexpectedly succeeded"; fi
  [ "$(git branch --show-current)" = feature/test ] || fail "$case_name switched branches"
  [ "$(remote_sha)" = "$base" ] || fail "$case_name changed remote main"
}

for mode in bootstrap existing; do
  setup "$mode" "$mode"
  if ! run_land; then grep . "$sandbox/$case_name.output" >&2; fail "$mode failed"; fi
  [ "$(remote_sha)" = "$tip" ] || fail "$mode did not publish the verified commit"
  [ "$(git rev-parse 'main@{upstream}')" = "$tip" ] || fail "$mode did not set main upstream"
  [ "$(git rev-parse feature/test)" = "$tip" ] || fail "$mode lost the source branch"
  [ "$(wc -l < "$LAND_TEST_VERIFY_LOG")" -eq 5 ] || fail "$mode skipped verification"
  printf 'PASS: %s fast-forward landing\n' "$mode"
done

setup dirty
printf 'dirty\n' >> content
reject_before_switch
[ ! -e "$LAND_TEST_VERIFY_LOG" ] || fail 'dirty tree reached verification'
echo 'PASS: dirty working tree refused'

setup failed-check
export LAND_TEST_VERIFY_FAIL=1
reject_before_switch
echo 'PASS: failing verification refused'

setup changed-by-check
export LAND_TEST_DIRTY=1
reject_before_switch
echo 'PASS: verification cannot publish a modified working tree'

setup local-divergence
git switch -q main
printf 'local main\n' > local-only
git add local-only
git commit -qm 'chore: advance local main'
local_tip=$(git rev-parse HEAD)
git switch -q feature/test
reject_before_switch
[ "$(git rev-parse main)" = "$local_tip" ] || fail 'divergent local main was rewritten'
echo 'PASS: divergent local main preserved'

setup remote-divergence
git clone -q "$remote" "$sandbox/actor"
printf 'remote main\n' > "$sandbox/actor/remote-only"
git -C "$sandbox/actor" add remote-only
git -C "$sandbox/actor" -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -qm 'chore: advance remote main'
git -C "$sandbox/actor" push -q origin main
advanced=$(remote_sha)
if run_land; then fail 'divergent remote main unexpectedly succeeded'; fi
[ "$(remote_sha)" = "$advanced" ] || fail 'divergent remote main was rewritten'
[ "$(git branch --show-current)" = feature/test ] || fail 'remote divergence switched branches'
echo 'PASS: divergent remote main preserved'

setup different-push-url
git remote set-url --push origin "$sandbox/unexpected.git"
reject_before_switch
[ ! -e "$LAND_TEST_VERIFY_LOG" ] || fail 'different push destination reached verification'
echo 'PASS: unexpected push destination refused'

setup missing-remote
git remote set-url origin "$sandbox/does-not-exist.git"
reject_before_switch
[ ! -e "$LAND_TEST_VERIFY_LOG" ] || fail 'unreadable remote treated as an absent branch'
echo 'PASS: remote lookup failure fails closed'

setup stale-feature
git clone -q "$remote" "$sandbox/other-actor"
printf 'other feature\n' > "$sandbox/other-actor/other-only"
git -C "$sandbox/other-actor" add other-only
git -C "$sandbox/other-actor" -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -qm 'feat: independent change'
git -C "$sandbox/other-actor" push -q origin HEAD:refs/heads/feature/test
if run_land; then fail 'conflicting source branch unexpectedly succeeded'; fi
[ "$(remote_sha)" = "$base" ] || fail 'atomic push partially updated main'
echo 'PASS: feature branch conflict atomically prevents updating main'

setup rejected-push
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$remote/hooks/pre-receive"
chmod +x "$remote/hooks/pre-receive"
if run_land; then fail 'rejected push unexpectedly succeeded'; fi
[ "$(remote_sha)" = "$base" ] || fail 'rejected push changed remote main'
if git --git-dir="$remote" show-ref --verify --quiet refs/heads/feature/test; then fail 'rejected atomic push partially updated origin'; fi
[ "$(git rev-parse feature/test)" = "$tip" ] || fail 'rejected push lost the verified commit'
echo 'PASS: rejected atomic push retains all commits and leaves origin unchanged'
