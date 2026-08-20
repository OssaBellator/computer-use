# Semantic Browser Interaction Engine

A TypeScript foundation for a standalone, closed-loop browser agent intended to cover the broad range of tasks people perform on the web while keeping browser actions bounded, observable, and policy-controlled.

The primary Chromium path launches the browser directly from Node, speaks CDP over Chromium's `--remote-debugging-pipe`, routes page sessions in-repo, reads structured document content, builds semantic/spatial interaction state, plans and verifies actions, manages multiple pages and browser lifecycle features, supports bounded rich-document selection/editing, runs realtime game control/perception, and now adds page-grounded commitment detection before high-consequence actions.

## Scope

The primary Chromium architecture does **not** require Playwright, Puppeteer, Selenium/WebDriver, or a third-party CDP websocket client. A structural Playwright-compatible input adapter remains optional for callers that already have one; it is not required by the standalone runtime.

The project uses browser-native input/protocol operations rather than page-side synthetic `dispatchEvent()` calls. It targets browser testing, HCI research, accessibility tooling, reproducible workflows, and permitted interactive-page/game use. It does **not** claim hardware provenance, anti-bot bypass, CAPTCHA bypass, fingerprint spoofing, navigator mutation, stealth patches, or timing camouflage intended to evade abuse controls.

## Seven web-task categories

The long-term target is broad capability across:

1. **Information Retrieval & Research** — search, factual/news/weather lookup, guides, academic/market/product research, and synthesis.
2. **Communication & Collaboration** — messaging/email, shared documents, whiteboards, conferencing controls, project/team workflows.
3. **Transactions & Commerce** — shopping, permitted banking/bill workflows, bookings/reservations, travel, and subscriptions.
4. **Content Consumption & Entertainment** — articles/forums/ebooks, media controls, and browser games.
5. **Content Creation & Publishing** — writing/posting, media upload, design/editing tools, browser coding environments.
6. **Identity & Account Management** — forms, profiles/privacy/password settings, and user-mediated MFA/identity steps.
7. **Automation & Process Triggering** — submitting workflows, triggering web-app automations/webhooks, and scheduling through browser interfaces.

`WEB_TASK_CATEGORY_DEFINITIONS`, `WEB_TASK_CATEGORY_CAPABILITY_TARGETS`, and standalone capability profiles make that scope machine-readable. `supported`, `partial`, and `unsupported` are kept distinct so broad coverage is not inferred from generic clicking and typing.

## Current standalone profile: 0.40

The historical `STANDALONE_CHROMIUM_CAPABILITY_PROFILE` remains the immutable 0.35 snapshot. `CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE` describes the current stack.

### Strong foundations

- Node → Chromium `--remote-debugging-pipe` → in-repo CDP framing/session routing
- semantic/spatial interaction graph, modality-aware planning, verification, and closed-loop replanning
- bounded `TaskProgram` / `TaskRuntime` execution
- multi-page target lifecycle, navigation/history, dialogs, selection controls, downloads/uploads, optional network-idle observation
- bounded structured document reading across frames and open Shadow DOM
- browser state and visual observation
- keyboard, pointer, relative-pointer, wheel, select, text-entry, and browser-native CDP input
- realtime held-input control, automatic game-surface acquisition, renderer lifecycle, visual motion sampling/tracking, and composed game visual pipeline
- explicit approval/max-risk policy boundaries

### Partial foundations

- **Rich-text editing:** bounded DOM/text-control selection and caret observation plus native insertion/replacement/select-all/delete; formatting runs, rich clipboard, drag/drop, and editor-specific model verification remain incomplete.
- **Commitment detection:** strong and context-corroborated purchase/booking/transfer/subscription/publish/destructive/security/process actions are inferred from bounded semantic/document state immediately before activation; site-specific semantics remain heuristic.
- **External side-effect verification:** generic browser/action verification exists, but transaction/publication/process outcomes are not yet bound to a typed pre-commit summary.
- uploads/download observation and network activity depend on explicit configuration where documented.
- generic media and user-mediated authentication flows are reachable, but media/fullscreen/permission/MFA/passkey state is not yet first-class.

