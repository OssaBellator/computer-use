# Resilient observation settling

Cross-document browser actions can temporarily destroy JavaScript execution contexts while Chromium commits a new document. A browser agent should tolerate that transient observation gap, but it must not reinterpret missing evidence as success.

`waitForObservation()` therefore has a bounded consecutive snapshot-error budget. By default it tolerates up to three consecutive provider failures while continuing to poll for an observable state transition.

```ts
const result = await waitForObservation(
  () => observer.snapshot(),
  before,
  expectedTransition,
  {
    maxConsecutiveErrors: 3,
    timeoutMs: 1000,
  },
);
```

The result reports both `observationErrors` and `errorBudgetExhausted`. If the error budget is exhausted, the settler returns the latest known state with `matched: false`; it never upgrades an observation failure into a verified action.

This behavior benefits the existing semantic action controllers automatically because they already use `waitForObservation()` for activation, focus, and value-change verification.

## Regression coverage

Unit regressions cover recovery after transient errors and fail-closed error-budget exhaustion. The Chromium regression captures a real default execution context, reloads the page, waits for Chromium to destroy that context, deliberately evaluates against the stale context to produce an actual CDP protocol failure, and verifies that settling recovers and observes the new document identity.
