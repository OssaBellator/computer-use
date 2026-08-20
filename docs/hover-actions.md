# Verified semantic hover actions

Hover-revealed menus, tooltips, previews, and controls are common browser interaction surfaces. A pointer move by itself is not evidence that a hover action succeeded, so `hover` uses the same closed-loop principle as activation, typing, and keyboard actions: dispatch input, then require an observable browser-state transition.

## Static task action

A task can declare a semantic hover target and bounded settling budget:

```ts
{
  id: 'reveal-menu',
  kind: 'hover',
  target: { role: 'button', name: 'More options' },
  timeoutMs: 500,
  maxSamples: 20,
  pollIntervalMs: 5,
  next: 'check-menu',
  onFailure: 'failed',
}
```

The target is compiled into the program. Runtime page content may satisfy semantic resolution, but it cannot invent a new hover action or rewrite the recovery edge.

## Evidence model

`SemanticActionController.hover()` captures a semantic snapshot, resolves a live hit-tested point for the target, moves the pointer with the existing bounded pointer controller, then polls semantic state. The hover is `verified` only when the snapshot contains non-focus evidence such as:

- a semantic node being added or removed;
- a value changing; or
- an observable widget state changing.

Focus-only churn and successful pointer dispatch do not count as hover proof. An unchanged page therefore returns `unverified`.

The controller intentionally does not require the original target point to remain hit-testable after movement. A successful tooltip, flyout, or menu can legitimately render over the original point, so a post-hover hit-test would reject valid outcomes.

If a live target point cannot be obtained, the action fails before pointer movement with `target-point-unavailable`.

## Resolution and visibility

`InteractionEngine.hover()` resolves the semantic target without first acquiring it through pointer planning; pre-hover pointer acquisition could itself trigger the hover and destroy the evidence baseline. Offscreen targets can still use the existing scroll-reveal controller, after which the target is re-resolved before hover dispatch.

Ambiguous targets fail closed when the task runtime's default `requireUnambiguousTargets` policy is enabled.

## Risk and traces

Hover defaults to normal `interaction` risk and participates in the existing approval system. A program can elevate a hover to `external-side-effect` or require explicit approval when merely revealing a UI has sensitive consequences.

Task traces record only the normal step ID, action status, target identity, fingerprints, and progress metadata. Semantic target text is not copied into the trace by the hover action.

## Visual-only hover

Some hover effects are paint-only and produce no semantic DOM/accessibility change. Those remain `unverified` by this primitive rather than being guessed successful. `CdpVisualObserver` provides a separate bounded screenshot/change signal for callers that intentionally need visual evidence.

## Regression coverage

Unit regressions cover semantic overlay appearance, unchanged-state failure, missing target points, static task execution, fixed recovery when hover support is absent, invalid settling budgets, and multi-page delegation. The Chromium regression moves a real CDP pointer onto a button whose `mouseenter` handler reveals another semantic button; the task must observe the new control, assert it exists, and complete without dispatching a click.
