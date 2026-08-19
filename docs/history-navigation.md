# Policy-aware browser history and reload

`CdpHistoryController` adds bounded, browser-authoritative back, forward, and reload operations without treating browser history as trusted task input.

## Guarantees

- `back()` and `forward()` read `Page.getNavigationHistory` only to identify the adjacent entry and enforce navigation policy before dispatch.
- History URLs and titles are not retained as controller state and do not need to enter task traces.
- Traversal uses `Page.navigateToHistoryEntry` and succeeds only after browser state proves a URL or document-identity transition.
- `reload()` requires a readable pre-action browser state, policy-checks the current URL, issues `Page.reload`, and verifies a changed `performance.timeOrigin` (or another committed browser transition).
- Both traversal and reload use bounded timeout/poll budgets and tolerate transient execution-context loss during document replacement.
- If there is no adjacent history entry, the controller returns `no-history` without issuing browser input.
- A policy-blocked history destination is rejected before `Page.navigateToHistoryEntry` is sent. Final state is checked again after a transition.

```ts
const history = new CdpHistoryController(session, {
  allowedOrigins: ['https://app.example'],
});

const back = await history.back({ timeoutMs: 5000 });
const reload = await history.reload({ ignoreCache: true });
```

## Task-program integration

History is also a static task action. The action is fixed when the `TaskProgram` is compiled; page content cannot choose a new history command at runtime.

```ts
const program: TaskProgram = {
  version: 1,
  entry: 'recover-back',
  steps: [
    {
      id: 'recover-back',
      kind: 'history',
      action: 'back',
      waitUntil: 'complete',
      next: 'check',
      onFailure: 'failed',
    },
    {
      id: 'check',
      kind: 'assert',
      condition: { kind: 'browser', state: { origin: 'https://app.example' } },
      next: 'done',
      onFailure: 'failed',
    },
    { id: 'done', kind: 'complete' },
    { id: 'failed', kind: 'fail' },
  ],
};
```

The task trace records the step, outcome, action status, and hashed browser-state fingerprints. It does not include the history destination URL/title.

## Local regression coverage

Unit regressions cover back/forward verification, reload identity changes, policy preflight, history boundaries, typed task execution, missing-controller failure, and trace redaction. The Chromium smoke test creates genuine same-document history entries with `history.pushState()`, then exercises real `Page.getNavigationHistory`, `Page.navigateToHistoryEntry`, and `Page.reload` behavior without requiring public network access.
