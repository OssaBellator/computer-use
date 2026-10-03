# Bounded Computer-Use Runtime and Semantic Browser Engine

> **Reference repository.** This codebase is public as an implementation and architecture reference for bounded, verifiable computer-use systems. It informed later Minimal MCP design work and is no longer the primary active runtime. The package remains intentionally unpublished to npm, and experimental branches/PRs may contain work that is not fully validated on every target platform.

A TypeScript research/runtime repository for building **bounded, verifiable computer-use agents** from the safety properties first developed in the browser stack.

The project is no longer only a browser automation engine. Chromium remains the most complete environment, but `main` now also contains the environment-neutral computer-use core, a neutral task/checkpoint runtime, and concrete or backend-neutral foundations for filesystem, process, terminal, desktop UI, remote sessions, system/device state, local compute, realtime/game/media control, and application/document semantic models.

The central design rule is that these environments are peers. A filesystem adapter is not a special case of browser automation; a desktop accessibility adapter is not a fake DOM; terminal execution is not “local compute”; and a successful transport dispatch is not proof that a higher-level side effect succeeded.

## At a glance

- **Problem:** computer-use agents often conflate “command dispatched” with “desired effect happened,” then retry through stale targets or ambiguous side effects.
- **Implemented:** generation-aware target identity, bounded observations, explicit effect classes, approval hooks, sticky dispatch uncertainty, separate verification and checkpoint/recovery semantics.
- **Strongest runtime today:** standalone Chromium/CDP plus the neutral computer/task runtime.
- **Reference value:** the repository shows how browser, terminal, filesystem, process, desktop and remote adapters can share one authority model without pretending they are the same environment.
- **Boundary:** this is a reference codebase, not a claim that every platform backend on every branch is production-validated.

## Current repository state

