# Landing workflow verification

Context: user-authorized setup of the approved protected-branch landing workflow.
Source checkpoint: `ea705ff`. Target: `main`. Runtime behavior is unchanged.

## Implementation and review

`scripts/land-branch.sh` requires a clean feature branch and matching origin fetch/push URLs.
Both existing main refs must be ancestors of the verified source commit.
An absent remote main is allowed; an unreadable remote is not.

Typecheck, runtime tests, package smoke, specs validation and landing regressions must pass.
There is no skip-check flag. The source commit, working tree and origin are checked again.
Only then does the workflow enable its scoped Git-guard landing exception.
It performs a local fast-forward and a normal atomic push pinned to the verified commit.
The final remote main SHA must match. History and source refs are retained, including on failure.
No guard configuration, force push, reset, dependency or application API changes are included.

## Regression results

`bun run test:landing`: **11 passed** in disposable local repositories.
Verification commands use a test-only Bun stub in those repositories; actual project checks
run separately and again during the real landing invocation.

- Bootstrap without remote main; existing main; main upstream set.
- Dirty input tree; failed verification; tree modified by verification.
- Divergent local main; divergent remote main; both preserved.
- Different push destination; unreadable origin; both refused.
- Conflicting remote feature ref rejects the whole atomic push without advancing main.
- Server-rejected push preserves all commits and leaves origin unchanged.

`bash -n scripts/land-branch.sh scripts/test-land-branch.sh`: passed.
The retired external PostgreSQL harness passed again: PostgreSQL 18,
12 migrations, full backend CRUD and gRPC scale/recovery/restore/disable.
This is historical evidence. The current replacement command is `bun run test:elysia:postgres`.

Application regression evidence remains in [pre-main-verify.yaml](pre-main-verify.yaml).
Landing does not publish npm packages, deploy applications or claim CI success.
User UAT and container testing remain pending.
