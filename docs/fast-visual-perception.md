# Fast visual perception for realtime browser control

This slice reduces the cost of visually driven control loops for permitted canvas/game/simulation fixtures. It combines three independent mechanisms:

1. clipped Chromium screenshots so only the relevant game region is captured;
2. optional capture downscaling before screenshot bytes cross the CDP boundary; and
3. local PNG tile differencing so policies receive coarse spatial motion information rather than only whole-frame hashes.

`RealtimeControlLoop` can also run observation less often than control decisions. A 60 Hz control loop can, for example, request a visual frame every fourth tick while continuing to hold/release controls at the faster cadence.

## Downscaled cropped capture

`CdpVisualObserver.capture()` accepts `clip` plus an optional `scale` in `(0, 1]`:

```ts
const frame = await visual.capture({
  clip: { x: 80, y: 120, width: 640, height: 360 },
  scale: 0.5,
  maxBytes: 2_000_000,
});
```

The clip remains expressed in main-viewport CSS pixels. Chromium performs the scale as part of `Page.captureScreenshot`, so a smaller image crosses the protocol boundary. `scale` deliberately requires a clip and does not support values above `1`; this API is for bounded perception, not screenshot enlargement.

## Spatial frame differencing

`VisualMotionSampler` wraps `CdpVisualObserver` and keeps at most one previous snapshot as its comparison baseline:

```ts
const sampler = new VisualMotionSampler(visual, {
  capture: {
    clip: { x: 80, y: 120, width: 640, height: 360 },
    scale: 0.5,
  },
  tileSizePx: 16,
  pixelStride: 2,
  pixelDeltaThreshold: 24,
  tileChangedFraction: 0.05,
});

const first = await sampler.sample();  // difference === null
const next = await sampler.sample();   // difference against first
```

The differ decodes the non-interlaced 8-bit PNG formats Chromium normally emits without adding an image-library dependency. It samples RGB differences at `pixelStride`, accumulates them into `tileSizePx` tiles, and returns:

- total sampled-pixel count;
- global changed-pixel fraction and mean RGB absolute difference;
- changed tiles with per-tile change fraction and mean difference;
- a coarse image-space motion bounding box; and
- when the sampler uses a clip, equivalent main-viewport CSS rectangles.

This output is intentionally coarse. It is designed to answer questions like “where is paint changing?” cheaply enough to gate a policy or focus more expensive perception. It is not an object detector or photographic similarity metric.

If successive PNG dimensions differ, comparison fails closed as a full-frame change with `compatible: false` and `reason: 'dimensions-changed'`.

## Decoupled perception/control cadence

`RealtimeControlLoop` now accepts `observeEveryTicks`:

```ts
const loop = new RealtimeControlLoop(engine.input, {
  observe: () => sampler.sample(),
  decide: ({ observation, observationFresh, observationAgeTicks }) => {
    const motion = observation.difference?.viewportMotionBounds;
    if (observationFresh && motion && motion.x + motion.width > 500) {
      return { stop: true, reason: 'visual-target' };
    }
    return { heldKeys: ['ArrowRight'] };
  },
  tickIntervalMs: 16,
  observeEveryTicks: 4,
  maxTicks: 600,
  maxDurationMs: 10_000,
});
```

Tick `0` always observes. With `observeEveryTicks: 4`, ticks `1` through `3` reuse the same observation, tick `4` refreshes it, and so on. Every policy sample exposes:

- `observationFresh` — whether `observe()` ran on that tick;
- `observationAgeTicks` — control ticks since capture; and
- `observationAgeMs` — wall-clock age at decision time.

Policies should use these fields when an action requires fresh visual confirmation. Continuous held-control intents can normally continue across cached ticks.

## Bounds and failure behavior

The visual differ includes a `maxDecodedPixels` guard before allocating decoded RGBA buffers. Capture still retains the existing `maxBytes` guard on encoded screenshot data. The realtime loop keeps its independent `maxTicks` and `maxDurationMs` bounds and still releases all held keys/buttons on stop, failure, or budget exhaustion.

The PNG differ currently supports 8-bit, non-interlaced grayscale, RGB, grayscale+alpha, and RGBA PNGs. Other PNG encodings fail explicitly rather than silently producing incorrect motion data.

## Regression coverage

Unit regressions cover:

- exact tile/motion bounds for a synthetic changed region;
- dimension-change fail-closed behavior;
- decoded-pixel allocation limits;
- mapping downscaled image tiles back to viewport coordinates;
- forwarding clipped screenshot scale to CDP;
- observation freshness/age metadata; and
- deterministic cached-observation cadence.

`tests/integration/fastVisualPerceptionSmoke.test.mjs` launches local Chromium with an animated canvas. A held `ArrowRight` moves a painted player while the control loop runs faster than screenshot capture. The regression stops from visual motion bounds, verifies exactly one keydown/key-up lifecycle, and asserts that screenshot calls are fewer than control ticks.

No GitHub Actions are required. Run the local suites with:

```bash
npm test
npm run test:chromium
```

## Scope

These primitives improve responsiveness and efficiency for owned/permitted interactive-page automation. They do not implement fingerprint spoofing, stealth patches, CAPTCHA handling, navigator mutation, anti-bot evasion, or detection-specific timing camouflage.
