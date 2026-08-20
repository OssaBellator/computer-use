# Semantic Browser Interaction Engine

A TypeScript foundation for a standalone, closed-loop browser agent that is now being generalized into a bounded **computer-use core with environment adapters**. Chromium remains the first high-fidelity adapter: it launches directly from Node, speaks CDP over `--remote-debugging-pipe`, observes structured/semantic/visual state, dispatches browser-native input, and verifies important effects without requiring Playwright, Puppeteer, Selenium/WebDriver, or a third-party CDP client.

The long-term architecture is not “browser automation plus desktop special cases.” Browser, desktop UI, filesystem, terminal/process, remote-session, and device integrations are intended to be peer adapters beneath shared identity, observation, effect-policy, dispatch, verification, and recovery contracts.

## Scope and safety boundary

The project targets browser testing, HCI/accessibility tooling, reproducible workflows, permitted interactive-page/game use, and eventually bounded local computer tasks. It uses native browser/protocol operations rather than page-side synthetic `dispatchEvent()` interaction where a browser-native path exists.

It does **not** claim hardware provenance, anti-bot/CAPTCHA bypass, fingerprint spoofing, stealth patches, or abuse-control evasion. The new computer-use core also does not imply that native OS capabilities already exist: direct filesystem, terminal, process, desktop accessibility, remote desktop/SSH, system settings, and hardware/device adapters are still future work.

## Web-task scope

The browser capability model continues to target seven broad web-task categories:

1. **Information Retrieval & Research** — search, factual/news/weather lookup, guides, academic/market/product research, and synthesis.
2. **Communication & Collaboration** — messaging/email, shared documents, whiteboards, conferencing controls, and team workflows.
3. **Transactions & Commerce** — shopping, permitted banking/bill workflows, bookings/reservations, travel, and subscriptions.
4. **Content Consumption & Entertainment** — articles/forums/ebooks, media controls, and browser games.
5. **Content Creation & Publishing** — writing/posting, media upload, design/editing tools, and browser coding environments.
6. **Identity & Account Management** — forms, profiles/privacy/password settings, and user-mediated identity steps.
7. **Automation & Process Triggering** — submitting workflows, triggering web-app automations, and scheduling through browser interfaces.

`WEB_TASK_CATEGORY_DEFINITIONS`, `WEB_TASK_CATEGORY_CAPABILITY_TARGETS`, and the standalone Chromium profiles keep `supported`, `partial`, and `unsupported` mechanically distinct.

## Computer-use direction

The environment-neutral core adds a second, broader seven-category model:

1. **Document Creation & Media Production** — office documents, spreadsheets, presentations, media/design/3D tools, IDE editing/build/debug workflows.
2. **Data Processing & Analytics** — calculations, statistical/financial analysis, local model execution, CAD, and scientific simulation.
3. **File & Storage Management** — directory organization, compression, backups, storage management, and synchronization.
4. **System Administration & Security** — OS/peripheral settings, software installation/updates, security controls, diagnostics, and resource monitoring.
5. **Communication & Remote Access** — desktop messaging/conferencing, VoIP, RDP/VNC, and SSH sessions.
6. **Gaming & Digital Entertainment** — locally installed games/emulators/VR and offline media playback.
7. **Process Automation** — shell scripts, macros, batch conversion, and local processing pipelines.

`ComputerEnvironmentRegistry` routes explicit adapter IDs across environment-neutral contracts. Surfaces/entities are adapter-scoped and generation-aware; observations are channelized rather than flattened into a universal “computer DOM”; side-effecting adapter exceptions become `dispatch: 'unknown'` rather than retry-safe failures; and generic evidence is restricted to bounded machine codes.

The current browser-to-computer capability bridge is deliberately conservative. Browser upload/download does not become local filesystem control, browser network observation does not become general network-session control, Chromium launch plumbing does not become OS process control, and browser pages do not become SSH/RDP/VNC capability.

See [`docs/computer-use-architecture.md`](docs/computer-use-architecture.md).

## Current standalone Chromium profile: 0.43

The historical `STANDALONE_CHROMIUM_CAPABILITY_PROFILE` remains the immutable 0.35 snapshot. `CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE` now describes the 0.43 browser stack.

