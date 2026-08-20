# Semantic Browser Interaction Engine

A framework-independent browser-agent foundation centered on semantic interaction, raw Chromium DevTools Protocol (CDP) control, bounded task execution, explicit side-effect safety, structured document research, rich editing, media/permission state, and realtime visual control.

The primary stack launches and controls Chromium directly over `--remote-debugging-pipe`. Playwright is not required by the standalone runtime; the repository retains an optional input adapter for integrations that already use it.

## Current standalone profile: 0.42

`CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE` is now `standalone-chromium-0.42`.

The 0.42 stack combines the earlier semantic/spatial interaction engine with:

- bounded `TaskRuntime` programs, predicates, branching, waits, page switching, navigation/history, dialogs, uploads/downloads, select/range controls, and network-idle observation;
- structured multi-frame document observation and document predicates;
- deterministic research ranking, boilerplate classification, table relationships, document diffs, and uncertainty-aware refresh hints;
- document selection/caret observation, exact native text insertion/replacement/select-all/delete, and bounded rich-formatting observation with verified native bold/italic/underline operations;
- commitment detection, explicit approval, fresh pre-dispatch revalidation, neutral result baselines, exactly-one dispatch, explicit post-commit result verification, and durable labeled result identity across supported redirects/opener-bound popups;
- multi-page raw-CDP routing without searching unrelated tabs for transaction/result evidence;
- media playback/fullscreen observation and narrowly scoped native controls that preserve normal browser user-activation policy;
- passive page Permissions API / Permissions Policy observation without automatic grant/deny mutation;
- persistent realtime held input, relative pointer movement, pointer-lock/pointer-capture lifecycle observation and bounded recovery;
- game-region acquisition/lifecycle, screenshot sampling, visual diffing, temporal motion tracks, and a composed visual pipeline;
- bounded generic game-control calibration with explicit safety/focus attestation for key probes; and
- a deterministic, privacy-bounded task checkpoint codec for future runtime persistence/replay integration.

The capability profile is intentionally conservative. A merged primitive does not automatically make an entire task category “fully supported.”

## Side-effect safety

The standalone runtime treats potentially consequential browser actions differently from ordinary UI interaction.

For detected purchases, bookings, transfers, subscriptions, publishing, destructive actions, identity/security changes, and external process triggers, the intended chain is:

**detect commitment → approval → fresh target/material revalidation → complete neutral result baseline → exactly one dispatch → explicit result verification**

Post-dispatch verification never retries the action merely because the generic click/key verifier is uncertain. Pending, declined, canceled, mismatched, or unverified side effects terminate that runtime path instead of redispatching.

0.42 strengthens result binding with bounded, explicitly labeled, non-secret identifiers. A unique pre-dispatch reference can bind a later receipt/result across a redirect or an opener-associated popup. Positive cross-origin confirmation requires that exact binding; arbitrary or pre-existing tabs are never searched for success text. Identifier values remain out of ordinary task traces.

See:

- [`docs/commitment-safety.md`](docs/commitment-safety.md)
- [`docs/commitment-result-identity.md`](docs/commitment-result-identity.md)

## Structured research

`DocumentContentSnapshot` remains the browser extraction contract. Research analysis is a derived layer rather than a second extractor.

`documentRanking.ts` adds deterministic primary-content ranking, generic boilerplate classification, reading/section order, and table row/column header relationships. `documentDiff.ts` separates exact source-identity changes from conservative relocation/content-update hints.

If a frame is unreadable in either snapshot, the diff fails closed: observation failure is reported as incomplete/frame-refresh evidence rather than as an exact deletion or addition. Equal inputs produce deterministic output using locale-independent ordering.

See:

- [`docs/document-content-observation.md`](docs/document-content-observation.md)
- [`docs/document-research-ranking.md`](docs/document-research-ranking.md)
- [`docs/document-task-predicates.md`](docs/document-task-predicates.md)

## Rich document editing

The rich-text foundation is frame/editing-host scoped. It includes bounded selection/caret identity and text geometry, native CDP insertion, select-all/delete replacement, and structured formatting observation.

0.42 adds formatting state for inline/block context and verified native bold/italic/underline operations. Mixed formatting remains explicit rather than being collapsed into a false boolean.

Rich clipboard transfer, drag/drop, collaborative-editor synchronization, and editor-specific model verification are still incomplete.

See [`docs/rich-document-formatting.md`](docs/rich-document-formatting.md).

## Media, fullscreen, and permissions

The media layer observes bounded HTML `audio`/`video` state and uses frame/backend-node identity rather than retaining media source URLs. Native play/pause/mute/volume/seek/playback-rate and document-fullscreen operations are verified without setting CDP `userGesture: true`; autoplay/fullscreen policy can therefore legitimately reject an operation.

Permission observation combines frame-visible Permissions API state with Permissions Policy information. Browser/profile grant state remains explicitly unknown when CDP provides no passive readback. This layer does not auto-grant camera, microphone, clipboard, geolocation, notification, or other sensitive permissions.

See [`docs/media-permission-state.md`](docs/media-permission-state.md).

## Realtime and game control

The realtime stack supports held keys/buttons, relative pointer movement, independent perception/control cadence, renderer/game-region leases, screenshot sampling, visual diffs, motion regions, and temporal tracks.

Pointer-lock/pointer-capture lifecycle state now guards relative motion with owner identity, loss detection, and bounded recovery hooks. Generic game-control calibration can run short budgeted probes and compare visual effects, but key probing fails closed unless the caller explicitly attests that the candidate and current keyboard-focus ownership are safe for calibration.

