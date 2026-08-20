# Relative game input

This slice adds a small but important foundation for browser games that use continuous keyboard controls together with mouse-look style motion.

## Input capability

`BrowserInput` has an optional `movePointerBy(delta)` capability. The delta is expressed in viewport CSS pixels and represents movement relative to the adapter's last successful pointer position.

The bundled CDP and Playwright-compatible adapters both implement the capability by tracking a logical pointer position and issuing the next normal browser mouse move at `current + delta`.

For deterministic behavior, seed the logical pointer with one absolute move before beginning a relative-control loop:

```ts
await input.movePointer({ x: 320, y: 180 });
await input.movePointerBy({ x: 8, y: -3 });
```

The CDP adapter continues to use `Input.dispatchMouseEvent`; it does not inject page-side `MouseEvent` objects.

## Realtime mouse-look

`RealtimeControlIntent` accepts `pointerDelta` alongside held keyboard and mouse-button state:

```ts
const result = await new RealtimeControlLoop(input, {
  observe: readGameState,
  decide: ({ observation }) => observation.aimed
    ? { stop: true, reason: 'target-acquired' }
    : {
        heldKeys: ['w'],
        pointerDelta: { x: 6, y: -2 },
      },
  tickIntervalMs: 8,
  maxTicks: 240,
  maxDurationMs: 2_000,
}).run();
```

A policy may request either `pointer` or `pointerDelta` in one tick, never both. Ambiguous intents are rejected before new control input is dispatched. If an external `BrowserInput` implementation does not expose `movePointerBy`, relative intents also fail closed instead of silently degrading to an unrelated absolute move.

Held keys and buttons still use the existing state-diff semantics, so a game can receive one `keydown`, multiple relative mouse movements across subsequent ticks, and one cleanup `keyup` when the loop stops.

## Pointer lock and capture

Relative coordinate accumulation does not by itself prove that a page owns pointer lock. For interactions that require lock, wrap the existing input with `guardRelativePointerInput()` and a `PointerLockController`. Required mode suppresses the delta and throws before dispatch when the observed lock is absent or belongs to the wrong frame/element/renderer. Preferred mode suppresses the delta and requires an explicit degradation callback; it never silently substitutes an absolute move.

The CDP observer resolves `document.pointerLockElement` to browser backend identity and associates game-region generation only when the locking backend node matches the current leased game surface. Separate pointer-capture observation uses `hasPointerCapture(pointerId)`. See [`pointer-lock-lifecycle.md`](pointer-lock-lifecycle.md) for the state machines, bounded recovery hooks, and lifecycle signals.

For ordinary interactions that intentionally do not require pointer lock, the original `movePointerBy()` path remains available. This preserves bounded relative-control windows and existing optional adapters without making Pointer Lock a universal requirement for every relative delta.

## Regression coverage

The relative-input unit tests cover:

- CDP relative-coordinate accumulation and subsequent button origin
- Playwright-compatible relative-coordinate accumulation
- non-finite coordinate rejection before browser dispatch
- per-tick relative motion while a keyboard control remains held
- absolute/relative intent mutual exclusion
- fail-closed behavior when an adapter lacks relative movement support

`tests/integration/relativeGameInputSmoke.test.mjs` launches local Chromium, injects a deterministic game fixture into `about:blank`, holds `w` across control ticks, and applies three `{ x: 6, y: -2 }` relative moves. The fixture must observe exactly one keydown, one cleanup keyup, and browser-reported mouse deltas totaling yaw `18` and pitch `-6`.

Pointer-lock/capture lifecycle coverage is separate in `tests/integration/pointerLockLifecycleSmoke.test.mjs` so unsupported headless pointer-lock behavior can be isolated accurately instead of weakening the base relative-input invariant.