### Strong browser foundations

- Node → Chromium `--remote-debugging-pipe` → in-repo CDP framing/session routing.
- Semantic/spatial interaction graph, modality-aware planning, verification, and closed-loop replanning.
- Bounded `TaskProgram` / `TaskRuntime` execution.
- Multi-page lifecycle, navigation/history, dialogs, select/range controls, downloads/uploads, and optional network-idle observation.
- Structured document reading across frames/open Shadow DOM plus derived main-content ranking, boilerplate classification, table relationships, deterministic document diffs, and targeted refresh hints.
- Browser state, screenshots, visual differencing, motion regions, temporal tracks, and game visual pipeline.
- Browser-native keyboard/pointer/wheel/text/select input, relative pointer input, pointer-lock lifecycle, and bounded realtime control.
- Game-region/renderer lifecycle plus bounded control/effect calibration with explicit key-probe safety attestation.
- Explicit risk/approval gates and retry-safe commitment-result handling.

### Partial browser foundations

- **Rich-document editing:** frame-scoped selection/caret, formatting-run observation, native insertion/replacement/select-all/delete, and verified bold/italic/underline. Rich clipboard/editor-model synchronization and collaborative-editor-specific verification remain incomplete.
- **Clipboard:** explicit bounded `text/plain` / `text/html` reads and writes with normal browser permission/user-activation policy. Passive clipboard observation and general rich-editor integration remain incomplete.
- **Drag/drop:** Chromium-native intercepted `DragData` transfer, bounded privacy-preserving metadata, file-bearing drops blocked by default, and explicit `dragCancel` on rejected transfers. Semantic target acceptance and task-policy integration remain incomplete.
- **Media/fullscreen/permissions:** first-class HTML media observation/control, page/browser-window fullscreen state, and page-visible permission/policy observation. Browser activation rules are not bypassed and sensitive permissions are not auto-granted.
- **Commitment detection and result verification:** strong/context-corroborated commitments are approval-gated; approved actions receive fresh target/material/result-neutral preflight, exactly one dispatch, bounded outcome polling, material mismatch checks, and provider-neutral labeled result identity. Provider/site semantics remain incomplete.
- **Checkpointing:** a versioned deterministic, integrity-checked, execution-bound, deeply frozen checkpoint codec exists, but durable persistence and `TaskRuntime` resume integration are not yet wired.
- Upload/download observation and network monitoring remain configuration-dependent where documented.

### Web-category status

`information-retrieval-research` is mechanically strong on the current browser profile. `transactions-commerce` is mechanically **runnable but not fully supported** because commitment detection/result verification remain partial. `content-creation-publishing` is also now **runnable but not fully supported**: rich editing, file upload, clipboard, and side-effect verification are partial rather than absent, while drag/drop remains a preferred partial capability.

“Runnable” is a capability-model statement, not permission for unattended high-consequence actions. The dynamic commitment gate still requires approval for inferred commitments by default, and a potentially consequential browser action cannot silently advance after an uncertain result.

## Commitment safety and durable result identity

Detected commitments follow a bounded chain:

**detect → approval → fresh target/material revalidation → complete neutral result baseline → exactly one dispatch → explicit result verification**

Key properties:

- Strong target labels can trigger commitment approval directly; ambiguous labels can request bounded frame-scoped structured-document context.
- Approval-time target/material state is revalidated immediately before browser input.
- A stale or incomplete result baseline blocks dispatch rather than permitting old receipt text to prove a new action.
- After dispatch, explicit outcomes are classified as `confirmed`, `pending`, `declined`, `canceled`, `mismatch`, or `unknown`; non-confirmed side effects are not automatically retried.
- Labeled bounded non-secret order/booking/transfer/subscription/publication/process/reference identifiers can strengthen result binding.
- Identifier conflict is a mismatch; unrelated pre-existing tabs cannot verify an action; cross-origin positive confirmation requires appropriate durable identity binding.
- Ordinary traces keep classification/evidence enums, not amount/counterparty/result identifier/page excerpts. Detailed bounded evidence is available only through explicit verification callbacks.

