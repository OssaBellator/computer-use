# Semantic Browser Interaction Engine

A TypeScript foundation for a standalone, closed-loop browser agent that can eventually perform the broad range of tasks people carry out on the web.

The engine can launch Chromium directly through Node, speak browser-root CDP over Chromium's `--remote-debugging-pipe`, route its own page sessions, build semantic/spatial interaction state, plan and verify actions, manage multiple pages and browser lifecycle features, and run bounded realtime control with automatic game visual perception, temporal motion tracking, resilient renderer lifecycle, and relative mouse-look input.

## Scope

The primary Chromium path does **not** require Playwright, Puppeteer, Selenium/WebDriver, or a third-party CDP websocket client. Browser startup, target/session routing, semantic observation, navigation, input, and multi-page task execution can run on the repository's own Node + CDP runtime. A structural Playwright-compatible input adapter remains only as an optional compatibility surface for callers that already have one.

The project uses browser-native input/protocol operations rather than page-side synthetic `dispatchEvent()` calls. It is designed for browser testing, HCI research, accessibility tooling, reproducible workflows, and permitted interactive-page/game use. It does **not** claim hardware provenance, indistinguishability from a physical user, or anti-bot bypass capability. It does not include stealth patches, fingerprint spoofing, CAPTCHA bypass, navigator mutation, or timing camouflage intended to evade anti-abuse systems.

## Long-term web task capability scope

The eventual goal is a general browser agent capable of completing tasks across seven broad human web-activity categories:

1. **Information retrieval & research** — search, factual/news/weather lookup, guides, academic/market/product research, and synthesis across multiple sources.
2. **Communication & collaboration** — messaging, email, conferencing controls, shared documents/whiteboards, project-management and asynchronous team workflows.
3. **Transactions & commerce** — shopping, banking/bill workflows where permitted, bookings/reservations, travel, and subscription management.
4. **Content consumption & entertainment** — articles/forums/ebooks, streaming media controls, and browser-based games.
5. **Content creation & publishing** — writing/posting, media upload, design/editing tools, and browser coding environments.
6. **Identity & account management** — forms, profiles/privacy settings, password flows, and user-mediated identity/MFA steps.
7. **Automation & process triggering** — submitting workflows, initiating web-app automations/webhooks, and scheduling tasks through browser interfaces.

Capabilities that have financial, identity, security, or external side effects still need explicit policy/confirmation boundaries at the task layer; broad task coverage is not a reason to weaken fail-closed interaction or navigation rules.

## Current architecture

### Standalone browser runtime

- direct Chromium launch through Node `child_process`
- Chromium `--remote-debugging-pipe` transport over child fd 3/4; no debugging HTTP port required
- in-repo NUL-framed CDP JSON transport with flattened target-session routing
- bounded message size, pending-command count, and per-command timeout
- protocol error code/message/data preserved in `CdpProtocolError`
- malformed transport input fails closed and rejects pending work
- event-listener failures isolated from transport parsing
- disposable profile creation/cleanup with explicit preservation option
- Chromium sandbox remains enabled unless `noSandbox: true` is explicitly requested
- browser version handshake before the runtime is considered ready
- direct page target discovery, attachment, activation, creation, and closing
- one-call `launchStandaloneBrowserAgent()` composition into `MultiPageCdpAgent` and `MultiPageTaskEngine`

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
- bounded automatic game-surface acquisition across canvas, video, iframe, and `role=application` candidates
- deterministic game-region ranking with browser-authoritative visible clips and hard search/result bounds
- resilient game-region leases that cheaply refresh stable backend geometry and reacquire replaced renderers
- renderer generations for resetting renderer-specific perception state only across identity changes
- bounded screenshot capture for canvas/paint-only state, with crop/format/size controls and content hashes
- clipped screenshot downscaling before image bytes cross the CDP boundary
- local PNG differencing with sampled changed-pixel fractions, motion tiles, and coarse motion bounds
- viewport-coordinate mapping for motion regions extracted from downscaled crops
- bounded connected-motion-region tracks with stable IDs, velocity, confidence, missed-sample decay, and short projection
- coordinate-space and incompatible-dimension reset guards for temporal visual association
- composed `CdpGameVisualPipeline` that synchronizes renderer leases, screenshot clips, motion baselines, and temporal reset boundaries in one observation call
- separate renderer/perception generations so layout resize can reset visual baselines without pretending renderer identity changed

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

