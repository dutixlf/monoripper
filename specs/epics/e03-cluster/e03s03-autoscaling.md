# e03s03 — Bounded autoscaling

## 1. Purpose
Adjust a context's replica count to measured load within operator limits.

## 2. User story
As an operator, I set `min`, `max` and `targetInFlight`; the context grows under load and shrinks after a quiet window.

## 3. Status and complexity
Implemented, automated checks passing, user UAT pending. 5 BCP, P1 risk from oscillation and conflicts with manual changes.

## 4. Dependencies
e01s02 operations, e03s02 capacity.

## 5. Inputs
`SetAutoscale(context, policy?)`, `autoscale` timing config, gateway in-flight samples.

## 6. Outputs
Operations with `origin: autoscaler`; `status.contexts[].autoscale`.

## 7. ADDED requirements
- Scale-up uses the average in-flight load over `upWindowMs`; scale-down uses the peak over the longer `downWindowMs`.
- Changes wait for `cooldownMs`, move at most `maxStep`, stay within min/max and available node capacity.
- Stale or too-short sample windows and contexts with an active operation hold the count.
- Manual scaling is rejected with `AUTOSCALE_ACTIVE` while a policy exists; deployments keep the count.
- Decisions use ordinary SetContext operations; finished autoscaler operations are pruned to the latest 100.

## 8. Invariants
The total in-flight load per context does not depend on the replica count, so the estimate is stable.

## 9. Startup interface
`autoscale: { intervalMs = 1000, upWindowMs = 10000, downWindowMs = 60000, cooldownMs = 30000, maxStep = 2 }`; CLI `autoscale --context --min --max --target-in-flight | --disable`.

## 10. Storage
Policies persist in state `autoscale`; samples do not.

## 11. Separation rationale
A pure `decide` function with an injected clock keeps decisions deterministic and testable.

## 12. Errors
`AUTOSCALE_ACTIVE`, `INVALID_ARGUMENT` for invalid policies.

## 13. Security
SetAutoscale requires the control credential like SetContext.

## 14. Compatibility
Policies require 1 ≤ min ≤ max ≤ 64; scale-from-zero is not supported because the metric needs a serving replica.

## 15. Implementation steps
1. Decision function and loop with a fake clock → verify: `bun test tests/unit/autoscale.test.ts`.
2. Synthetic load end to end → verify: `bun test tests/e2e/autoscale.test.ts`.

## 16. Test data
`tests/fixtures/autoscale/slow.ts` with a configurable delay.

## 17. Acceptance criteria
- Fake-clock tests are deterministic: holds, cooldown, step, capacity, hysteresis and bounds.
- Ten concurrent clients raise a policy of max 3 to exactly 3 replicas and never above; a quiet window returns to 1.
- Manual scaling is rejected while the policy exists and works after disabling it.

## 18. Manual demonstration
Set a policy with the CLI on `examples/local`, run a load loop and watch `status`.

## 19. Out of scope
CPU or latency metrics, predictive scaling, scale-to-zero, cloud provisioning.

## 20. Gate and handoff
All entrypoints pass. Evidence: [e03-verify.yaml](../../verifications/e03-verify.yaml). User UAT pending.
