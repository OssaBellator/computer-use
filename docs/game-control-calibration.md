# Game-control calibration

`GameControlCalibrator` is a bounded experimental layer for learning which **explicitly permitted realtime controls** produce measurable coarse visual/motion changes inside an already-acquired game region.

It is not game-playing intelligence. It does not recognize semantic objects, choose goals, learn a policy, perform reinforcement learning, acquire pointer lock, or attempt anti-cheat/anti-bot evasion.

## Inputs and boundaries

The caller supplies:

- a `BrowserInput` implementation (the standalone Chromium path uses native CDP `Input.*` operations);
- a finite candidate list containing keys, mouse buttons, wheel axes, or relative pointer axes;
- an `observe()` function that returns coarse visual-difference and temporal-track observations for the game region; and
- an explicit `isRealtimeContextActive()` gate.

A candidate is never inferred from page text, DOM semantics, menus, or arbitrary UI. Calibration only dispatches after an observation contains a valid acquired region and the caller confirms the realtime-control context. Before every probe, the pointer is moved to the center of that acquired clip so mouse buttons, wheel input, and relative movement are routed from the intended game surface rather than an unrelated page control.

`gameControlObservationFromVisualPipeline()` adapts the structural output of `CdpGameVisualPipeline` without making the calibrator depend on CDP itself. This keeps the calibration model usable with synthetic observations and other browser-native adapters.

## Probe sequence

Each distinct candidate receives at most one calibration probe per run. Same-control/same-direction duplicates are rejected up front, including repeated keys or repeated positive/negative wheel and pointer-axis probes.

For each candidate the calibrator:

1. optionally invokes the caller-owned `resetBetweenProbes()` hook when moving from one candidate to the next;
2. obtains a preflight observation and requires an acquired game region plus active realtime context;
3. centers the pointer inside the acquired clip;
4. collects a fresh passive baseline tied to the exact preflight region and perception generation;
5. checks realtime context again immediately before input;
6. dispatches one bounded actuation; and
7. collects a bounded after-window tied to the same region/perception generation.

Renderer replacement, clip movement, perception-generation changes, missing regions, visual incompatibility, observation failure, or insufficient comparable samples produce an **inconclusive** probe. They are never reported as evidence that a control has no effect.

## Candidate controls

```ts
import {
  GameControlCalibrator,
  gameControlObservationFromVisualPipeline,
} from '../src/agent/gameControlCalibration.js';

const calibration = await new GameControlCalibrator(input, {
  candidates: [
    { kind: 'key', key: 'w', holdMs: 50 },
    { kind: 'key', key: 'a', holdMs: 50 },
    { kind: 'mouse-button', button: 'left', holdMs: 30 },
    { kind: 'wheel', axis: 'y', delta: -80 },
    { kind: 'pointer-axis', axis: 'x', delta: 24 },
  ],
  observe: async () => gameControlObservationFromVisualPipeline(
    await visualPipeline.sample(performance.now()),
  ),
  isRealtimeContextActive: async (observation) =>
    observation.region !== undefined && gameSessionIsExplicitlyActive,
  resetBetweenProbes: async () => resetSyntheticOrKnownSafeGameState(),
}).run();
```

The reset hook is intentionally caller-owned because a generic browser layer cannot know whether an in-game reset is safe. Use it only for an explicitly known-safe game-state reset/rebaseline; do not route transaction, account, publication, deletion, deployment, or other high-consequence actions through calibration.

## Hard budgets

Defaults are deliberately small and configurable:

- 16 probes maximum;
- 48 browser-input actions maximum;
- 5 seconds wall-clock dispatch window;
- 250 ms maximum key/button hold;
- 480 CSS-pixel wheel magnitude;
- 120 CSS-pixel relative pointer magnitude;
- 3 comparable samples per baseline/after window, with at least 2 required and at most 5 observation attempts.

The complete action cost of a probe is reserved before it begins. A key or mouse-button probe reserves pointer centering plus down/up; wheel and relative-pointer probes reserve centering plus one actuation. This prevents an action-budget boundary from deliberately starting a hold that cannot be released. Cleanup release is still attempted after a dispatched down event even if the time budget expires during the hold.

As with the existing realtime loop, awaited browser/observation callbacks cannot be forcibly interrupted. The time budget prevents new calibration dispatch once elapsed time is known to be exhausted; it is not a cancellation primitive for a callback that never returns.

## Observed effects

The returned `GameControlCalibration` contains one compact relationship per attempted candidate. The calibrator compares baseline and after-window means for:

- changed-pixel fraction;
- mean absolute screenshot difference;
- confidence-filtered motion-track count;
- confidence-weighted mean track speed; and
- confidence-weighted mean x/y track velocity.

These are coarse visual-motion variables, not semantic entities. A variable is measurable only when its absolute delta exceeds both a configured minimum threshold and baseline-noise-derived threshold. Relationship confidence is deterministic and bounded in `[0,1]`; it reflects sample completeness and signal-to-threshold separation, not a causal probability or semantic understanding.

The relationship outcome is one of:

- `effect` — at least one observed variable exceeded its threshold;
- `no-measurable-effect` — enough stable, compatible baseline and after samples were collected and no variable exceeded its threshold; or
- `inconclusive` — observation/context/budget/input conditions were insufficient to make the no-effect claim.

A later planner can consume the compact relationship model, but this module does not plan gameplay or autonomously search the control space.

## Validation scope

The deterministic unit coverage uses synthetic visual/motion observations and a synthetic `BrowserInput`. No live game, purchase, payment, booking, transfer, publication, security change, deletion, deployment, or external process is exercised by these tests.
