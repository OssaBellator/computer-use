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

Unit regressions cover lazy attach, engine reuse, non-page rejection, metadata redaction, policy-checked create-and-switch, detach-before-close, and active-state cleanup. The Chromium regression seeds two real tabs with different semantic controls, switches between their routed pure-CDP engines, and verifies each active engine observes only its own tab's DOM state.