See:

- [`docs/pointer-lock-lifecycle.md`](docs/pointer-lock-lifecycle.md)
- [`docs/game-control-calibration.md`](docs/game-control-calibration.md)
- [`docs/game-region-acquisition.md`](docs/game-region-acquisition.md)
- [`docs/game-region-lifecycle.md`](docs/game-region-lifecycle.md)
- [`docs/fast-visual-perception.md`](docs/fast-visual-perception.md)

## Task checkpoints

`src/agent/taskCheckpoint.ts` is a pure versioned checkpoint/replay codec. It records program identity/hash, current step, visit counters, remaining budgets, and bounded non-sensitive browser fingerprints while excluding typed inputs, cookies/tokens, page excerpts, financial/counterparty details, and DOM snapshots.

Serialization is deterministic and locale-independent; decoding validates schema/version/integrity and resume compatibility. The codec deliberately does **not** integrate with `TaskRuntime` yet, and its execution identifier is not an authentication or rollback-protection mechanism.

See [`docs/task-checkpoints.md`](docs/task-checkpoints.md).

## Architecture

The main layers are intentionally separable:

- `src/browser/` — CDP/page observation, navigation/dialog/download/upload/select/history/network state, document/research/formatting, commitment/result identity, media/permissions, pointer ownership, and visual perception.
- `src/controller/` — semantic/pointer/focus/keyboard/scroll/rich-text/pointer-lock controllers.
- `src/input/` — browser-input abstraction, raw CDP adapter, key mapping, and optional framework adapters.
- `src/agent/` — bounded task programs/runtime, post-commit verification, checkpoint codec, realtime control, and game calibration.
- `src/engine/` — standalone page engine, pure-CDP construction, multi-page routing, and the top-level standalone browser agent.
- `src/capabilities/` — explicit task-capability vocabulary and current standalone profile.

`src/index.ts` exports the supported public foundations, including the 0.42 modules.

## Seven broad web-task categories

The repository tracks capability targets for:

1. Information Retrieval & Research
2. Communication & Collaboration
3. Transactions & Commerce
4. Content Consumption & Entertainment
5. Content Creation & Publishing
6. Identity & Account Management
7. Automation & Process Triggering

The capability model distinguishes `supported`, `partial`, and `unsupported` primitives and evaluates required versus preferred capabilities. It is the source of truth for category claims.

Current highlights:

- research has structured extraction plus deterministic ranking/diffing, while network-assisted refresh/reconciliation remains incomplete;
- communication has text entry, uploads, and partial rich editing, but clipboard/media-auth workflows remain incomplete;
- transactions are mechanically runnable behind commitment approval/result verification, but provider-specific transaction reconciliation remains incomplete;
- content consumption has visual/realtime foundations and partial native media control;
- broad content creation/publishing is still blocked by missing general clipboard read/write and drag/drop support despite rich editing and publishing-side commitment verification;
- identity/account tasks remain user-mediated around credentials/passkeys/MFA and do not bypass authentication or permissions; and
- automation/process triggering has bounded task execution and post-trigger verification, plus a checkpoint codec that is not yet wired into runtime persistence.

## Running locally

Requires Node.js 22+ and TypeScript 5.8.x for development. Raw Chromium integration tests also require a local Chromium executable; the fixtures default to `/usr/bin/chromium` when available.

```bash
npm install
npm run typecheck
npm test
npm run test:chromium
```

`npm run test:live` is opt-in and intended only for explicitly selected live-web checks. High-consequence feature validation should use synthetic/local fixtures rather than real purchases, payments, bookings, transfers, publications, security changes, deletions, deployments, or external process triggers.

## Validation policy

GitHub Actions are intentionally disabled for this repository and are not part of the validation path. Windows Tester is not used.

Development and review should use focused local TypeScript/unit tests and raw-CDP synthetic Chromium fixtures. Do not claim the full repository or Chromium suite passed unless it was actually run on the exact reviewed files.

The primary architecture must remain usable without Playwright, Puppeteer, Selenium, or WebDriver. Optional adapters may exist, but standalone capabilities should be implemented against the repository abstractions/raw CDP rather than making an automation framework mandatory.

The project does not implement anti-bot stealth, fingerprint spoofing, CAPTCHA bypass, permission bypass, or abuse-control evasion.

## Current frontier

The highest-value remaining work after 0.42 is:

1. **Rich clipboard, drag/drop, and collaborative-editor verification** — browser-native copy/cut/paste/drop semantics with bounded payload/privacy rules and post-operation verification.
2. **TaskRuntime checkpoint persistence/replay** — integrate the pure codec with explicit trusted storage, freshness/rollback policy, input re-provisioning, and safe resume points without replaying side effects.
3. **User-mediated authentication and capture lifecycles** — passkeys/MFA/credential boundaries plus camera/microphone device/capture state without bypassing browser permission or user-presence requirements.
4. **Provider/result reconciliation** — strengthen labeled result identity with provider-neutral navigation/handoff lifecycle and, where safely available, external result-state reconciliation without exposing financial secrets or enabling redispatch.
5. **Semantic visual understanding** — camera/global-motion separation, object/task association, and more robust visual scene semantics beyond motion tracks.
6. **Game-control discovery refinement** — broader safe candidate discovery, richer effect attribution, reset/rebaseline behavior, and calibration under pointer-lock/camera motion.
7. **Browser-engine portability** — preserve the semantic/input/verification contracts while adding non-Chromium backends or adapters.

These remain incremental capability slices rather than justification for introducing a heavyweight browser framework into the core.
