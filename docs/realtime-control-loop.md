# Realtime browser control loop

`RealtimeControlLoop` is a bounded runtime primitive for interactive pages whose controls must remain held across multiple browser frames: canvas games, simulations, accessibility research fixtures, and other continuously updating interfaces.

It sits below semantic task planning. A caller supplies an observation function and a policy. On every tick the policy declares the complete set of keys and mouse buttons that should remain held, plus an optional pointer position. The loop diffs that desired state against the browser input adapter, so a continuously held key produces one `keyDown` and one eventual `keyUp` rather than a stream of synthetic repeated presses.

## Safety and scope

The loop uses the existing `BrowserInput` abstraction and therefore normal CDP/automation input primitives. It contains no fingerprint spoofing, stealth patches, CAPTCHA handling, timing camouflage, navigator mutation, anti-bot bypass logic, or claims that automation-originated input is physically generated.

Use it on environments where automated play/testing is permitted. Anti-abuse systems remain outside the runtime's scope.

## Example

```ts
import {
  CdpVisualObserver,
  RealtimeControlLoop,
  createPureCdpInteractionEngine,
} from './index.js';

const engine = await createPureCdpInteractionEngine(session);
const visual = new CdpVisualObserver(session);

const loop = new RealtimeControlLoop(engine.input, {
  observe: () => visual.capture({
    format: 'jpeg',
    quality: 70,
    clip: { x: 0, y: 0, width: 640, height: 360 },
  }),
  decide: ({ observation, tick }) => {
    // A caller-owned perception/policy layer can inspect the visual frame.
    // This simple example only demonstrates held-input lifecycle.
    if (tick >= 30) return { stop: true, reason: 'demo-complete' };
    return { heldKeys: ['ArrowRight'] };
  },
  tickIntervalMs: 16,
  maxTicks: 120,
  maxDurationMs: 5_000,
});

const result = await loop.run();
```

## Runtime guarantees

- Hard `maxTicks` and `maxDurationMs` bounds prevent accidental unbounded control loops.
- The policy declares desired held state each tick; omitted keys/buttons are released.
- Repeated intents do not repeat `keyDown`/`pointerDown` for controls that are already held.
- Releases happen before newly requested opposite/different controls are pressed.
- Pointer movement occurs before newly requested mouse-button presses.
- Held inputs are released on normal stop, tick/time exhaustion, observation failures, policy failures, and dispatch failures.
- Malformed key/button/pointer intents fail before new input is dispatched.
- Timing and sleeping are injectable for deterministic regression tests.

## Browser regression fixture

`tests/integration/realtimeGameLoopSmoke.test.mjs` launches local headless Chromium, creates an animated canvas fixture, and drives it with real CDP keyboard events. The regression verifies that:

1. `ArrowRight` stays held across multiple animation updates;
2. the moving canvas produces a different screenshot hash;
3. only one non-repeat keydown is observed by the page;
4. the loop stops after the player reaches the target position; and
5. cleanup emits the matching keyup so the page is not left moving.

Run locally with:

```bash
npm run test:chromium
```

Set `CHROMIUM_BIN` when Chromium is installed somewhere other than `/usr/bin/chromium`.

## Next capability slices

The control loop deliberately separates mechanics from perception and strategy. Useful next layers are:

- lower-cost cropped visual sampling for fast-changing canvas regions;
- frame-to-frame visual differencing and motion-region extraction;
- game-state adapters for owned fixtures that combine visual and semantic observations;
- policy scheduling with separate perception and control frequencies;
- pointer-drag and simultaneous multi-key control profiles;
- deterministic replay logs for debugging policies without recording sensitive screenshot bytes by default.
