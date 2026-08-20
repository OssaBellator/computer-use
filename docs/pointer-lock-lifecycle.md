# Pointer-lock and pointer-capture lifecycle

This feature adds framework-independent foundations for observing and recovering pointer ownership during permitted realtime browser interactions. It extends the existing `BrowserInput.movePointerBy()` and realtime held-input path; it does not replace absolute pointer input, game-region acquisition, renderer lifecycle, or visual tracking.

## Lock state

`PointerLockLifecycle` represents four explicit states: `unlocked`, `requested`, `locked`, and `lost`. A snapshot carries a monotonic lock generation plus the strongest available owner identity. Identity is partial by design and can include target/session/frame ids, the locking element backend node/id/tag, and the current game-region backend node/generation. `pointerLockOwnerMatches()` compares only fields a caller requires.

Loss reasons are explicit: focus loss, Escape, navigation, renderer replacement, target change, element detachment, or unknown loss. `PointerLockController.observe()` detects ordinary locked-to-unlocked transitions and infers focus loss when `document.hasFocus()` is false. Controllers that already receive navigation, renderer, target, or Escape signals can call the corresponding `note*()` hook immediately rather than waiting for the next poll.

## Browser-native observation

`CdpPointerLockObserver` uses CDP to evaluate the browser's actual DOM ownership state. When locked, it resolves `document.pointerLockElement` to a CDP backend node so lock state can be associated with stable browser identity. It does not create page-side `MouseEvent`/`PointerEvent` objects or use synthetic `dispatchEvent()` input.

Pointer capture is observed separately with `Element.hasPointerCapture(pointerId)` on a CDP-resolved backend node. `PointerCaptureLifecycle` distinguishes a normal caller-declared `release(pointerId)` from an unexpected transition to `lost`. Capture is pointer-id-scoped because multiple active pointers can have independent capture ownership.

## Bounded acquisition and recovery

`PointerLockController.acquire()` does not call `requestPointerLock()` itself. The caller supplies a `request()` callback that performs the page's permitted normal activation flow, for example a browser-native click on the game surface. This keeps user-activation, focus, and permission rules in the browser rather than bypassing them.

Acquisition is hard bounded: at most 4 request attempts, at most 32 observations per attempt, at most 1 second between observations, and one attempt by default. An optional `shouldRetry()` hook may stop retrying earlier. Observation errors propagate instead of being interpreted as permission to send relative input.

A recovery policy can be supplied to `moveRelative()`. Recovery uses the same bounded acquisition primitive and expected owner identity. A dynamic guard owner can include the latest game-region backend node/generation so renderer replacement makes the next relative command reject stale ownership and invoke bounded recovery.

## Relative-pointer safety

`PointerLockController.moveRelative()` has three policies:

- `required` (default): dispatch relative input only while the observed lock matches the required owner; otherwise throw `PointerLockRequiredError` before movement.
- `preferred`: suppress movement when lock is absent/mismatched and require an explicit `onDegraded()` callback. There is no silent fallback to an absolute move.
- `none`: bypass lock checking for bounded interactions that intentionally use ordinary relative coordinate accumulation without pointer lock.

`guardRelativePointerInput()` preserves the existing `BrowserInput` API and delegates every operation unchanged except `movePointerBy()`, which is routed through the controller. The existing `RealtimeControlLoop` can therefore receive the guarded input without gaining a framework dependency or changing its held-key/button semantics.

```ts
let regionSnapshot = await gameRegionLease.acquire();
const observer = new CdpPointerLockObserver(session, {
  frameId,
  gameRegion: () => ({
    backendNodeId: regionSnapshot.region?.backendNodeId,
    generation: regionSnapshot.generation,
  }),
});
const lock = new PointerLockController(input, observer);
const guardedInput = guardRelativePointerInput(input, lock, {
  requirement: 'required',
  owner: () => ({
    frameId,
    gameRegionBackendNodeId: regionSnapshot.region?.backendNodeId,
    gameRegionGeneration: regionSnapshot.generation,
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

Pointer capture and pointer lock have different lifecycles. Capture is normally established by page code for a specific active pointer and commonly ends when that pointer is released; lock is an explicit document/element mode used for persistent relative movement. The implementation therefore keeps separate state machines and does not treat capture as proof that pointer lock is available.

```ts
const observation = await observer.observeCapture(pointerId, backendNodeId);
const state = captureLifecycle.observe(observation);
```

When the caller intentionally releases the pointer, call `captureLifecycle.release(pointerId)` so the expected release is not mislabeled as unexpected loss. Navigation/renderer/target lifecycle owners may instead mark capture loss with the corresponding reason.

## Local Chromium coverage

`tests/integration/pointerLockLifecycleSmoke.test.mjs` uses only a synthetic `about:blank` fixture, raw CDP, and the repository's CDP input adapter. It performs a real browser pointer press that causes the fixture to call `setPointerCapture()`, verifies `hasPointerCapture()` through CDP, and verifies capture release after browser pointer-up.

The same fixture enables a normal click-driven `requestPointerLock()` attempt. If local headless Chromium grants the request, the test verifies owner identity, guarded relative movement, and lock loss. If that Chromium build exposes Pointer Lock but rejects it in headless mode, the test requires an actual `pointerlockerror`; if the API is unavailable, the observer must report `supported: false`. An unresolved unlocked state without one of those browser signals is not treated as successful coverage.

No external site, transaction, GitHub Actions workflow, UI automation framework, or remote CI is involved.
