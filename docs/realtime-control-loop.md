# Realtime browser control loop

`RealtimeControlLoop` is a bounded runtime primitive for interactive pages whose controls must remain held across multiple browser frames: canvas games, simulations, accessibility research fixtures, and other continuously updating interfaces.

It sits below semantic task planning. A caller supplies an observation function and a policy. On every control tick the policy declares the complete set of keys and mouse buttons that should remain held, plus an optional pointer position. The loop diffs that desired state against the browser input adapter, so a continuously held key produces one `keyDown` and one eventual `keyUp` rather than a stream of repeated presses.

Observation cadence can be slower than control cadence. `observeEveryTicks` keeps the latest observation cached between refreshes and exposes freshness/age metadata to every decision.

## Safety and scope

The loop uses the existing `BrowserInput` abstraction and therefore normal CDP/automation input primitives. It contains no fingerprint spoofing, stealth patches, CAPTCHA handling, timing camouflage, navigator mutation, anti-bot bypass logic, or claims that automation-originated input is physically generated.

Use it on environments where automated play/testing is permitted. Anti-abuse systems remain outside the runtime's scope.

## Example

```ts
import {
  CdpVisualObserver,
  RealtimeControlLoop,
  VisualMotionSampler,
  createPureCdpInteractionEngine,
} from './index.js';

const engine = await createPureCdpInteractionEngine(session);
const visual = new CdpVisualObserver(session);
const motion = new VisualMotionSampler(visual, {
  capture: {
    clip: { x: 0, y: 0, width: 640, height: 360 },
    scale: 0.5,
  },
});

const loop = new RealtimeControlLoop(engine.input, {
  observe: () => motion.sample(),
  decide: ({ observation, observationFresh, observationAgeTicks }) => {
    // Cached observations can safely support continuing held-input state.
    // Require observationFresh when a transition needs fresh visual confirmation.
    const bounds = observation.difference?.viewportMotionBounds;
    if (observationFresh && bounds && bounds.x + bounds.width > 500) {
      return { stop: true, reason: 'visual-target' };
    }
    if (observationAgeTicks > 6) return {};
    return { heldKeys: ['ArrowRight'] };
  },
  tickIntervalMs: 16,
  observeEveryTicks: 4,
  maxTicks: 600,
  maxDurationMs: 10_000,
});

const result = await loop.run();
```

## Observation cadence contract

Tick `0` always calls `observe()`. For `observeEveryTicks: 4`, ticks `1`, `2`, and `3` reuse the tick-0 observation, tick `4` refreshes it, then the pattern repeats.

Each decision receives:

- `observationFresh`: `true` when `observe()` ran on this tick;
- `observationAgeTicks`: number of control ticks since the observation was captured; and
- `observationAgeMs`: wall-clock age of the cached observation when the policy begins deciding.

The default `observeEveryTicks` is `1`, preserving the original one-observation-per-control-tick behavior.

## Runtime guarantees

- Hard `maxTicks` and `maxDurationMs` bounds prevent accidental unbounded control loops.
- Observation cadence is a validated positive integer and tick `0` always observes.
- The policy declares desired held state each tick; omitted keys/buttons are released.
- Repeated intents do not repeat `keyDown`/`pointerDown` for controls that are already held.
- Releases happen before newly requested opposite/different controls are pressed.
- Pointer movement occurs before newly requested mouse-button presses.
- Held inputs are released on normal stop, tick/time exhaustion, observation failures, policy failures, and dispatch failures.
- Malformed key/button/pointer intents fail before new input is dispatched.
- No new intent is dispatched when observation or policy work itself crosses the wall-clock budget.
- Timing and sleeping are injectable for deterministic regression tests.

## Browser regression fixtures

`tests/integration/realtimeGameLoopSmoke.test.mjs` launches local headless Chromium, creates an animated canvas fixture, and verifies that one real CDP `ArrowRight` keydown stays held across multiple animation updates before cleanup produces the matching keyup.

`tests/integration/fastVisualPerceptionSmoke.test.mjs` layers `VisualMotionSampler` onto the same runtime shape. Control decisions run more frequently than downscaled screenshot capture, cached observation metadata is exercised, and a coarse visual motion bound causes the policy to stop. The regression asserts that screenshot calls are fewer than control ticks.

Run locally with:

```bash
npm run test:chromium
```

Set `CHROMIUM_BIN` when Chromium is installed somewhere other than `/usr/bin/chromium`.

## Related perception primitives

See [`fast-visual-perception.md`](fast-visual-perception.md) for clipped/downscaled screenshot capture, PNG motion differencing, changed-tile metadata, and viewport-coordinate mapping.

## Next capability slices

The control loop deliberately separates mechanics from perception and strategy. Useful next layers are:

- short bounded visual tracks with velocity/confidence estimates between captures;
- deterministic acquisition/refresh of game canvas or video regions;
- game-state adapters for owned fixtures that combine visual and semantic observations;
- control/perception trace replay without storing screenshot bytes by default; and
- higher-level policies that consume temporal visual state while retaining hard runtime budgets.