### Transaction status

At 0.40, `transactions-commerce` is mechanically **runnable** in the capability model because no required primitive is completely unsupported. It is **not fully supported**: commitment detection and specialized external-side-effect verification remain partial.

This is a safety distinction, not permission for unattended financial actions. The runtime's dynamic commitment gate requires approval before inferred commitments by default.

## Commitment safety

`TaskRuntime` previously depended only on program-authored `risk` / `requiresApproval`. A program could therefore accidentally describe a `Place order` or `Confirm transfer` button as an ordinary interaction.

The 0.40 gate is additive:

- `activate`, plus Enter/Space on a focused activation control, is checked immediately before browser input;
- strong target labels such as `Place order`, `Pay now`, `Confirm transfer`, `Publish`, `Change password`, `Delete account`, or `Run workflow` can trigger approval from the semantic target alone;
- generic labels such as `Confirm`, `Submit`, `Continue`, or `Delete` request one bounded structured-document snapshot when the engine exposes that channel;
- contextual evidence can classify purchase, booking, transfer, subscription, publication, destructive, identity/security, or process-trigger commitments;
- an available document channel that fails or is too incomplete to safely rule out an ambiguous commitment fails closed through approval;
- approval callbacks may receive bounded amount/currency, explicitly labeled counterparty, schedule, recurrence, irreversibility/security flags, and evidence codes;
- ordinary traces retain only commitment status/kind/confidence, not amount/counterparty/page excerpts;
- `commitmentDetection: 'off'` is an explicit compatibility opt-out. It is not the default.

The detector does not execute transactions and does not contact payment providers. Repository regressions use synthetic local fixtures only.

See [`docs/commitment-safety.md`](docs/commitment-safety.md).

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
       +-------------+--------------+
       |             |              |
       v             v              v
 structured       semantic      visual/game
 document read    interaction    perception
       |             |              |
       +-------------+--------------+
                     |
               TaskRuntime
                     |
         pre-action target state
                     |
          bounded commitment gate
                     |
        explicit approval if needed
                     |
          browser-native CDP input
                     |
                     v
                 web page