- CDP input adapter used by the standalone Chromium path
- optional structural Playwright-compatible mouse/keyboard adapter with no hard Playwright runtime dependency
- persistent `keyDown`/`keyUp` and pointer-button state for controls held across multiple frames
- relative pointer deltas on bundled adapters for mouse-look style movement while other controls remain held
- capability-detected realtime `pointerDelta` intents with fail-closed handling for unsupported adapters
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

### Browser lifecycle and closed-loop actions

- deterministic semantic target resolution by stable ID, role, name, capability, visibility, and enabled state
- optional `requireUnambiguous` guard prevents input dispatch for tied semantic matches
- pointer/keyboard target acquisition
- verified semantic `activate()` and `typeInto()` actions
- pointer targets revalidated immediately before click after cursor travel
- action-specific observation settling with bounded polling
- focus and editable-value verification
- ARIA state transition detection (`expanded`, `checked`, `selected`, `pressed`, active descendant, disabled)
- top-level and nested scroll reveal with geometry feedback and stall detection
- guarded top-level navigation plus history/reload operations
- page target creation/closing/switching and popup lifecycle tracking
- dialog handling, selection controls, downloads, uploads, and optional network-activity tracking
- high-level `InteractionEngine`, `CdpBrowserAgentEngine`, multi-page/task facades, and the new standalone launcher composition

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

The live suite now includes a raw-pipe process fixture that launches Chromium without a websocket/debugging port, verifies `Browser.getVersion`, attaches/creates/closes page targets, and cleans its temporary profile. A second standalone fixture runs that same runtime all the way through `MultiPageCdpAgent`/`MultiPageTaskEngine` and verifies semantic button activation plus text entry.

The wider Chromium suite also covers real open-Shadow-DOM traversal, stable CDP identity, frame identity, normalized geometry, paint-order hit testing, DOM capability extraction, keyboard chord/Shift metadata, verified semantic activation/text entry, top-level and nested wheel reveal, `aria-activedescendant` listbox navigation, roving-tabindex ownership, automatic dominant-canvas acquisition, renderer resize/replacement lifecycle, held controls across animated canvas frames, browser-reported relative mouse deltas while a keyboard control remains held, temporal velocity estimation from real canvas screenshots, the composed visual pipeline across movement/resize/renderer replacement, and downscaled visual-motion sampling.

## Architecture

```text
Node
 |
 | child_process + --remote-debugging-pipe
 v
CdpPipeConnection
 |
 v
CdpTargetSessionRouter ---------------- browser-root lifecycle
 |
 +-------------------+-------------------+
 |                   |                   |
 v                   v                   v
page session      page session       page session
 |                   |                   |
 +---------- MultiPageCdpAgent ---------+
                     |
              MultiPageTaskEngine
                     |
        +------------+-------------+
        |                          |
        v                          v
semantic DOM/AX/geometry      CdpGameVisualPipeline
        |                          |
        v                    clipped screenshots
InteractionModel                  |
        |                    motion/temporal tracks
        v                          |
modality-aware planner            v
        |                   RealtimeControlLoop
        +------------+-------------+
                     |
          browser-native CDP input
                     |
                     v
                 web page/game
```

## Regression coverage

