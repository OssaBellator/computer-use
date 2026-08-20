# Pointer-lock and pointer-capture lifecycle

This feature adds framework-independent foundations for observing and recovering pointer ownership during permitted realtime browser interactions. It extends the existing `BrowserInput.movePointerBy()` and realtime held-input path; it does not replace absolute pointer input, game-region acquisition, renderer lifecycle, or visual tracking.

## Lock state

`PointerLockLifecycle` represents five explicit states:

- `unlocked` — no lock is held and no request is pending.
- `requested` — the caller has initiated the page's normal pointer-lock activation flow.
- `pending` — the request completed without a browser lock/failure observation yet; bounded polling is still in progress.
- `locked` — `document.pointerLockElement` is present.
- `lost` — a previously held/requested lock was invalidated unexpectedly.

A snapshot carries a monotonic lock generation plus the strongest currently observed owner identity. Identity is partial by design and can include target/session/frame ids, the locking element backend node/id/tag, and a verified game-region backend node/generation. `pointerLockOwnerMatches()` compares only fields a caller requires, so a policy can bind relative input to a frame, exact element, renderer generation, or a combination.

Game-region identity is never copied onto a lock merely because a region lease currently exists. `CdpPointerLockObserver` associates `gameRegionBackendNodeId`/`gameRegionGeneration` only when the actual `document.pointerLockElement` backend node equals the current leased game-region backend node. If the renderer lease moves to a different backend node while the browser still reports the old element as pointer-locked, the observation reports a game-region mismatch and the lifecycle transitions to `lost` with `renderer-replaced`. This prevents a refreshed lease from making stale pointer ownership look current.

Loss reasons are explicit: focus loss, Escape, navigation, renderer replacement, target change, element detachment, or unknown loss. `PointerLockController.observe()` detects ordinary locked-to-unlocked transitions and infers focus loss when `document.hasFocus()` is false. It also fails closed on known owner drift while the browser still reports a lock. Controllers that already receive navigation, renderer, target, Escape, focus, or element-detachment signals can call the corresponding `note*()` hook immediately rather than waiting for the next poll.

## Browser-native observation

`CdpPointerLockObserver` uses CDP to evaluate the browser's actual DOM ownership state. When locked, it resolves `document.pointerLockElement` to a CDP backend node so lock state can be associated with stable browser identity. It does not create page-side `MouseEvent`/`PointerEvent` objects or use synthetic `dispatchEvent()` input.

`frameId` is owner metadata; it does not by itself move `Runtime.evaluate` into that frame. For a non-main frame, use the frame's CDP session or supply that frame's `executionContextId` so the observed `document.pointerLockElement` is the intended document.

Pointer capture is observed separately with `Element.hasPointerCapture(pointerId)` on a CDP-resolved backend node. `PointerCaptureLifecycle` distinguishes a normal caller-declared `release(pointerId)` from an unexpected transition to `lost`. A backend node that can no longer be resolved is reported as `element-detached` rather than silently looking like an ordinary uncaptured pointer. Capture is pointer-id-scoped because multiple active pointers can have independent capture ownership.

## Bounded acquisition and recovery

`PointerLockController.acquire()` does not call `requestPointerLock()` itself. The caller supplies a `request()` callback that performs the page's permitted normal activation flow, for example a browser-native click on the game surface. This keeps user-activation/focus/permission rules in the browser rather than bypassing them.

Acquisition is hard bounded:

- at most 4 request attempts;
- at most 32 observations per attempt;
- at most 1 second between observations;
- one attempt by default;
- an optional `shouldRetry()` hook may stop retrying earlier.

There is no unbounded retry loop. A wrong-owner lock is an explicit `identity-mismatch` result and can participate in the same bounded retry policy instead of terminating recovery unconditionally. If a pre-movement observation already proves Pointer Lock unsupported, recovery activation is not invoked. Observation errors propagate rather than being interpreted as permission to send relative input.

A recovery policy can be supplied to `moveRelative()`. Recovery uses the same bounded acquisition primitive and expected owner identity. If a refreshed `CdpGameRegionLease` changes backend identity/generation, a dynamic guard owner makes the next relative command reject stale ownership and invoke only the configured bounded recovery.

## Relative-pointer safety

`PointerLockController.moveRelative()` has three policies:

- `required` (default) — relative input is dispatched only while the observed lock matches the required owner; otherwise `PointerLockRequiredError` is thrown before movement.
- `preferred` — absent/mismatched lock suppresses the relative movement and requires an explicit `onDegraded()` callback. There is no silent fallback to an absolute move.
- `none` — bypass lock checking for bounded interactions that intentionally use ordinary relative coordinate accumulation without pointer lock.

Degradation/error status distinguishes an unsupported browser from an active lock held by the wrong owner. This is diagnostic only: neither case permits relative dispatch under `required` or `preferred` policy.

`guardRelativePointerInput()` preserves the existing `BrowserInput` API and delegates every operation unchanged except `movePointerBy()`, which is routed through the controller. The existing `RealtimeControlLoop` can therefore receive the guarded input without gaining a framework dependency or changing its held-key/button semantics.

Example:

```ts
const observer = new CdpPointerLockObserver(session, {
  frameId,
  gameRegion: () => ({
    backendNodeId: currentLease.region?.backendNodeId,
    generation: currentLease.generation,
  }),
});
const lock = new PointerLockController(input, observer);
const guardedInput = guardRelativePointerInput(input, lock, {
  requirement: 'required',
  owner: () => ({
    frameId,
    gameRegionBackendNodeId: currentLease.region?.backendNodeId,
    gameRegionGeneration: currentLease.generation,
  }),
  recovery: {
    request: async () => activateGameSurfaceWithBrowserInput(),
    maxAttempts: 2,
    pollsPerAttempt: 8,
  },
});

const loop = new RealtimeControlLoop(guardedInput, options);
```

The recovery callback must itself be a permitted, bounded browser action. The controller does not add stealth, user-activation bypasses, CAPTCHA handling, or anti-bot behavior.

## Pointer capture

Pointer capture and pointer lock are related ownership mechanisms but have different lifecycles. Capture is normally established by page code for a specific active pointer and commonly ends when that pointer is released; lock is an explicit document/element mode used for persistent relative movement. The implementation therefore keeps separate state machines and does not treat capture as proof that pointer lock is available.

For a captured pointer, observe with:

```ts
const observation = await observer.observeCapture(pointerId, backendNodeId);
const state = captureLifecycle.observe(observation);
```

When the caller intentionally releases the pointer, call `captureLifecycle.release(pointerId)` so the expected release is not mislabeled as unexpected loss. Navigation/renderer/target lifecycle owners may instead mark capture loss with the corresponding reason.

## Local Chromium coverage

`tests/integration/pointerLockLifecycleSmoke.test.mjs` uses only a synthetic `about:blank` fixture, raw CDP, and the repository's CDP input adapter. It performs a real browser pointer press that causes the fixture to call `setPointerCapture()`, verifies `hasPointerCapture()` through CDP, and verifies capture release after the browser pointer-up.

The same fixture enables a normal click-driven `requestPointerLock()` attempt. If the local headless Chromium grants the request, the test verifies owner identity, guarded relative movement, and lock loss. If that Chromium build exposes Pointer Lock but rejects it in headless mode, the test requires an actual `pointerlockerror`; if the API is unavailable, the test requires the observer to report `supported: false`. An unresolved unlocked state without one of those browser signals is not treated as successful coverage.

No external site, transaction, GitHub Actions workflow, UI automation framework, or remote CI is involved.
