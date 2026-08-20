# Semantic Browser Interaction Engine

A TypeScript foundation for closed-loop browser interaction research, accessibility tooling, reproducible UI testing, and permitted interactive-page/game experiments.

The engine models a page as a semantic/spatial interaction graph, combines DOM semantics with CDP-backed identity and geometry, learns observed keyboard topology, plans across input modalities, verifies browser state after execution instead of assuming an issued command succeeded, and includes bounded realtime control with lower-frequency spatial visual perception for fast-changing canvas state.

## Scope

The project uses normal browser automation mouse/keyboard primitives rather than page-side `dispatchEvent()` calls. It is designed for browser testing, HCI experiments, and permitted interactive-page/game fixtures, but it does **not** claim hardware provenance, indistinguishability from a physical user, or anti-bot bypass capability. It does not include stealth patches, fingerprint spoofing, CAPTCHA handling, navigator mutation, or timing camouflage intended to evade anti-abuse systems.

## Current architecture

### Perception and identity

- frame-aware interactive DOM snapshots
- traversal of open Shadow DOM, including non-interactive shadow hosts
- shadow-boundary-aware structural identities
- deep focus observation inside open shadow roots
- accessible-name heuristics and common ARIA widget state
- `aria-activedescendant` resolution into structural interaction identity
- browser-computed `tabIndex` plus nearest ARIA composite ownership for roving members
- native-control capability inference that distinguishes text entry from activation controls
- plain overflow containers represented as scroll-capable interaction nodes
- visibility clipped through overflow ancestors as well as the browser viewport
- nearest independently scrollable ancestor recorded for clipped descendants
- stable CDP backend-node identity with accessibility-node enrichment
- frame identity mapping and main-frame coordinate normalization
- viewport-clipped and main-viewport geometry
- paint-order target validation before pointer acquisition
- bounded screenshot capture for canvas/paint-only state, with crop/format/size controls and content hashes
- clipped screenshot downscaling before image bytes cross the CDP boundary
- local PNG differencing with sampled changed-pixel fractions, motion tiles, and coarse motion bounds
- viewport-coordinate mapping for motion regions extracted from downscaled crops

### Interaction model and planning

- weighted semantic/spatial interaction graph
- modality-aware A* planning over time, failure, scrolling, uncertainty, and switching cost
- observed `Tab` / `Shift+Tab` focus-topology learning
- observed Arrow-key directional-topology learning
- active-descendant logical option-space with zero-input `state-anchor` bridges
- geometric directional neighbors retained only as conservative speculative priors
- composite owners excluded from speculative Arrow source/candidate space
- roving/composite speculative Arrow edges constrained to siblings with the same composite owner
- negative-tabindex composite members retained as Arrow destinations even when not directly tabbable
- empirical edge-performance learning from real execution outcomes
- direct pointer-edge estimates using target geometry and a Fitts-style duration prior
- per-step planner cost explanations matching actual path cost semantics
- semantic target ambiguity reporting with optional fail-closed acquisition
- closed-loop replanning when an observed transition diverges from the plan

### Input and motor control

- structural Playwright-compatible mouse/keyboard adapter with no hard Playwright runtime dependency
- CDP input adapter for Chromium testing
- persistent `keyDown`/`keyUp` and pointer-button state for controls held across multiple frames
- bounded realtime control loop that diffs desired held state instead of repeatedly issuing key presses
- independently configurable visual/semantic observation cadence versus faster control-tick cadence
- explicit observation freshness and age metadata on each realtime policy decision
- hard realtime tick/time budgets and guaranteed held-input cleanup on stop, failure, or budget exhaustion
- deterministic US-keyboard mapping for letters, digits, punctuation, modifiers, and chords
- modifier-aware suppression of printable text for control/meta/alt shortcuts
- deterministic minimum-jerk cursor trajectories
- separate virtual finger-space and viewport cursor-space state
- bounded touchpad strokes with lift/recenter behavior
- standalone touchpad transfer simulation separated from pointer-controller cursor calibration
- oversized trajectory segments split into bounded virtual strokes
- cursor state contains coordinates only; trajectory timing metadata is kept separate

### Closed-loop actions