The unit/regression suite covers raw CDP pipe framing and flattened-session routing, protocol-error propagation, transport limits/fail-closed behavior, graph routing, directional scoring, conservative spatial priors, learned focus and Arrow-key topology, active-descendant state anchors, roving composite ownership/boundaries, negative-tabindex Arrow destinations, modality-aware A*, planner cost explanations, target resolution/ambiguity, stable identities, frame mapping, geometry normalization, overflow clipping, nested scroll scopes, hit-tested target points, target-width calculations, deterministic/bounded game-region ranking, stable game-region refresh/reacquisition generations, composed visual-pipeline baseline generations, connected visual-motion regions, temporal track identity, velocity/projection, confidence decay, temporal coordinate-space/dimension resets, minimum-jerk trajectories, virtual-touchpad boundaries, finger/cursor transfer separation, long-stroke splitting, keyboard/mouse adapter mappings, relative pointer accumulation, modifier semantics, bounded/downscaled screenshot capture, PNG tile differencing and motion bounds, realtime observation freshness/cadence, realtime held-input diffs and cleanup, relative mouse-look capability/error handling, realtime time/tick budget enforcement, snapshot diffing, observation settling, semantic activation/typing, pointer target revalidation, scroll reveal, browser lifecycle controllers, empirical edge costs, action dispatch, high-level engine acquisition, and replanning after divergence.

See [`docs/standalone-chromium-runtime.md`](docs/standalone-chromium-runtime.md) for the dependency-free Chromium process/CDP path, [`docs/realtime-control-loop.md`](docs/realtime-control-loop.md) for continuous input mechanics, [`docs/relative-game-input.md`](docs/relative-game-input.md) for relative mouse-look semantics and pointer-lock caveats, [`docs/game-region-acquisition.md`](docs/game-region-acquisition.md) for automatic visual-region discovery, [`docs/game-region-lifecycle.md`](docs/game-region-lifecycle.md) for stable renderer refresh/reacquisition semantics, [`docs/temporal-visual-tracking.md`](docs/temporal-visual-tracking.md) for bounded motion-region tracking and projection, [`docs/game-visual-pipeline.md`](docs/game-visual-pipeline.md) for the composed observation path, and [`docs/fast-visual-perception.md`](docs/fast-visual-perception.md) for downscaled visual sampling and motion differencing.

## Current limitations / next slices

1. **Cross-category task capability model:** the seven target task families are now explicit scope, but the runtime needs a machine-readable capability taxonomy and task requirements so planners can fail early when a workflow needs an unsupported primitive.
2. **Permissions, clipboard, media and user-mediated authentication:** general communication/content/identity workflows need first-class permission state, clipboard operations, media/fullscreen state, and explicit boundaries for MFA/passkeys/identity prompts.
3. **Document/editor semantics:** content creation and collaboration need selection/range editing, rich-text/contenteditable semantics, drag/drop, clipboard-rich content, and editor-specific verification beyond simple text inputs.
4. **Transaction safety:** commerce/booking/account flows need stronger commitment detection, amount/recipient/order summaries, and explicit confirmation gates immediately before irreversible side effects.
5. **Pointer capture state:** relative movement is available, but pointer-lock acquisition, loss detection, and recovery are not yet first-class control-loop state.
6. **Semantic visual understanding and global motion:** temporal tracks follow coarse change regions; camera/scroll motion separation and higher-level appearance/task association are still needed.
7. **Game-specific control discovery:** input primitives exist, but arbitrary games still need bounded discovery/calibration of which controls affect which observed state variables.
8. **Composite key and frame traversal semantics:** model orientation/wrapping/Home/End/Page keys plus explicit cross-frame keyboard traversal.
9. **Snapshot efficiency and trace/replay:** reduce full-tree refresh cost and add deterministic non-sensitive execution replay/checkpointing.
10. **Browser-engine portability:** the standalone path is intentionally Chromium/CDP-first. Firefox/WebKit support should use native in-repo protocol adapters rather than reintroducing a framework dependency.
