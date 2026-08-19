# Semantic Browser Interaction Engine

A TypeScript foundation for closed-loop browser interaction research, accessibility tooling, and reproducible UI testing.

The engine models a page as a semantic/spatial interaction graph, combines DOM semantics with CDP-backed identity and geometry, learns observed keyboard topology, plans across input modalities, and verifies browser state after execution instead of assuming an issued command succeeded.

## Scope

The project uses normal browser automation mouse/keyboard primitives rather than page-side `dispatchEvent()` calls. It is designed for browser testing and HCI experiments, but it does **not** claim hardware provenance, indistinguishability from a physical user, or anti-bot bypass capability.

## Current architecture

### Perception and identity

- frame-aware interactive DOM snapshots
- traversal of open Shadow DOM, including non-interactive shadow hosts
- shadow-boundary-aware structural identities
- deep focus observation inside open shadow roots
- accessible-name heuristics and common ARIA widget state
- native-control capability inference that distinguishes text entry from activation controls
- stable CDP backend-node identity with accessibility-node enrichment
- frame identity mapping and main-frame coordinate normalization
- viewport-clipped and main-viewport geometry
- paint-order target validation before pointer acquisition

### Interaction model and planning

- weighted semantic/spatial interaction graph
- modality-aware A* planning over time, failure, scrolling, uncertainty, and switching cost
- observed `Tab` / `Shift+Tab` focus-topology learning
- observed Arrow-key directional-topology learning
- geometric directional neighbors retained only as conservative speculative priors
- empirical edge-performance learning from real execution outcomes
- direct pointer-edge estimates using target geometry and a Fitts-style duration prior
- closed-loop replanning when an observed transition diverges from the plan

### Input and motor control

- structural Playwright-compatible mouse/keyboard adapter with no hard Playwright runtime dependency
- CDP input adapter for Chromium testing
- deterministic US-keyboard mapping for letters, digits, punctuation, modifiers, and chords
- modifier-aware suppression of printable text for control/meta/alt shortcuts
- deterministic minimum-jerk cursor trajectories
- separate virtual finger-space and viewport cursor-space state
- bounded touchpad strokes with lift/recenter behavior
- oversized trajectory segments split into bounded virtual strokes
- cursor state contains coordinates only; trajectory timing metadata is kept separate

### Closed-loop actions

- deterministic semantic target resolution by stable ID, role, name, capability, visibility, and enabled state
- pointer/keyboard target acquisition
- verified semantic `activate()` and `typeInto()` actions
- action-specific observation settling with bounded polling
- focus and editable-value verification
- ARIA state transition detection (`expanded`, `checked`, `selected`, `pressed`, active descendant, disabled)
- off-screen target reveal with viewport geometry feedback and stall detection
- high-level `InteractionEngine` combining target resolution, reveal, planning, dispatch, observation, and replanning
- `createCdpInteractionEngine()` convenience facade for a CDP page/session pair

## Local validation

Install the TypeScript development dependencies and run:

```bash
npm install
npm run typecheck
npm test
```

The regression suite uses Node's built-in test runner; GitHub Actions is not required.

If Chromium is installed locally, the live smoke suite exercises browser-level behavior:

```bash
npm run test:chromium
```

Set `CHROMIUM_BIN=/path/to/chromium` when Chromium is not at `/usr/bin/chromium`.

The live suite covers real open-Shadow-DOM traversal, stable CDP identity, frame identity, normalized geometry, paint-order hit testing, DOM capability extraction, keyboard chord/Shift metadata, engine acquisition, and off-screen wheel reveal.

## Architecture

```text
semantic goal
    |
    v
DOM + AX + frame + geometry observer
    |
    v
InteractionModel <---- observed focus/directional topology
    |                         ^
    v                         |
modality-aware A* planner     |
    |                         |
    +---- keyboard -----------+
    |
    +---- pointer -> trajectory -> bounded touchpad
    |
    +---- reveal/scroll -> geometry feedback
    |
    v
browser input adapter
    |
    v
page state
    |
    v
snapshot diff / action verification
    |
    +---- edge performance update
    |
    +---- refresh model / replan
```

## Regression coverage

The unit/regression suite covers graph routing, directional scoring, conservative spatial priors, learned focus and Arrow-key topology, modality-aware A*, target resolution, stable identities, frame mapping, geometry normalization, hit-tested target points, target-width calculations, minimum-jerk trajectories, virtual-touchpad boundaries, long-stroke splitting, keyboard/mouse adapter mappings, modifier semantics, snapshot diffing, observation settling, semantic activation/typing, scroll reveal, empirical edge costs, action dispatch, high-level engine acquisition, and replanning after divergence.

## Current limitations / next slices

1. **Nested scroll containers:** reveal currently issues wheel input and verifies resulting main-viewport geometry; selecting and planning through the correct nested scroll container should become an explicit graph capability.
2. **Composite widgets:** use `aria-activedescendant`, roving tabindex, and widget-specific observed transitions to model listbox/menu/grid navigation more precisely.
3. **Explicit frame traversal edges:** pointer geometry is normalized across frames, but keyboard/frame ownership should be represented as first-class enter/exit-frame graph transitions.
4. **Snapshot efficiency:** reduce full-tree observation cost through incremental invalidation and targeted refresh while preserving stable backend/AX identity.
5. **Calibration profiles:** make touchpad size, pointer gain, keyboard layout, and deterministic device/test profiles explicit configuration objects.
6. **Ambiguity reporting:** expose ranked target candidates and planner explanations when multiple semantic targets are plausible.
