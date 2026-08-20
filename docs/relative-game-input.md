# Relative game input

This slice adds a small but important foundation for browser games that use continuous keyboard controls together with mouse-look style motion.

## Input capability

`BrowserInput` now has an optional `movePointerBy(delta)` capability. The delta is expressed in viewport CSS pixels and represents movement relative to the adapter's last successful pointer position.

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

## Browser semantics and pointer lock

The local Chromium regression verifies browser-observed `mousemove.movementX` / `movementY` values from real CDP mouse moves while a keyboard control remains held. It does not synthesize those DOM events.

Pointer-lock acquisition itself is browser- and page-policy-dependent and generally requires the page's normal activation flow. Headless Chromium does not provide a reliable stand-in for every site's pointer-lock permission behavior, so the regression deliberately tests the input invariant beneath pointer lock rather than claiming universal lock acquisition.

On pages that are not pointer-locked, accumulated relative moves can eventually leave the useful viewport region. Policies intended for ordinary pointer interaction should continue using absolute target acquisition; `pointerDelta` is intended for bounded relative-control windows such as mouse-look, drag-like steering, or a page that has already captured the pointer.

## Regression coverage

The unit tests cover:

- CDP relative-coordinate accumulation and subsequent button origin
- Playwright-compatible relative-coordinate accumulation
- non-finite coordinate rejection before browser dispatch
- per-tick relative motion while a keyboard control remains held
- absolute/relative intent mutual exclusion
- fail-closed behavior when an adapter lacks relative movement support

`tests/integration/relativeGameInputSmoke.test.mjs` launches local Chromium, injects a deterministic game fixture into `about:blank`, holds `w` across control ticks, and applies three `{ x: 6, y: -2 }` relative moves. The fixture must observe exactly one keydown, one cleanup keyup, and browser-reported mouse deltas totaling yaw `18` and pitch `-6`.

No GitHub Actions or platform UI automation is required for this regression; it runs through the repository's existing local Chromium test path.
