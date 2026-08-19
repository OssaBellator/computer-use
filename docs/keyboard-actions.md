# Verified keyboard actions

`press-key` is the task runtime's first-class keyboard action for focus traversal, dismissal, directional navigation, and static shortcuts. It is separate from semantic `activate`: a key press may change focus or widget state without activating the focused element.

## Static action boundary

The key/chord is compiled into `TaskProgram` as a literal string:

```ts
{
  id: 'advance-focus',
  kind: 'press-key',
  key: 'Tab',
  next: 'check-focus',
  onFailure: 'failed',
}
```

Unlike typed text, prompt responses, navigation URLs, or upload paths, a `press-key` step does not accept `ProgramText` or task-input indirection. Runtime browser content therefore cannot turn page text into a shortcut or invent a new key command.

## Verification semantics

`KeyboardActionController` snapshots semantic browser state, dispatches the key through the configured `BrowserInput`, then uses the shared bounded observation settler. The action is `verified` only when the semantic snapshot changes.

Focus transitions count as evidence for keyboard actions, which is intentionally different from semantic activation: focusing a button is not proof that the button was activated, but moving focus after `Tab` is exactly the expected observable effect of a keyboard navigation command.

If the browser snapshot remains unchanged, the result is `unverified`. Task execution follows only the predeclared `onFailure` edge; dispatch completion is never upgraded into success.

The observation options are bounded per step with `timeoutMs`, `maxSamples`, and `pollIntervalMs`. The shared settler also preserves its bounded transient-context retry behavior across navigation/reload churn.

## Risk and approval

`press-key` defaults to normal `interaction` risk. Programs can mark a shortcut as `external-side-effect` or set `requiresApproval` when the key is expected to submit, purchase, send, or otherwise cross an irreversible boundary.

The runtime trace records the step ID, action kind/status, observation fingerprints, and progress metadata. The actual key/chord string is not copied into trace entries.

## Engine surfaces

`InteractionEngine.pressKey()` exposes the verified primitive directly and `CdpBrowserAgentEngine` delegates to it. Multi-page delegation can fail closed when no active semantic page exists.

## Regression coverage

Unit regressions cover verified focus movement, unchanged-state failure, empty-key rejection, static task execution, trace redaction, missing-controller recovery, and invalid observation budgets. The Chromium regression starts with a real input focused, runs a static `Tab` task through the pure-CDP interaction engine, requires a semantic focus assertion on the next button, and verifies the browser's actual `document.activeElement`.