See [`docs/commitment-safety.md`](docs/commitment-safety.md) and [`docs/commitment-result-identity.md`](docs/commitment-result-identity.md).

## Browser architecture today

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
         commitment/effect policy
                     |
          browser-native CDP input
                     |
          bounded result observation
                     |
                     v
                 web page
```

## Target computer-use architecture

```text
Task / planner / policy
        |
        v
computer-use core
  identity + channel routing
  effect classification / approval
  dispatch-state tracking
  verification / retry policy
  checkpoint & recovery contracts
        |
   +----+-------------+-------------+-------------+-------------+
   |                  |             |             |             |
 browser          desktop UI    filesystem   terminal/process  remote/device
 adapter           adapter        adapter        adapters       adapters
 (CDP today)       (future)       (future)       (future)       (future)
```

Direct state adapters and UI/visual adapters are peers. The intended planner should prefer a filesystem adapter for bounded file operations, a process adapter for process state, or a terminal adapter for command execution when those interfaces are available, while retaining accessibility/visual/pointer interaction for applications that expose no better semantic channel.

## Rich-document and clipboard/drag foundations

The browser editing stack currently provides:

- frame-scoped DOM/contenteditable and focused text-control selection state;
- open-shadow structural paths and editing-host identity;
- bounded selected text/geometry;
- formatting-run and block/list/link context observation;
- native `Input.insertText` for exact insertion/replacement;
- verified select-all/delete and bold/italic/underline operations;
- explicit bounded clipboard reads/writes without permission mutation or synthetic user activation;
- native intercepted drag transfer without page-side synthetic `DragEvent` construction;
- default blocking/canceling of file-bearing drag payloads unless explicitly enabled.

A successful low-level `drop` dispatch is not treated as semantic application acceptance; higher-level editor/task verification still needs to prove the intended document/model change.

See [`docs/rich-document-selection.md`](docs/rich-document-selection.md), [`docs/rich-document-formatting.md`](docs/rich-document-formatting.md), and [`docs/clipboard-dragdrop-foundations.md`](docs/clipboard-dragdrop-foundations.md).

## Research and document state

The structured reader and interactive semantic observer remain separate. The reader captures bounded headings, paragraphs, lists, definitions, tables, code, quotes, captions, links, images/alt text, landmarks, and metadata across readable frames/open Shadow DOM. The derived research layer ranks likely primary content, identifies generic boilerplate, preserves block identities, relates table headers to rows/columns, computes bounded deterministic snapshot diffs, and emits targeted refresh hints.

Frame extraction failure is uncertainty, not evidence that content was deleted: unreadable frames do not generate exact add/remove claims.

See [`docs/document-content-observation.md`](docs/document-content-observation.md) and [`docs/document-research-ranking.md`](docs/document-research-ranking.md).

## Media, permissions, and realtime interaction

HTML media state includes playback/mute/volume/time/duration/rate plus active media identity; native media/fullscreen operations are verified and normal activation rejection is preserved. Retained media identity deliberately omits source URLs so signed/query-bearing media URLs are not persisted. Permission observation separates page-visible policy/API state from browser/profile state when the latter cannot be passively read.

For permitted realtime browser games and interactive canvases, the stack includes held key/button state, relative pointer deltas, pointer-lock acquisition/loss/recovery, independent perception/control cadence, game-region acquisition, renderer leases/generations, cropped/downscaled screenshots, local motion differencing/tracking, and bounded control/effect calibration.

Semantic object understanding, camera/global-motion separation, and general locally installed game/device control remain future work.

See [`docs/media-permission-state.md`](docs/media-permission-state.md), [`docs/pointer-lock-lifecycle.md`](docs/pointer-lock-lifecycle.md), and [`docs/game-control-calibration.md`](docs/game-control-calibration.md).

## Checkpoint foundation

`src/agent/taskCheckpoint.ts` provides a pure versioned checkpoint codec with deterministic canonical encoding, SHA-256 integrity checks, program/execution binding, bounded counters/budgets, structural history validation, immutable decoded state, and trusted-input re-binding only after compatibility checks. It deliberately excludes secrets, typed values, page excerpts, financial/counterparty data, cookies/tokens, DOM snapshots, and arbitrary browser content.

The codec is not yet a durable multi-adapter recovery runtime. The next checkpoint work must incorporate adapter/surface generation continuity without persisting arbitrary filesystem paths, terminal transcripts, command secrets, file contents, or device telemetry.

See [`docs/task-checkpoints.md`](docs/task-checkpoints.md).

## Local validation

GitHub Actions is intentionally disabled. Run locally:

```bash
npm install
npm run typecheck
npm test
npm run test:chromium
```

Set `CHROMIUM_BIN=/path/to/chromium` if Chromium is not `/usr/bin/chromium`.

Repository integration work in constrained environments may use focused strict TypeScript seams and deterministic synthetic fixtures when a full checkout is unavailable; such work must not be described as a full-suite pass. Browser integration fixtures use local synthetic pages and do not execute real purchases, payments, transfers, bookings, publications, security changes, deployments, or external device/system mutations.

`npm run test:live` remains a separate opt-in live-site smoke path behind `RUN_LIVE_WEB=1`; it is not used for transaction testing.

## Key documentation

- [`docs/computer-use-architecture.md`](docs/computer-use-architecture.md) — environment-neutral computer-use model and migration plan
- [`docs/standalone-chromium-runtime.md`](docs/standalone-chromium-runtime.md) — framework-independent Chromium process/CDP path
- [`docs/task-program-runtime.md`](docs/task-program-runtime.md) — bounded browser task runtime and policy boundary
- [`docs/task-checkpoints.md`](docs/task-checkpoints.md) — deterministic recovery-state codec foundation
- [`docs/document-content-observation.md`](docs/document-content-observation.md) and [`docs/document-research-ranking.md`](docs/document-research-ranking.md) — structured reading/research layer
- [`docs/rich-document-selection.md`](docs/rich-document-selection.md), [`docs/rich-document-formatting.md`](docs/rich-document-formatting.md), and [`docs/clipboard-dragdrop-foundations.md`](docs/clipboard-dragdrop-foundations.md) — editing/clipboard/drag foundations
- [`docs/commitment-safety.md`](docs/commitment-safety.md) and [`docs/commitment-result-identity.md`](docs/commitment-result-identity.md) — pre/post commitment safety and durable result identity
- [`docs/media-permission-state.md`](docs/media-permission-state.md) — media/fullscreen/permission primitives
- [`docs/pointer-lock-lifecycle.md`](docs/pointer-lock-lifecycle.md), [`docs/game-control-calibration.md`](docs/game-control-calibration.md), and the realtime/game documents — interactive control stack
- [`docs/web-task-capabilities.md`](docs/web-task-capabilities.md) — web capability model

## Current frontier

The highest-leverage path now follows the computer-use architecture rather than only adding browser primitives:

1. **Extract browser runtime behind neutral computer-use ports** — make the existing browser stack a real `ComputerEnvironmentAdapter` without changing browser behavior.
2. **Read-only filesystem and process adapters** — bounded enumeration/stat/read and process/resource observation with explicit roots/identity/privacy limits; no mutation yet.
3. **Generalize checkpoint continuity** — adapter/surface/entity generations and safe multi-adapter restart without replaying uncertain side effects.
4. **Desktop accessibility observation** — separate Windows UI Automation, macOS Accessibility, and Linux AT-SPI adapters rather than introducing a mandatory automation framework.
5. **Bounded filesystem mutation** — typed create/write/move/copy/delete operations with fresh-state preflight, explicit approval where destructive, and exact post-operation verification.
6. **Terminal/process execution** — command/session/process identity, bounded output, exit verification, and no automatic retry after uncertain dispatch.
7. **Native application controllers** — office/spreadsheet/presentation, IDE/build/debug, media/design/CAD workflows layered over direct state plus accessibility/visual fallback.
8. **Remote-session and hardware/device adapters** — SSH/RDP/VNC and peripheral/VR/device control only after local identity, approval, verification, and recovery semantics are mature.

Browser-engine portability remains valuable, but it now sits alongside—not above—the broader goal of turning the browser stack into one rigorously bounded adapter in a general computer-use system.
