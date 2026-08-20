# Bounded verified viewport scrolling

Long documents, virtualized lists, and infinite feeds often require explicit scrolling even when no semantic target is known yet. `scroll-viewport` provides a static, bounded top-level wheel action with browser-state verification.

## Static task action

```ts
{
  id: 'next-screen',
  kind: 'scroll-viewport',
  deltaY: 600,
  timeoutMs: 1000,
  maxSamples: 40,
  pollIntervalMs: 10,
  next: 'inspect',
  onFailure: 'failed',
}
```

`deltaX` and `deltaY` are program literals. They cannot come from page content or trusted text inputs. At least one axis must be non-zero, both values must be finite, and each axis is capped to ±4000 CSS pixels.

## Safe wheel routing

Wheel input is not dispatched blindly at the current cursor. The controller uses the existing viewport wheel-routing logic to choose a deterministic point outside visible independently scrollable semantic scopes. This prevents a page-level scroll command from being silently captured by an unrelated nested panel.

The pointer is moved to that safe anchor before wheel dispatch. Pointer travel can itself trigger hover/layout changes, so the controller immediately captures a new semantic baseline. It then revalidates the wheel anchor once against the post-travel state before scrolling.

## Verification

Successful `Input.dispatchMouseEvent(mouseWheel)` completion is not sufficient. The scroll is `verified` only when observation shows scroll-compatible evidence:

- stable semantic nodes move in main-viewport geometry;
- viewport visibility changes; or
- semantic nodes are added/removed, as with an infinite feed.

Focus churn, unrelated value changes, and wheel dispatch completion do not independently verify scrolling. If no evidence is observed within the bounded settling budget, the action returns `unverified`.

## Task progress

Task fingerprints intentionally omit raw node coordinates to avoid animation/layout noise. A geometry-only scroll can therefore be legitimately verified while the task fingerprint remains stable. `TaskRuntime` treats a verified `scroll-viewport` result as progress for the no-progress guard without changing fingerprint semantics for other steps.

## Failure boundaries

The controller fails before wheel dispatch when:

- viewport observation is unavailable;
- the delta is zero, non-finite, or exceeds the configured ceiling; or
- no safe viewport wheel anchor can be found outside visible nested scroll scopes.

The task step participates in ordinary `interaction` risk/approval policy and can only follow its compiled `next` or `onFailure` edge.

## Multi-page behavior

`MultiPageTaskEngine` delegates scrolling to the active semantic page. When no page is selected, `scrollViewport()` returns `unverified`, allowing the static task recovery path to decide what happens next.

## Regression coverage

Unit regressions cover geometry-verified movement, safe routing around a nested scroll panel, invalid command rejection, task option forwarding, five consecutive geometry-only scrolls without false stalling, missing-controller recovery, static budget validation, and multi-page delegation. The real Chromium task regression scrolls a long page with actual CDP wheel input and verifies that the browser's `scrollY` advances.
