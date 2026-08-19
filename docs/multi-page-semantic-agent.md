# Multi-page semantic CDP agent

`MultiPageCdpAgent` composes browser-root target discovery, flattened CDP session routing, and the pure-CDP semantic engine into a real multi-tab controller. It switches the **active semantic engine**, not merely the browser's visible target.

## State boundary

The cross-tab controller retains only:

- target IDs;
- target type/attachment/opener/sequence from `CdpTargetController`;
- which targets currently have routed semantic engines; and
- the active target ID.

Page URLs, titles, DOM text, and form values stay inside each per-page engine. `MultiPageCdpAgentSummary` contains counts and target IDs only.

## Switching

`switchTo(targetId)`:

1. refreshes/starts root target discovery;
2. rejects unknown or non-page targets;
3. lazily attaches a flattened `RoutedCdpSession` if the page has no engine yet;
4. builds a `CdpBrowserAgentEngine` with `createPureCdpBrowserAgentEngine()`;
5. prepares that page's dialog/target/download/upload controllers;
6. activates the browser target with `Target.activateTarget`; and
7. makes that per-page semantic engine active.

A repeated switch reuses the existing routed session/engine instead of rebuilding perception state.

Convenience methods include `switchToLatestPage()`, `switchToLatestUnattachedPage()`, and `createAndSwitch(url)`. Creation uses the same navigation policy supplied to the page engines, so a blocked origin is rejected before `Target.createTarget`.

## Lifecycle

- `detachPage(targetId)` removes only the routed semantic session; the browser page remains open.
- `closePage(targetId)` detaches the semantic session first, then explicitly closes the target.
- `shutdown()` detaches every managed page session and disposes root target monitoring.

The controller does not own the underlying browser-root transport, so shutdown does not close a connection that may be shared by other components.

## Task-program integration

`MultiPageTaskEngine` adapts the multi-page controller to `TaskRuntimeEngine`. Importantly, it can start with **no active page**: `refresh()` yields no semantic nodes while `targetState()` still exposes root target topology. This lets a compiled task begin with a bounded page-selection step.

`switch-page` has only two static selectors:

- `latest-page`
- `latest-unattached-page`

Browser/page content cannot synthesize a target ID, URL, title, or arbitrary tab-selection command at runtime.

```ts
const pages = new MultiPageCdpAgent(router);
const runtime = new TaskRuntime(new MultiPageTaskEngine(pages));

const result = await runtime.run({
  version: 1,
  entry: 'popup',
  steps: [
    {
      id: 'popup',
      kind: 'switch-page',
      target: 'latest-unattached-page',
      next: 'check',
      onFailure: 'failed',
    },
    {
      id: 'check',
      kind: 'assert',
      condition: { kind: 'exists', target: { role: 'button', name: 'Continue' } },
      next: 'done',
      onFailure: 'failed',
    },
    { id: 'done', kind: 'complete' },
    { id: 'failed', kind: 'fail' },
  ],
});
```

A successful switch records `page-switched`, the selected target ID, action status, and observation fingerprints. Page text and page URLs are not copied into the trace.

## Example

```ts
const router = new CdpTargetSessionRouter(browserConnection);
const pages = new MultiPageCdpAgent(router, {
  navigationPolicy: { allowedOrigins: ['https://app.example'] },
});

await pages.start();
await pages.switchToLatestPage();

const engine = pages.activeEngine;
await engine?.activate({ role: 'button', name: 'Continue' });
```

## Regression coverage

Unit regressions cover lazy attach, engine reuse, non-page rejection, metadata redaction, policy-checked create-and-switch, detach-before-close, active-state cleanup, task observation before any page is active, static page-selection modes, missing-switch failure, and active-engine delegation. Chromium regressions seed two real tabs with different semantic controls, switch between their routed pure-CDP engines, and exercise a `TaskRuntime` program that starts with no active page, switches to the newest page, verifies a semantic control there, and completes without copying that control text into its trace.
