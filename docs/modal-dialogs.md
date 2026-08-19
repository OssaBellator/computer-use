# Modal dialog control

`CdpDialogController` adds an event-backed observation channel for JavaScript `alert`, `confirm`, `prompt`, and `beforeunload` dialogs.

This is intentionally separate from DOM/runtime observation. An open JavaScript modal can block normal page evaluation and semantic snapshotting; task execution can therefore continue using dialog state even when those channels are unavailable.

## Security boundary

The dialog controller deliberately discards page-provided `message` and `defaultPrompt` text. Task-visible dialog state contains only:

- whether a dialog is open,
- the dialog type, and
- a monotonic sequence number used for progress detection.

This prevents arbitrary dialog prose from becoming an action payload or free-form branch input. Prompt responses must come from a literal `ProgramText` or a declared trusted task input, just like typed text and navigation destinations.

```ts
{
  id: 'answer-confirmation',
  kind: 'handle-dialog',
  accept: true,
  promptText: { input: 'trustedAnswer' },
  next: 'continue',
  onFailure: 'failed',
}
```

Predicates can branch only on declared structural state:

```ts
{
  kind: 'dialog',
  state: { open: true, type: 'prompt' },
}
```

`TaskRuntime` treats semantic snapshots, browser state, and dialog events as independent observation channels. If a modal blocks DOM/runtime access, a predeclared `handle-dialog` or recovery path can still execute.

## Local regression coverage

Run normal local tests plus Chromium smoke tests:

```bash
npm run typecheck
npm test
npm run test:chromium
```

The Chromium suite opens a real `prompt()`, observes it through `Page.javascriptDialogOpening`, supplies a trusted response through `Page.handleJavaScriptDialog`, resumes execution, and verifies that neither the page-supplied prompt message nor the trusted response is written into task traces.
