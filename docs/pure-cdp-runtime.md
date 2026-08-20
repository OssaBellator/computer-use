# Pure-CDP semantic frame runtime

The original semantic observer accepts a small `SnapshotPageLike` interface so it can work with Playwright-style frame objects. `CdpRuntimeSnapshotPage` now implements that interface using only a page-target Chrome DevTools Protocol session, removing the external page-object requirement for Chromium deployments.

## Frame model

`CdpRuntimeSnapshotPage.refresh()` reads `Page.getFrameTree` and maintains stable frame adapters in depth-first browser order. Each `CdpRuntimeSnapshotFrame` exposes the metadata the existing identity layer needs:

- frame URL and name;
- parent-frame identity; and
- `evaluate()` for the semantic DOM extractor.

Evaluation does not run in the page's default JavaScript world. The adapter creates a dedicated isolated world with `Page.createIsolatedWorld` for each frame and executes the existing read-only snapshot function there. This works for nested/cross-origin frame contexts without requiring a Playwright/Puppeteer `Frame` object.

## Stale-context recovery

Isolated-world execution contexts are cached while a frame/document remains stable. A frame URL change invalidates the cached world immediately. If Chromium rejects `Runtime.evaluate` because a cached context was destroyed by a same-URL reload or document replacement, the adapter discards that context, creates one new isolated world, and retries once.

Page-function exceptions are not retried; only protocol-level evaluation failure gets the one bounded recovery attempt, avoiding accidental duplicate page-side work.

Detached frames are removed during the next frame-tree refresh.

## Observer integration

`CdpInteractionObserver.snapshot()` now detects an optional `refresh()` method structurally and awaits it before capturing frame descriptors, DOM semantics, CDP identity, and geometry. Existing page wrappers do not need to implement `refresh()` and remain compatible.

Two async convenience factories provide a no-page-object Chromium path:

```ts
const interaction = await createPureCdpInteractionEngine(cdpSession);

const agent = await createPureCdpBrowserAgentEngine(cdpSession, {
  navigationPolicy: { allowedOrigins: ['https://app.example'] },
});
```

The returned engines are the same `InteractionEngine` / `CdpBrowserAgentEngine` classes used by the existing factories; only frame semantic extraction is supplied directly from CDP.

## Regression coverage

Unit regressions cover frame order/parent metadata, isolated-world evaluation, one-shot stale-context recreation, navigation invalidation, and detached-frame cleanup. The Chromium regression creates a real `srcdoc` iframe and proves `snapshotInteractiveDom()` sees semantic controls in both the main document and child frame through pure CDP, then reloads the document and verifies cached-world recovery without a Playwright page object.
