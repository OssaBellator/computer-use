# Semantic Browser Interaction Engine

A TypeScript foundation for closed-loop browser interaction research, accessibility tooling, and reproducible UI testing.

The project models a page as a semantic/spatial interaction graph, learns observed focus topology, plans across input modalities, and executes pointer movement through a bounded virtual-touchpad controller before verifying the resulting browser state.

## Scope

The engine uses normal browser automation mouse/keyboard primitives rather than page-side `dispatchEvent()` calls. It is designed for realistic testing and HCI experiments, but it does **not** claim hardware provenance, indistinguishability from a physical user, or anti-bot bypass capability.

## Current architecture

### Perception

- frame-aware interactive DOM snapshots
- traversal of open Shadow DOM, including non-interactive shadow hosts
- shadow-boundary-aware node identities
- deep focus observation inside open shadow roots
- accessible-name heuristics and common ARIA widget state
- viewport-clipped `visibleRect` geometry
- focusable/clickable/editable/scrollable capability inference

### Interaction model and planning

- weighted semantic/spatial interaction graph
- directional neighbor scoring using distance, alignment, and uncertainty
- observed `Tab` / `Shift+Tab` focus-topology learning
- `InteractionModel` that preserves learned topology across volatile snapshots
- A* planning over time, failure, scrolling, uncertainty, and modality costs
- path-state-aware keyboard/pointer/scroll switching
- direct pointer-edge estimates using target geometry and a Fitts-style duration prior

### Input and motor control

- small structural adapter for Playwright-compatible page mouse/keyboard primitives
- no hard runtime dependency on Playwright in the core library
- deterministic minimum-jerk cursor trajectories
- separate virtual finger-space and viewport cursor-space state
- bounded touchpad strokes with lift/recenter behavior
- oversized trajectory segments split into physically bounded virtual strokes

### Observation and verification

- before/after snapshot diffing for actions
- focus and editable-value verification
- ARIA state transition detection (`expanded`, `checked`, `selected`, `pressed`, active descendant, disabled)
- observable click/typing/scroll results rather than assuming a command succeeded

## Local validation

Install the TypeScript development dependencies and run:

```bash
npm install
npm run typecheck
npm test
```

The regression suite uses Node's built-in test runner; GitHub Actions is not required.

If Chromium is installed locally, the live smoke regression can exercise the real snapshot evaluator in a headless browser:

```bash
npm run test:chromium
```

Set `CHROMIUM_BIN=/path/to/chromium` when Chromium is not at `/usr/bin/chromium`.

## Architecture

```text
semantic goal
    |
    v
DOM / frame / shadow snapshot
    |
    v
InteractionModel <----- observed focus topology
    |                         ^
    v                         |
modality-aware A* planner     |
    |                         |
    +---- keyboard -----------+
    |
    +---- pointer -> trajectory -> virtual touchpad
    |
    +---- scroll
    |
    v
browser input adapter
    |
    v
page state
    |
    v
snapshot diff / verification ----> refresh model / replan
```

## Regression coverage

The current suite covers graph routing, directional scoring, target geometry, minimum-jerk trajectories, virtual-touchpad boundaries, long-stroke splitting, adapter mappings, learned focus topology, focus execution, modality-aware A* planning, semantic state verification, action observation, and model refresh behavior.

The optional live Chromium smoke test additionally checks open-Shadow-DOM traversal, shadow-aware identity, deep focus, and ARIA state extraction in a real browser process.

## Next implementation slices

1. CDP `DOMSnapshot` + Accessibility identity fusion using stable backend/AX node IDs.
2. Frame-to-main coordinate normalization and explicit enter/exit-frame graph edges.
3. Occlusion-aware hit testing and click-point validation against actual paint order.
4. Scroll-reveal edge generation and viewport-state planning.
5. A plan executor that dispatches graph edges, verifies each transition, updates costs from observations, and replans after divergence.
6. Calibration profiles for touchpad size, pointer gain, and deterministic device/test profiles.
