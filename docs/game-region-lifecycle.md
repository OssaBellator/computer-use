# Game region lifecycle

A browser game surface is not static. Canvas renderers resize, fullscreen changes viewport geometry, layout shifts alter visible clips, and some games replace the renderer node entirely during loading or mode changes. `CdpGameRegionLease` keeps the visual-control layer attached to the current renderer without rerunning a full bounded DOM search on every observation.

## Acquire once, refresh cheaply

Start by acquiring the current likely game region:

```ts
const lease = new CdpGameRegionLease(session);
const acquired = await lease.acquire();

if (!acquired.region) {
  throw new Error('No likely game surface found');
}
```

The first successful renderer identity has generation `1`.

Subsequent `refresh()` calls first probe the leased backend DOM node directly with `DOM.getBoxModel`. If that backend node still exists and still satisfies the configured minimum dimensions and visibility threshold, the lease updates its browser-authoritative `rect`, visible `clip`, `visibleFraction`, and `viewportCoverage` without performing another game-surface search.

This is the common path for:

- browser resize
- layout changes
- entering or leaving fullscreen when the same renderer remains alive
- viewport clipping changes

The status is `refreshed`, and the generation remains unchanged.

## Renderer replacement and reacquisition

If the backend node is detached, becomes too small, moves fully out of view, or falls below the minimum visible fraction, refresh falls back to the bounded `CdpGameRegionLocator` search.

If the newly selected renderer has a different backend-node identity, the lease returns `reacquired` and increments `generation`. A policy can use that generation boundary to reset renderer-specific state such as visual-motion baselines, entity tracks, or calibration.

If no likely renderer can be found, the lease returns `missing` and omits `region`. It does not silently continue using stale geometry.

## Snapshot semantics

Each lease snapshot includes:

- `status`: `acquired`, `refreshed`, `reacquired`, or `missing`
- `generation`: monotonic renderer acquisition generation
- `region`: current candidate when one exists
- `geometryChanged`: whether renderer identity, border geometry, or visible clip changed

`current()` returns a defensive copy so callers cannot mutate the lease's internal region state. `clear()` removes the current lease and resets the generation to zero.

The candidate `score` is an acquisition-time ranking value. Same-backend refresh updates geometry and visibility fields but deliberately does not pretend that the original score was freshly re-ranked against every other page candidate. Reacquisition performs a real locator ranking again.

## Visual sampler integration

A control policy can refresh the lease before a scheduled visual sample and reset the visual baseline only when the renderer generation changes:

```ts
const state = await lease.refresh();

if (!state.region) {
  return { stop: true, reason: 'game-surface-missing' };
}

if (state.generation !== previousGeneration) {
  sampler = new VisualMotionSampler(visual, {
    capture: { clip: state.region.clip, scale: 0.5 },
  });
  previousGeneration = state.generation;
}
```

When geometry changes without renderer replacement, callers that constructed a sampler with a fixed clip should rebuild or otherwise refresh that capture configuration before the next screenshot. The lease provides the authoritative new clip; it does not mutate another object's capture options behind the caller's back.

## Bounds and failure behavior

The same minimum width, minimum height, visible-fraction, search-result, and candidate-count options accepted by `CdpGameRegionLocator` can be passed through `acquire()` and `refresh()`.

Refresh validates the geometry-related thresholds before browser work. A stale backend-node probe is treated as a reacquisition signal, while unexpected failure of an individual old renderer does not make the lease continue with stale coordinates.

The lease is synchronous with caller control flow. It does not create background monitoring, timers, GitHub Actions, or platform UI automation.

## Regression coverage

Unit regressions verify:

- resize updates geometry without a second locator search
- renderer detachment triggers bounded reacquisition and increments generation
- unchanged geometry reports `geometryChanged: false`
- `current()` is defensively cloned
- a page with no likely renderer remains at generation zero

`tests/integration/gameRegionLeaseSmoke.test.mjs` runs in local Chromium. It acquires a 320×180 canvas, resizes that same renderer to 480×270 while retaining generation `1`, then replaces the canvas element and verifies reacquisition of a new backend node at generation `2` with a 400×220 clip.