- deterministic semantic target resolution by stable ID, role, name, capability, visibility, and enabled state
- optional `requireUnambiguous` guard prevents input dispatch for tied semantic matches
- pointer/keyboard target acquisition
- verified semantic `activate()` and `typeInto()` actions
- pointer targets revalidated immediately before click after cursor travel
- action-specific observation settling with bounded polling
- focus and editable-value verification
- ARIA state transition detection (`expanded`, `checked`, `selected`, `pressed`, active descendant, disabled)
- top-level off-screen reveal with viewport geometry feedback and stall detection
- nested overflow-container reveal by moving over the identified scroll scope, issuing wheel input, and re-observing geometry
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

The live suite covers real open-Shadow-DOM traversal, stable CDP identity, frame identity, normalized geometry, paint-order hit testing, DOM capability extraction, keyboard chord/Shift metadata, verified semantic activation/text entry, top-level and nested wheel reveal, `aria-activedescendant` listbox navigation with DOM focus retained on the composite owner, roving-tabindex ownership that keeps speculative Arrow planning inside the widget, held CDP controls across animated canvas frames, and a downscaled visual-motion fixture where control ticks outnumber screenshot captures.

## Architecture

```text
semantic goal / realtime policy
    |
    +-------------------------------------+
    |                                     |
    v                                     v
DOM + AX + frame + geometry        clipped/downscaled visual capture
observer                                  |
    |                                     v
    +---- overflow clipping         PNG tile/motion differ
    |                                     |
    +---- DOM focus ---- state-anchor      |
    |                    |                 |
    v                    v                 v
InteractionModel <---- observed topology  cached observation
    |                                     |
    v                                     v
modality-aware A* planner          RealtimeControlLoop
    |                              (fast control ticks)
    +---- keyboard -----------------------+
    |
    +---- pointer -> trajectory -> bounded touchpad
    |
    +---- reveal/scroll -> scoped wheel -> geometry feedback
    |
    v
browser input adapter
    |
    v
page / game state
    |
    +---- next semantic snapshot
    |
    +---- next scheduled visual sample
```

## Regression coverage

The unit/regression suite covers graph routing, directional scoring, conservative spatial priors, learned focus and Arrow-key topology, active-descendant state anchors, roving composite ownership/boundaries, negative-tabindex Arrow destinations, modality-aware A*, planner cost explanations, target resolution/ambiguity, stable identities, frame mapping, geometry normalization, overflow clipping, nested scroll scopes, hit-tested target points, target-width calculations, minimum-jerk trajectories, virtual-touchpad boundaries, finger/cursor transfer separation, long-stroke splitting, keyboard/mouse adapter mappings, modifier semantics, bounded/downscaled screenshot capture, PNG tile differencing and motion bounds, realtime observation freshness/cadence, realtime held-input diffs and cleanup, realtime time/tick budget enforcement, snapshot diffing, observation settling, semantic activation/typing, pointer target revalidation, scroll reveal, empirical edge costs, action dispatch, high-level engine acquisition, and replanning after divergence.

See [`docs/realtime-control-loop.md`](docs/realtime-control-loop.md) for continuous input mechanics and [`docs/fast-visual-perception.md`](docs/fast-visual-perception.md) for downscaled visual sampling, motion differencing, and decoupled perception/control cadence.

## Current limitations / next slices

1. **Temporal visual state:** motion regions are frame-pair observations; add short bounded tracks, velocity estimates, and confidence decay so policies can reason about moving entities between visual captures.
2. **Game-region acquisition:** clips are currently caller-supplied; add deterministic canvas/video/known-element region discovery and safe region refresh when layout changes.
3. **Composite key semantics:** ownership and roving tabindex bound speculative Arrow space; model orientation, wrapping, Home/End, PageUp/PageDown, and richer grid/menu/tree-specific transitions explicitly.
4. **Explicit frame traversal edges:** pointer geometry is normalized across frames, but keyboard/frame ownership should be represented as first-class enter/exit-frame graph transitions.
5. **Snapshot efficiency:** reduce full-tree observation cost through incremental invalidation and targeted refresh while preserving stable backend/AX identity.
6. **Control trace/replay:** record deterministic non-sensitive control/perception metadata and support replay without storing screenshot bytes by default.
7. **Multi-level scroll planning:** nested reveal handles the nearest reachable scroll scope; plan explicitly through multiple nested scroll scopes and page scrolling when more than one level must move.
8. **Action semantics:** expand verification for navigation, dialogs, selection commits, and form submission while retaining fail-closed observation rules.
