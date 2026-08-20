# Temporal visual motion tracking

Frame-pair screenshot differencing says where pixels changed, but fast game control often needs a short estimate of where that changed region is moving before the next expensive visual sample. `VisualMotionTracker` adds a bounded temporal layer on top of `VisualMotionSampler` output.

The tracker intentionally models **connected motion regions**, not semantic game entities. A stable track ID means that a coarse changed region was associated across samples; it does not prove that the region is an enemy, projectile, ball, vehicle, avatar, or any other object class.

## Tracks

Each `VisualMotionTrack` contains:

- a monotonic numeric `id` within the tracker lifetime
- coordinate space (`image` or `viewport`)
- latest observed rectangle and center
- smoothed velocity in pixels per second
- confidence in `[0,1]`
- observed age in samples
- consecutive missed-sample count
- last seen sampler sequence and timestamp

Track IDs are not reused by `reset()`. Reset clears temporal association state while keeping future IDs distinct from identities that existed before the reset.

## Updating from the visual sampler

Pass each `VisualMotionSample` together with an explicit monotonic timestamp:

```ts
const tracker = new VisualMotionTracker();

const sample = await sampler.sample();
const frame = tracker.update(sample, performance.now());

for (const track of frame.tracks) {
  console.log(track.id, track.rect, track.velocityPxPerSecond, track.confidence);
}
```

Sampler sequence numbers must be strictly increasing and timestamps must be non-decreasing. The tracker validates both before mutating live track state. If the sampler itself is reset and starts its sequence again, reset the temporal tracker at the same boundary.

A dimension-incompatible visual difference clears temporal tracks instead of associating regions across incompatible image geometry.

## Region construction

Changed tiles are grouped into connected regions using their screenshot-image rectangles or, when every changed tile has one, their mapped main-viewport rectangles. Coordinate-space changes clear existing track associations so image-space and viewport-space coordinates are never silently mixed.

The region layer is bounded:

- at most 512 changed tiles are clustered directly by default
- larger tile inputs collapse to one coarse motion bound
- at most 32 regions are retained per sample by default
- at most 32 live tracks are retained by default

These bounds prevent a noisy or near-full-frame visual change from turning one perception sample into unbounded association work. The tracking frame reports `collapsedInput: true` when excessive tile input has been reduced to the coarse motion bound.

## Association and velocity

Existing tracks are projected over a short horizon using their latest velocity. Candidate regions are then associated deterministically using predicted-center distance plus rectangle overlap.

Non-overlapping associations are bounded by `maxAssociationDistancePx` (96 pixels by default). Association prediction is bounded by `maxProjectionMs` (250 ms by default) so stale tracks do not extrapolate indefinitely.

After a match, instantaneous center velocity is measured from the previous observed center and elapsed wall-clock time. `velocityAlpha` controls the measurement weight in the smoothed velocity; its default is `0.6`. Set it to `1` for deterministic fixtures where each measurement should replace the previous velocity directly.

## Confidence and misses

New tracks start with confidence `0.5` by default. A matched sample adds `0.2` up to `1`; a miss subtracts `0.25`. Tracks expire after more than two consecutive misses by default or when confidence reaches zero.

These values are deliberately simple confidence bookkeeping, not calibrated probabilities. Policies should treat confidence as a relative freshness/stability signal and combine it with task-specific evidence.

## Short-horizon projection

`projectVisualMotionTrack()` shifts the latest track rectangle using its smoothed velocity:

```ts
const projected = projectVisualMotionTrack(track, 100);
```

Projection is bounded to 250 ms by default. A custom maximum may be supplied explicitly. The helper does not model acceleration, collisions, camera motion, occlusion, or game physics; it is a short linear extrapolation primitive.

## Renderer lifecycle integration

`CdpGameRegionLease.generation` is the natural reset boundary for renderer-specific temporal state. Keep tracks when a lease merely refreshes geometry and the coordinate space remains coherent; reset/rebuild the visual sampler and temporal tracker when renderer generation changes.

When the lease updates a fixed screenshot clip after resize/fullscreen geometry changes, callers should also refresh or rebuild the sampler capture configuration before feeding more samples to the tracker. A dimension or coordinate-space mismatch will otherwise deliberately clear associations.

## Regression coverage

Unit regressions cover:

- connected changed-tile clustering
- stable track identity across motion samples
- measured velocity and bounded projection
- confidence decay and missed-sample expiration
- image/viewport coordinate-space reset
- bounded excessive-tile collapse
- incompatible-dimension reset
- monotonic sequence/timestamp validation without state mutation

`tests/integration/temporalVisualTrackingSmoke.test.mjs` launches local Chromium and draws an 8×8 white square over a black 128×64 canvas. The square moves from x=8 to x=16 to x=24. The existing PNG visual sampler must produce one persistent temporal motion track whose measured horizontal velocity is 80 px/s over 100 ms sample intervals, with the 100 ms projected motion region shifted another 8 pixels.

The browser fixture uses ordinary screenshot capture and visual differencing; it does not read the square position from page state to produce the tracking result.