```

## Perception and identity

The structured reader and semantic observer remain separate models rather than bloating controls with article text.

The reader covers headings, paragraphs, lists, definitions, tables, code, quotes, figure captions, links, images/alt text, landmarks, and page metadata with independent browser-side and exact host-side UTF-8/node/depth budgets. Rendered offscreen content can be read; hidden content is excluded by default. Open Shadow DOM and assigned slots are supported, and frame errors are surfaced without discarding other usable frames.

Interactive observation adds stable structural/CDP backend/accessibility identity, frame ownership, browser-authoritative geometry, visibility clipping through scroll ancestors and frame viewports, ARIA widget state, `aria-activedescendant`, browser-computed `tabIndex`, roving composite ownership, hit-tested target points, and capability inference.

## Planning and browser actions

The interaction engine combines:

- weighted semantic/spatial graph routing;
- modality-aware A* costs over time, failure, scroll, uncertainty, and switching;
- observed Tab/Shift+Tab and Arrow-key topology learning;
- conservative speculative geometry constrained by ARIA composite ownership;
- empirical edge-performance learning;
- semantic ambiguity reporting and fail-closed target acquisition;
- pointer target revalidation immediately before click;
- action-specific settling/verification and closed-loop replanning.

Browser lifecycle controllers cover navigation/history, page target creation/close/switch, dialogs, select controls, downloads/uploads, optional request-boundary navigation policy, and optional network activity.

## Rich-document editing

The current editing foundation includes:

- frame-scoped DOM/contenteditable selection state;
- focused input/textarea selection start/end/direction;
- open-shadow structural paths and editing-host identity;
- bounded selected text and geometry;
- native CDP `Input.insertText` for exact current-selection insertion/replacement;
- verified select-all and delete-selection operations;
- fail-closed ambiguous cross-frame/no-editable-selection behavior.

Formatting runs, rich clipboard, drag/drop, collaborative-editor synchronization, and editor-specific document-model verification remain future work.

## Realtime/game stack

For permitted browser games and interactive canvases, the stack includes persistent held key/button state, relative pointer deltas, independent perception/control cadence, automatic game-region acquisition, stable renderer leases/generations, cropped/downscaled screenshot sampling, local PNG differencing, connected motion regions, bounded temporal tracks/velocity/confidence, and a composed `CdpGameVisualPipeline` that resets perception baselines correctly across resize and renderer replacement.

Pointer-lock acquisition/loss/recovery, global camera-motion separation, semantic object understanding, and arbitrary-game control discovery/calibration remain open frontiers.

## Local validation

GitHub Actions is intentionally disabled. Run locally:

```bash
npm install
npm run typecheck
npm test
npm run test:chromium
```

Set `CHROMIUM_BIN=/path/to/chromium` if Chromium is not `/usr/bin/chromium`.

The Chromium suite uses local deterministic fixtures. It covers the raw remote-debugging pipe, target/session routing, semantic actions, frames/shadow DOM, structured reading, navigation/lifecycle controllers, realtime/game behavior, rich selection/insertion, and synthetic commitment safety. The commitment smoke test proves an unapproved synthetic checkout is blocked before input and an approved run performs exactly one independently verified browser activation. It does not make a real purchase or use an external merchant.

`npm run test:live` is a separate opt-in general live-site smoke path behind `RUN_LIVE_WEB=1`; it is not used for transaction testing.

## Key documentation

- [`docs/standalone-chromium-runtime.md`](docs/standalone-chromium-runtime.md) — framework-independent Chromium process/CDP path
- [`docs/task-program-runtime.md`](docs/task-program-runtime.md) — bounded control-flow runtime and policy boundary
- [`docs/document-content-observation.md`](docs/document-content-observation.md) — structured reading semantics and bounds
- [`docs/document-task-predicates.md`](docs/document-task-predicates.md) — document-driven task conditions
- [`docs/rich-document-selection.md`](docs/rich-document-selection.md) — selection/caret and native insertion foundation
- [`docs/commitment-safety.md`](docs/commitment-safety.md) — dynamic pre-commit detection and approval
- [`docs/web-task-capabilities.md`](docs/web-task-capabilities.md) — seven-category capability model
- [`docs/realtime-control-loop.md`](docs/realtime-control-loop.md), [`docs/fast-visual-perception.md`](docs/fast-visual-perception.md), [`docs/game-region-acquisition.md`](docs/game-region-acquisition.md), [`docs/game-region-lifecycle.md`](docs/game-region-lifecycle.md), [`docs/temporal-visual-tracking.md`](docs/temporal-visual-tracking.md), and [`docs/game-visual-pipeline.md`](docs/game-visual-pipeline.md) — realtime/game stack

## Current frontier

Highest-leverage remaining work:

1. **Commit-bound post-side-effect verification** — bind the state after approval/action to the pre-commit summary and distinguish completed/pending/declined/canceled plus changed amount/recipient/recurrence/publication/process identity.
2. **Rich clipboard/formatting/drag-drop/editor verification** — needed for broad collaboration and content creation/publishing.
3. **Permissions/media/user-mediated authentication** — first-class permission, fullscreen/playback, MFA/passkey handoff, and user-presence state.
4. **Long-running checkpoint/replay** — durable, non-sensitive restartable task progress.
5. **Research refinement** — article/main-content ranking, boilerplate suppression, richer table relationships, incremental document diffs, and targeted refresh.
6. **Pointer capture and semantic visual understanding** — pointer-lock state, camera/global-motion separation, object/task association.
7. **Game control discovery/calibration** — bounded inference of which controls affect which observed state variables.
8. **Browser-engine portability** — native in-repo protocol runtimes for non-Chromium engines rather than reintroducing framework dependence.