- Package: `semantic-browser-interaction-engine`
- Version: **0.43.0**
- Runtime: **Node.js >= 20**
- Language/tooling: TypeScript 5.9+, ESM
- Repository status: **public reference repository; npm publication disabled (`private: true`)**
- Current browser capability profile: **standalone Chromium 0.43**
- Test model: local TypeScript/Node tests plus synthetic/local Chromium integration tests; GitHub Actions is intentionally not used
- Public surface: the historical browser API and the neutral computer contracts are exported from `src/index.ts`; many newly integrated concrete computer adapters/runtimes are implemented source modules but are **not yet all re-exported through the top-level package index**
- Experimental Windows provider work: **[PR #189](https://github.com/OssaBellator/computer-use/pull/189)** adds production Windows UI Automation, Windows.Graphics.Capture, guarded native input, and verification foundations. Its PR description records the exact validation baseline and the pieces that still require further Windows validation.

## What is implemented today

| Area | Current state | Important boundary |
| --- | --- | --- |
| Chromium/browser | **Implemented, highest fidelity** | Direct Node → Chromium CDP runtime; semantic/document/visual/media observation; native browser input; commitment approval and result verification |
| Browser as computer adapter | **Implemented** | `BrowserComputerEnvironmentAdapter` maps Chromium surfaces/entities/actions into neutral computer contracts without weakening browser commitment safety |
| Neutral computer core | **Implemented** | Adapter registry, generation-aware surfaces/entities, bounded observation channels, effect classes, dispatch/verification states, conservative retry rules |
| Neutral task runtime | **Implemented foundation** | Cross-adapter program execution, approval hooks, target revalidation, verification hooks, bounded trace retention, checkpoint/recovery state |
| Filesystem | **Implemented read-only host adapter** | One explicitly scoped root; metadata/directory observation and bounded UTF-8 reads only; no write/move/delete yet |
| Process | **Implemented read-only host adapter** | Linux `/proc` process observation; bounded metadata only; no broad process lifecycle mutation |
| Terminal | **Implemented host execution adapter** | Explicit argv and explicit-shell modes, bounded output/time/env/argv, executable/cwd identity revalidation, conservative effect policy |
| Local compute | **Implemented trusted in-process adapter** | Registered operations only; pure/read-only or local-artifact creation; cooperative limits, not hard isolation |
| Desktop UI | **Implemented neutral adapter foundation** | Semantic accessibility/system/visual contracts plus keyboard/pointer seams; current repo has a deterministic synthetic backend, not production OS backends |
| Remote session | **Implemented backend-neutral foundation** | SSH/RDP/VNC lifecycle/identity/bounds; SSH command or RDP/VNC display/input when supplied by a backend; no production transport provider in this repo yet |
| System/device | **Implemented backend-neutral foundation** | Bounded device/volume/system observation; mutations only when an approval verifier and exactly-once ledger are explicitly supplied; no production privileged OS backend yet |
| Realtime/game/media | **Implemented neutral runtime foundation** | Surface/capture generations, ownership leases, bounded temporal visual capture, native-input uncertainty, media/fullscreen contracts and calibration |
| Document/editor semantic models | **Implemented neutral model layer** | Generation-aware document/structured identities, bounded observations, semantic edit intents, model-state verification; UI/backend mechanisms remain separate |

“Implemented foundation” does not mean every operating system/provider/backend exists. The repository intentionally separates neutral safety contracts from platform-specific authority.

## Core computer-use contract

`src/computer/environmentAdapter.ts` defines the lowest neutral layer.

### Environment kinds

- `browser`
- `desktop-ui`
- `filesystem`
- `terminal`
- `process`
- `remote-session`
- `device`
- `local-compute`

### Observation channels

- `semantic-ui`
- `document`
- `visual`
- `selection`
- `filesystem`
- `terminal`
- `process`
- `network`
- `media`
- `device`
- `compute`
- `system`

### Entity kinds

The neutral identity layer covers surfaces, UI controls, documents/selections, files/directories, terminal sessions, processes, remote hosts, media, devices/peripherals/volumes, system/security setting scopes, visual regions, compute jobs, and compute artifacts.

Every adapter owns its identities. Surfaces and entities use opaque adapter-scoped IDs and may carry a **generation** that changes when the underlying resource is replaced or recreated. A generation-bearing reference is an authority/freshness claim, not a display label.

## Safety invariants

The computer-use work deliberately preserves the browser runtime’s strongest safety properties.

### Bounded acquisition, not only bounded output

A caller-visible `maxItems` or `maxTextBytes` is not enough if a backend first materializes an unbounded result. Adapter seams therefore increasingly require producer-side acquisition budgets and finite schema snapshots before retaining or iterating untrusted backend data.

### Immutable authority across awaits

Caller requests, trusted policy/configuration, backend identity records, approval material, and result envelopes are snapshotted or rebuilt before later awaits can create time-of-check/time-of-use drift. Getter/proxy/accessor-backed authority is rejected or normalized conservatively at critical boundaries.

### Generation-aware target freshness

Actions bind exact adapter/environment/entity identity and, where available, exact generation. Browser document/frame generations, desktop windows/controls, filesystem objects, process generations, remote-session authority, device targets, and compute jobs all use environment-specific freshness rules.

### Approval before consequential effects

The neutral default requires approval for every effect except:

- `observe-only`
- `local-reversible`

Effect classes include `process-execution`, `local-destructive`, `system-configuration`, `external-communication`, `external-transaction`, `security-sensitive`, `process-trigger`, `remote-execution`, and `hardware-affecting`.

An adapter may impose a stricter policy. For example, arbitrary terminal commands default to a conservative `security-sensitive` effect unless a trusted resolver explicitly narrows them.

### Dispatch uncertainty is sticky

Neutral action results distinguish:

- `not-dispatched`
- `dispatched-once`
- `unknown`

For side-effecting work, automatic retry is permitted only after a result that is definitely `not-dispatched`. A transport exception, malformed post-dispatch backend result, or otherwise uncertain invocation cannot be converted into an ordinary retry-safe failure.

### Verification is separate from dispatch

Verification states are explicit:

- `not-applicable`
- `verified`
- `pending`
- `rejected`
- `mismatch`
- `unverified`

Low-level native input, process launch, remote transport success, or command exit status does not automatically prove a higher-level transaction, publication, security change, or application-model mutation.

## Architecture

```text
planner / task program / policy
              |
              v
      ComputerTaskRuntime
  approval + freshness + retry
  verification + checkpoints
              |
              v
 ComputerEnvironmentRegistry
              |
  +-----------+-----------+-----------+-----------+
  |           |           |           |           |
  v           v           v           v           v
browser   filesystem   terminal    process    local-compute
adapter    adapter      adapter     adapter       adapter
  |
  +-----------+-----------+-----------+
              |           |           |
              v           v           v
         desktop UI   remote      system/device
          backend     backend        backend
        foundations  foundation     foundation

Application/document semantic models and realtime/media control
sit above/beside these adapters rather than pretending every app is a DOM.
```

Direct/native state adapters and UI/visual adapters are peers. A future planner should prefer the most semantic bounded interface available for the task, then fall back to accessibility/visual/native input where no stronger interface exists.

## Neutral task runtime and checkpoints

`ComputerTaskRuntime` executes immutable `ComputerTaskProgram` snapshots through `ComputerEnvironmentRegistry`.

Current behavior includes:

- adapter/environment/capability preflight;
- target generation/freshness checks before approval and immediately before dispatch;
- default approval for consequential effects;
- conservative dispatch state recorded before verifier awaits;
- no unsafe replay after `unknown` dispatch or known-but-unverified dispatch;
- named domain verifier hooks that cannot rewrite recorded dispatch authority;
- bounded metadata-only retained observation records; raw adapter observation `data` is not retained in normal task history;
- bounded machine-readable evidence codes;
- checkpoint creation/resume with explicit per-action dispatch state and reconciliation requirements.

The computer checkpoint codec is integrity-checked and execution/program-bound. It intentionally avoids persisting arbitrary payload contents, secrets, page excerpts, terminal output, file contents, or device telemetry. Payload-bearing steps need an explicit trusted non-secret checkpoint binding/revision.

A checkpoint is **not** proof that an external store is authentic. Durable storage/authentication remains the caller’s responsibility.

## Browser runtime

Chromium is still the most complete end-to-end environment in the repository.

```text
Node.js
  |
  | child_process + --remote-debugging-pipe
  v
CdpPipeConnection
  |
  v
CdpTargetSessionRouter
  |
  +---------------- page sessions ----------------+
  |                                               |
  v                                               v
MultiPageCdpAgent / MultiPageTaskEngine     browser observers
  |                                        semantic/document/
  |                                        visual/media/state
  v
TaskRuntime
  |
  | commitment detection / approval /
  | fresh target+material revalidation /
  | neutral result baseline
  v
browser-native CDP input
  |
  v
bounded post-action verification
```

The standalone path does not require Playwright, Puppeteer, Selenium/WebDriver, or a third-party CDP client at runtime.

### Browser observation and interaction

The current browser stack includes:

- multi-page target lifecycle and generation-aware target identity;
- bounded semantic interaction snapshots and target resolution;
- structured document reading across frames and open Shadow DOM;
- derived research/main-content ranking, table relationships, deterministic diffs, and targeted refresh hints;
- visual snapshots, visual differencing, motion tracking, game-region/renderer leases, and realtime capture primitives;
- browser state, history/navigation, dialogs, downloads/uploads, select/range controls, and optional network-idle observation;
- browser-native keyboard, pointer, wheel, text/select, hover, activation, scroll, relative pointer, and pointer-lock flows;
- HTML media/fullscreen state and control;
- clipboard read/write under normal browser permission/user-activation rules;
- native intercepted drag/drop data transfer with file-bearing transfers blocked by default;
- rich-document selection/caret, formatting observation, native insertion/replacement, select-all/delete, and verified basic formatting operations.

### Browser as a neutral computer adapter

`BrowserComputerEnvironmentAdapter` exposes:

- `browser.semantic-ui.observe`
- `browser.document.observe`
- `browser.visual.observe`
- `browser.media.observe`
- `browser.activate`
- `browser.hover`
- `browser.type`
- `browser.press-key`
- `browser.scroll-viewport`

Browser surfaces are CDP targets with target-generation identity. Semantic entities are additionally bound to top-level and child-frame document generations, so iframe/document replacement invalidates stale refs even when structural IDs are reused.

Commitment-capable activation/key paths delegate into the existing browser `TaskRuntime` rather than implementing a weaker second safety path.

## Browser commitment safety

Detected commitments follow this chain:

**detect → approval → fresh target/material revalidation → complete neutral result baseline → exactly one dispatch → explicit result verification**

Important consequences:

- stale targets or incomplete pre-action result baselines block dispatch;
- approved target/material state is refreshed immediately before native input;
- a possibly dispatched high-risk action is never automatically replayed as an ordinary retry;
- post-action outcomes distinguish confirmed/pending/declined/canceled/mismatch/unknown;
- bounded non-secret order/booking/transfer/subscription/publication/process/reference identifiers can strengthen result binding;
- unrelated pre-existing page state is not allowed to prove a new commitment;
- ordinary traces retain bounded machine evidence/classification rather than sensitive transaction content.

“Runnable” browser capability is not permission for unattended high-consequence actions.

## Filesystem adapter

`FilesystemComputerEnvironmentAdapter` is a real Node filesystem adapter scoped to one configured root.

Implemented:

- root and file/directory identity based on host filesystem identity metadata plus generation fallback;
- bounded non-recursive directory observation;
- metadata-only generic file observation;
- explicit bounded UTF-8 file reads;
- deterministic truncation and text/item budgets;
- hardlink-aware identity/locator handling;
- symlink non-traversal;
- root/mount-device boundary enforcement;
- pre/post file-handle and directory identity/race validation.

Not implemented:

- write/create;
- rename/move/copy;
- delete;
- recursive mutation;
- binary-content API;
- arbitrary mount discovery outside the configured root.

A generic observation text budget never grants permission to read file contents.

## Process and terminal adapters

### Process

`HostProcessAdapter` provides bounded process observation. The host source uses Linux `/proc` and generation derives from process start ticks.

It retains only bounded decision-useful metadata such as PID/parent PID, basename/name, state, CPU ticks, and RSS. It does not expose full command lines or process environments through the neutral observation path. Process lifecycle mutation is currently unsupported.

### Terminal

`HostTerminalAdapter` provides two explicit execution capabilities:

- `terminal.execute.argv`
- `terminal.execute.shell`

The argv path always launches an explicit executable with `shell: false`. The shell path is still explicit: callers provide the shell executable, shell arguments, and command, and the adapter invokes that executable with `shell: false` rather than passing an opaque string to Node’s shell option.

The adapter bounds argv/env/output/time, revalidates executable and working-directory identity immediately before spawn, records uncertain launch as `dispatch: unknown`, and only treats exit status as domain verification for a trusted `process-execution` classification. Stronger effects require separate domain verification.

## Local compute adapter

`LocalComputeAdapter` is intentionally **not a generic shell/process escape hatch**.

It accepts only pre-registered operation IDs. The adapter currently allows registrations classified as:

- `pure-read-only`
- `local-artifact-creation`

Definitions that declare process execution, external network effects, or system modification are rejected by this adapter.

Inputs/outputs are bounded canonical JSON. Compute jobs and artifacts have generation/content identity, and a bounded execution ledger prevents a previously accepted non-idempotent job generation from being redispatched just because detailed retained state was evicted.

Execution is `trusted-in-process-cooperative`: `AbortSignal` and deadlines are cooperative. A blocking or cancellation-ignoring callback is not hard-isolated. Worker/isolate/process isolation is required before claiming hard CPU/time/memory termination.

## Desktop UI foundation

`DesktopUiEnvironmentAdapter` provides neutral contracts for:

- system/window observation;
- accessibility/semantic UI observation;
- bounded visual capture references;
- window/control focus;
- keyboard input;
- absolute pointer input;
- optional relative pointer input.

Control/window generations and stable control-instance identity are part of the freshness model. Backend results and accessibility trees are defensively rebuilt through bounded schemas.

The repository currently includes `SyntheticDesktopUiBackend` for deterministic testing. It does **not** yet include production Windows UI Automation, macOS Accessibility, Linux AT-SPI, or native production capture/input backends.

## Remote-session foundation

`RemoteSessionAdapter` models SSH, RDP, and VNC without embedding provider-specific transport types into the neutral computer contracts.

Current foundation includes:

- connection/reconnection/disconnection lifecycle serialization;
- endpoint/session/remote-host generation authority;
- secret handles rather than secret material in neutral request objects;
- bounded metadata observation;
- bounded display acquisition for RDP/VNC-style backends;
- bounded visual input for RDP/VNC-style backends;
- bounded argv-style remote command execution for SSH-style backends;
- conservative transport-dispatch mapping;
- fail-closed cleanup when a connected backend candidate cannot be safely snapshotted;
- observation leases that fail when lifecycle authority changes during an await.

No production SSH/RDP/VNC transport implementation is supplied in this repository yet. A backend must implement the transport and its own credential/resource ownership.

## System/device foundation

`SystemDeviceEnvironmentAdapter` covers bounded system/device state and the mutation safety seam.

Current observation model includes:

- system/platform summary;
- devices/peripherals;
- volumes;
- typed system-setting observation helper;
- coarse security-setting observation helper;
- explicit unsupported-platform / unsupported-privilege / permission-denied states.

Mutation capabilities are advertised only when all of the following are supplied:

1. mutation enablement;
2. a trusted approval verifier;
3. an external exactly-once action ledger.

A mutation then requires exact target/effect binding, approval tied to configuration revision, a fresh pre-dispatch baseline, atomic action-ID claim, exactly one backend dispatch, and post-action verification.

Dangerous operations such as disk partitioning, destructive storage operations, firmware flashing, firewall modification, antivirus policy modification, and privileged account/security modification are explicitly unsupported in this foundation.

There is no production privileged OS backend in this repository yet.

## Realtime/game/media runtime

The environment-neutral realtime layer models:

- generation-aware surfaces and capture generations;
- focus/input/capture/session/renderer/device ownership;
- relative-pointer capture ownership;
- keyboard, pointer, relative pointer, wheel, and controller-like input;
- bounded pixel/byte temporal capture;
- dropped/truncated sample accounting;
- native-input dispatch uncertainty;
- bounded control calibration;
- local media playback/volume/mute and fullscreen ownership.

The runtime snapshots leases/requests/input across awaits and terminates calibration when dispatch becomes uncertain. Media-control success is explicitly local; it cannot be used as proof of external publication/streaming.

## Application/document semantic models

`src/computer/documentModels.ts` is a mechanism-neutral model layer for document/editor work. It currently covers generation-aware document and structured-object identities, bounded semantic observations, edit intents, and model-state verification across concepts such as text ranges, tables/spreadsheets, presentations, code buffers, media timelines, and generic structured objects.

These models deliberately contain no DOM selectors, accessibility paths, click coordinates, OS-native handles, or vendor-specific automation. A future Office/LibreOffice/IDE/CAD/media backend can implement the same semantic model using native APIs, accessibility/UI interaction, structured file access, or a hybrid strategy.

## Capability model: browser vs computer

The browser stack retains its seven web-task categories:

1. information retrieval & research;
2. communication & collaboration;
3. transactions & commerce;
4. content consumption & entertainment;
5. content creation & publishing;
6. identity & account management;
7. automation & process triggering.

The computer-use architecture uses a broader seven-category model:

1. document/media production;
2. data processing/analytics;
3. file/storage management;
4. system administration/security;
5. communication/remote access;
6. gaming/entertainment;
7. process automation.

The browser-to-computer capability bridge is intentionally conservative. Browser upload/download does not imply arbitrary filesystem authority; Chromium process plumbing does not imply terminal/process authority; browser network observation does not imply general remote-session/network control.

## Top-level exports

`src/index.ts` currently exports the historical browser runtime plus the neutral computer contract modules:

- `computer/environmentAdapter`
- `computer/environmentRegistry`
- `computer/computerCapabilities`
- `computer/browserCapabilityBridge`
- `computer/profileComposition`

The newly integrated concrete computer adapters, `ComputerTaskRuntime`, document semantic models, and realtime computer runtime are not yet all part of the top-level export barrel. Until that API surface is deliberately designed, treat them as internal source modules rather than a stable package API.

## Installation and local validation

```bash
npm install
npm run typecheck
npm test
npm run test:chromium
```

Set `CHROMIUM_BIN=/path/to/chromium` when Chromium is not available at the expected default location.

`npm test` performs a clean TypeScript build and runs compiled `dist/tests/*.test.js` tests.

`npm run test:chromium` builds first and runs local Chromium integration fixtures.

A separate opt-in live-site smoke path exists:

```bash
RUN_LIVE_WEB=1 npm run test:live
```

The live path is not used for purchases, payments, transfers, bookings, publication, account-security changes, deployments, or other high-consequence side effects.

GitHub Actions is intentionally disabled. Validation evidence is documented per tranche and should be read with its stated scope; a focused reconstructed TypeScript/synthetic harness must never be represented as a full repository test-suite pass.

## Repository layout

```text
src/
  agent/        browser task runtime, commitment verification, browser checkpoints, realtime loops
  browser/      CDP/browser observation, document/media/visual/state primitives
  capabilities/ browser/web capability profiles
  computer/     neutral computer core, adapters, task runtime, document/realtime models
  controller/   semantic/native browser action controllers
  engine/       standalone and multi-page browser engines
  input/        browser/CDP input adapters
  model/        interaction/performance models
  planner/      action planning
  runtime/      Chromium process/CDP transport
  verification/ browser action/result verification helpers

tests/          unit/synthetic regression suite
tests/integration/ local Chromium and opt-in live smoke fixtures
docs/           design notes and architecture records
```

## Non-goals and explicit exclusions

This repository does not provide or claim:

- CAPTCHA bypass, fingerprint spoofing, stealth patches, anti-bot evasion, or abuse-control bypass;
- hardware provenance or proof of a “human” input source;
- automatic approval of consequential transactions/security/system mutations;
- retry of possibly dispatched high-risk work as if nothing happened;
- a production Windows/macOS/Linux desktop automation backend yet;
- a production SSH/RDP/VNC backend yet;
- a production privileged system/device mutation backend yet;
- hard resource isolation for in-process local compute;
- arbitrary filesystem mutation yet;
- broad process termination/lifecycle control yet;
- a stable public package API for every newly integrated computer module yet.

## Highest-leverage next work

The architecture extraction phase is complete enough that the next work should deepen real adapter quality and composition rather than add more parallel contract variants.

1. **Deliberately export/composition-wire the integrated computer modules** — design a stable top-level API and runtime composition path instead of exposing every source file ad hoc.
2. **Production desktop backends** — Windows UI Automation, macOS Accessibility, and Linux AT-SPI/capture/native-input implementations behind the existing neutral desktop contract.
3. **Filesystem mutation** — typed create/write/copy/move/delete with scoped-root authority, immutable source/material snapshots, destructive approval, dispatch certainty, and exact post-operation verification.
4. **Remote transports** — production SSH plus RDP/VNC providers with credential handles, bounded acquisition, lifecycle cleanup, and transport/domain verification separation.
5. **System/device backends** — read-first production OS inventory/settings implementations before enabling narrowly scoped mutations.
6. **Hard-isolated local compute** — worker/isolate/process-backed execution where CPU/time/memory termination can be enforced rather than cooperatively requested.
7. **Application semantic adapters** — office/spreadsheet/presentation, IDE/build/debug, media/design/CAD controllers built against the neutral document model, with accessibility/visual fallback where needed.
8. **Cross-adapter composition tests** — synthetic/local scenarios that exercise browser + filesystem + terminal/process + task checkpoints without real high-consequence external side effects.
9. **Checkpoint persistence/reconciliation** — durable authenticated storage plus explicit reconciliation workflows for unknown or dispatched-unverified actions.
10. **Capability/profile refresh** — evolve beyond the 0.43 browser-centered release profile once the computer-use API/export surface is intentionally stabilized.

## Parallel development convention

For future parallel work, create **fresh task-named branches from the current `main` head** rather than stacking feature branches on each other. Keep shared neutral-contract edits additive and coordinated, and avoid using one feature branch as another feature branch’s base unless the dependency is intentional.

Completed feature branches should be treated as disposable once their reviewed content is on `main`; closed PRs and merge commits are the historical record. A branch that is retained for reuse should first be reset/rebased to the current `main` head so stale pre-integration history cannot leak into a new PR.

## Design documentation

Useful architecture records include:

- [`docs/computer-use-architecture.md`](docs/computer-use-architecture.md)
- [`docs/standalone-chromium-runtime.md`](docs/standalone-chromium-runtime.md)
- [`docs/task-program-runtime.md`](docs/task-program-runtime.md)
- [`docs/task-checkpoints.md`](docs/task-checkpoints.md)
- [`docs/commitment-safety.md`](docs/commitment-safety.md)
- [`docs/commitment-result-identity.md`](docs/commitment-result-identity.md)
- [`docs/document-content-observation.md`](docs/document-content-observation.md)
- [`docs/document-research-ranking.md`](docs/document-research-ranking.md)
- [`docs/rich-document-selection.md`](docs/rich-document-selection.md)
- [`docs/rich-document-formatting.md`](docs/rich-document-formatting.md)
- [`docs/clipboard-dragdrop-foundations.md`](docs/clipboard-dragdrop-foundations.md)
- [`docs/media-permission-state.md`](docs/media-permission-state.md)
- [`docs/pointer-lock-lifecycle.md`](docs/pointer-lock-lifecycle.md)
- [`docs/game-control-calibration.md`](docs/game-control-calibration.md)
- [`docs/web-task-capabilities.md`](docs/web-task-capabilities.md)

Some design documents record earlier extraction stages; this README is the concise source of truth for what is currently integrated on `main`.
