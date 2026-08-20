# Game visual pipeline

The game foundations now have distinct responsibilities:

- `CdpGameRegionLocator` finds a likely renderer.
- `CdpGameRegionLease` keeps that renderer identity/geometry current.
- `CdpVisualObserver` captures bounded screenshots.
- `VisualMotionSampler` converts screenshots into spatial changed-tile observations.
- `VisualMotionTracker` adds short temporal motion state.

`CdpGameVisualPipeline` composes those pieces into one deterministic observation call so a realtime policy does not have to manually synchronize renderer generations, screenshot clips, visual baselines, sampler sequence resets, and temporal tracker resets.

## Basic use

```ts
const visual = new CdpGameVisualPipeline(session, {
  capture: {
    scale: 0.5,
    maxBytes: 512 * 1024,
  },
  motion: {
    tileSizePx: 8,
    pixelStride: 2,
  },
  tracking: {
    maxTracks: 24,
  },
});

const observation = await visual.sample(performance.now());
```

The pipeline controls the screenshot clip and PNG format. Callers supply base capture controls such as scale, byte budget, quality-independent screenshot options, motion-difference thresholds, region-acquisition bounds, and temporal-tracking limits.

## Result states

Each `GameVisualPipelineSample` has one of three statuses:

- `missing`: no likely renderer is currently available; no screenshot/tracking sample is returned.
- `baseline`: a renderer/clip is available, but this call created a new visual baseline because no sampler existed yet or its visual coordinate context changed.
- `sampled`: the existing sampler/tracker context was reused and this call produced the next comparable visual sample.

The result also contains:

- `rendererGeneration`: the game-region lease generation, which changes when renderer backend identity changes.
- `perceptionGeneration`: increments whenever the pipeline has to construct a new cropped visual sampler/baseline.
- `baselineReset`: explicit per-call indication that temporal association was reset before this sample.
- `lease`: the current region lease snapshot.
- `sample`: the `VisualMotionSample` when a renderer exists.
- `tracking`: the temporal tracking frame when a renderer exists.

## Reset boundaries

The pipeline rebuilds its visual sampler and resets temporal association when either of these changes:

1. renderer generation
2. authoritative visible screenshot clip

A stable renderer with stable clip reuses the same sampler and tracker. A transient lease fallback that reacquires the same backend identity and geometry therefore does **not** create an unnecessary new perception generation.

A resize/fullscreen/layout change that alters the clip keeps the renderer generation but starts a new perception generation. This is intentionally conservative: fixed screenshot geometry changed, so the old PNG baseline and motion coordinates should not be mixed with the new capture context.

Renderer replacement advances the lease generation and also creates a new perception generation.

When a previously active renderer becomes `missing`, active sampler/tracker state is cleared. Later acquisition starts another clean visual baseline.

## Timestamp semantics

`sample(timestampMs)` takes an explicit finite non-negative timestamp. Timestamps must be non-decreasing across successful pipeline observations. Time reversal is rejected before lease or screenshot work.

Explicit time keeps temporal velocity deterministic in tests and lets callers use the same monotonic clock as their realtime control loop.

## Bounded behavior

The pipeline does not add an unbounded loop. One call performs one lease acquire/refresh followed by at most one screenshot sample and one temporal update.

Bounding remains delegated to the underlying layers:

- game-region search/result bounds
- screenshot byte/pixel/crop bounds
- changed-tile and decoded-pixel bounds
- temporal changed-tile/region/track limits
- association distance and projection horizon

The pipeline does not create background monitoring, timers, GitHub Actions, platform UI automation, page-side input synthesis, stealth behavior, or anti-abuse bypass logic.

## Realtime-control integration

The intended pattern is to use `CdpGameVisualPipeline` as the lower-frequency `observe()` side of `RealtimeControlLoop`:

```ts
const visual = new CdpGameVisualPipeline(session, {
  capture: { scale: 0.5 },
});

const loop = new RealtimeControlLoop(input, {
  observe: () => visual.sample(performance.now()),
  decide: ({ observation, observationFresh, observationAgeMs }) => {
    if (observation.status === 'missing') {
      return { stop: true, reason: 'game-surface-missing' };
    }

    const track = observation.tracking?.tracks[0];
    return {
      heldKeys: ['w'],
      pointerDelta: track && observationFresh
        ? { x: Math.sign(track.velocityPxPerSecond.x) * 4, y: 0 }
        : { x: 0, y: 0 },
    };
  },
  observeEveryTicks: 4,
  tickIntervalMs: 8,
});
```

The example only demonstrates composition. A real policy still needs task/game-specific interpretation, goal state, control mapping, and verification.

## Regression coverage

Deterministic unit regressions verify:

- stable renderer/clip reuses one sampler and temporal context
- clip resize creates a new perception generation without changing renderer generation
- renderer generation change creates a new baseline even when clip dimensions match
- missing renderer produces no screenshot/tracking state and later acquisition starts cleanly
- timestamp reversal fails before lease/capture work

`tests/integration/gameVisualPipelineSmoke.test.mjs` composes the real local Chromium stack. It acquires a 128×64 canvas, tracks an 8-pixel-per-100-ms moving square to 80 px/s, verifies short projection, resizes the same canvas and observes a new perception baseline while renderer generation remains `1`, then replaces the renderer and verifies renderer generation `2` plus a third perception baseline.
