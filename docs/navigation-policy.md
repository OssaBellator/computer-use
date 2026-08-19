# Navigation containment policy

`CdpNavigationController` enforces explicit top-level navigation policy, while `CdpNavigationGuard` can enforce the same boundary on **page-initiated document requests** such as link clicks, form submissions, and iframe document loads.

```ts
const engine = createCdpBrowserAgentEngine(page, session, {
  navigationPolicy: {
    allowedOrigins: ['https://app.example.com', 'https://id.example.com'],
    allowHttp: false,
  },
});
```

When `navigationPolicy` is supplied and the CDP session supports events, `createCdpBrowserAgentEngine()` enables request-boundary enforcement by default. Set `enforceNavigationPolicyAtRequestBoundary: false` only when an embedding environment already provides equivalent containment.

## Explicit navigation checks

Policy is checked twice for `navigate()`: before `Page.navigate` and again against the observed final URL after navigation commits. The second check catches redirects that escape the requested allowlisted origin.

The same preflight/final policy is also used for history traversal and engine-created page targets.

## Page-initiated document requests

`CdpNavigationGuard` enables the CDP `Fetch` domain with a `Document` request pattern. Every paused document request is checked before network dispatch:

- allowed destinations receive `Fetch.continueRequest`;
- blocked or malformed destinations receive `Fetch.failRequest` with `BlockedByClient`;
- all document frames are covered by the configured policy, not only calls made through `engine.navigate()`; and
- unexpected non-document pauses are continued defensively rather than applying document policy to them.

The guard retains only counters and a monotonic blocked-event sequence. Destination URLs and policy-reason strings are not stored in guard state.

This closes the common gap where semantic activation of an `<a>` or submit button could otherwise navigate outside the allowlist even though direct `navigate()` calls were contained.

## Defaults

Defaults are intentionally conservative:

- `http:` and `https:` are allowed unless disabled;
- `about:` is allowed unless disabled;
- `data:` is blocked unless explicitly enabled;
- unsupported schemes such as `javascript:` and `file:` are blocked;
- usernames/passwords embedded in URLs are blocked unless explicitly enabled;
- when `allowedOrigins` is configured, entries must be exact HTTP(S) origins and both requested and final origins must match.

A policy failure returns `policy-blocked` for explicit navigation and never counts as a successful task navigation. Preflight failures do not dispatch `Page.navigate`. A redirect discovered only after commit is reported as blocked so the surrounding task can stop or follow a fixed recovery edge; the controller does not silently invent a new destination.

## Validation note

Request-boundary behavior has deterministic protocol regressions covering allowed, blocked, malformed, non-document, disposal, and factory-wiring paths. In the current development container, Chromium administrator policy rejects HTTP(S) requests before `Fetch.requestPaused` is emitted, so a real-network Fetch interception smoke cannot be run there. The existing opt-in `npm run test:live` remains the path for unrestricted developer machines.
