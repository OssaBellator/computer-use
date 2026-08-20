# Web task capability model

The repository's long-term goal is broad web-task coverage, not a collection of site-specific scripts. `src/capabilities/webTaskCapabilities.ts` turns that goal into machine-readable categories, primitive capabilities, support states, coverage targets, and task-program requirement analysis.

## Seven task categories

The stable category IDs are:

| Category ID | Human activity |
| --- | --- |
| `information-retrieval-research` | search, facts/news/weather/guides, academic/market/product research |
| `communication-collaboration` | messaging/email, shared documents, whiteboards, team/project workflows |
| `transactions-commerce` | shopping, banking/bills where permitted, booking/travel/subscriptions |
| `content-consumption-entertainment` | articles/forums/ebooks, streaming media, browser games |
| `content-creation-publishing` | writing/posting, media upload, design/editing/coding tools |
| `identity-account-management` | forms, profiles/privacy/passwords, user-mediated MFA/identity steps |
| `automation-process-triggering` | submit workflows, trigger automations/webhooks, schedule through web apps |

`WEB_TASK_CATEGORY_CAPABILITY_TARGETS` describes a deliberately high bar for broad coverage of each entire category. It is not a claim that every individual task in a category needs every target capability.

## Support states

A browser/runtime profile reports each primitive as:

- `supported` — the runtime has a first-class implementation suitable for requirement preflight;
- `partial` — a conditional/configuration-dependent implementation exists or generic browser interaction can approximate the behavior, but the primitive is not complete enough to claim broad coverage;
- `unsupported` — no first-class implementation exists yet.

Missing profile entries are treated as unsupported. This keeps assessment fail-closed when new capabilities are added to the taxonomy.

`CapabilityAssessment.runnable` means no **required** capability is completely unsupported. `fullySupported` is stricter: every required and preferred capability must be fully supported. Partial required capabilities remain visible to the caller rather than being silently treated as either complete or absent.

## Standalone Chromium profiles

`STANDALONE_CHROMIUM_CAPABILITY_PROFILE` remains the historical version-0.35 snapshot. It is not mutated when later slices land.

`CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE` describes the current stack. At version 0.40 it adds bounded document reading, partial native rich-text editing, and partial page-grounded commitment detection while keeping incomplete capabilities explicitly partial or unsupported.

### Strong current foundations

- standalone Chromium launch and raw CDP transport
- task-program execution
- multi-page target/session control
- navigation and history
- semantic interactive-element observation
- bounded structured document-content observation across frames/open Shadow DOM
- browser state observation
- visual screenshots and motion differencing
- activation, pointer, relative pointer, keyboard, text entry, select controls, and scrolling
- dialog handling
- explicit approval/max-risk gates in `TaskRuntime`
- realtime control, game-surface acquisition, and temporal motion tracking

### Conditional/partial foundations

- network activity observation is explicit opt-in
- download observation requires download-controller configuration
- uploads require upload-controller configuration
- rich-text editing has bounded caret/selection observation plus exact native insertion/replacement/select-all/delete, but formatting, rich clipboard, drag/drop, and editor-specific verification are incomplete
- commitment detection covers strong and context-corroborated purchase/booking/transfer/subscription/publish/destructive/security/process actions, but it is heuristic and site-specific semantics remain incomplete
- generic action verification exists for some remote side effects, but transaction/publishing semantics are not specialized enough to be fully supported
- generic semantic activation can operate some media controls, but playback/fullscreen state is not first-class
- ordinary UI interaction can reach some sign-in/MFA pages, but user-handoff/passkey/authentication state is not first-class

### Important missing primitives

- clipboard read/write
- drag/drop
- first-class media playback/fullscreen controls
- browser permission and camera/microphone state
- credential/passkey control and explicit user-mediated authentication state
- specialized post-commit external-side-effect/process-trigger verification bound to the intended commitment
- long-running task checkpoints/replay

The capability model intentionally exposes these gaps. A broad category should not appear complete merely because generic clicking and typing are available.

## Transaction/commerce status at 0.40

`transactions-commerce` requires navigation, semantic interaction, activation, text entry, select controls, browser state observation, commitment detection, an explicit confirmation gate, and external-side-effect verification.

At 0.40 no required transaction capability is completely unsupported, so the category is mechanically **runnable** under the model. It is **not fully supported**:

- `commitment-detection` is partial because the detector is bounded and heuristic rather than site-semantic;
- `external-side-effect-verification` is partial because generic DOM/action verification does not yet prove that the intended order, booking, payment, transfer, or subscription actually completed with the expected terms.

This distinction is intentional. Runnable means a planner can attempt a constrained workflow with explicit policy handling; it does not mean arbitrary financial workflows should proceed unattended.

See [`commitment-safety.md`](commitment-safety.md) for the dynamic pre-commit gate and its fail-closed boundaries.

## Program requirement inference

`analyzeTaskProgramCapabilities(program)` derives mechanical requirements from existing `TaskProgram` steps and predicates.

Examples:

- `navigate` -> `navigation`
- `type` -> `text-entry` + `keyboard-input`
- `upload` -> `file-upload` + `explicit-confirmation-gate`
- `switch-page` / `open-tab` / `close-latest-tab` -> `multi-page`
- `wait-network-idle` -> `network-activity-observation`
- browser/document/download/dialog/target predicates -> their corresponding observation capabilities
- any step explicitly marked `external-side-effect` or `requiresApproval` -> `explicit-confirmation-gate`

The returned capability set is stable-sorted in taxonomy order, and the analysis also surfaces side-effecting/approval step IDs.

The analysis is deliberately mechanical. Dynamic commitment detection is a **runtime** observation immediately before a commit-capable action. A program does not need to contain the literal phrase `Place order` for the browser state to reveal that the resolved target has that accessible name.

## Commitment classes

`TaskCommitmentClass` separates task consequence from browser mechanics:

- `observe-only`
- `local-reversible`
- `remote-reversible`
- `remote-publish`
- `financial`
- `identity-security`
- `process-trigger`

The default helper marks remote publishing, financial, identity/security, and process-trigger commitments as requiring explicit approval. More restrictive callers can require approval for reversible remote changes as well.

The 0.40 detector reports a page-grounded commitment kind/class into `TaskApprovalContext.commitment`. The task trace retains only status/kind/confidence so amount/counterparty/schedule details do not become ordinary telemetry.

This model complements `TaskRuntime`'s `interaction` / `external-side-effect` declaration handling; it does not weaken it. An inferred commitment can require explicit approval even when a caller has otherwise raised `maxRisk` to allow declared external side effects.

## Next high-leverage capability work

The highest-leverage transaction follow-up is specialized post-side-effect verification. The runtime should bind the state after a commit to the pre-commit summary and distinguish:

- completed versus pending;
- succeeded versus declined/failed/canceled;
- expected versus changed amount/currency;
- expected versus changed recipient/merchant/service;
- one-time versus recurring terms;
- intended publication/process identity versus an unrelated state change.

For content creation/collaboration, clipboard-rich read/write, formatting runs, drag/drop, and editor-specific model verification remain major blockers. Identity flows still need first-class user-mediated authentication/passkey handoff, and long-running automation still needs durable checkpoint/replay semantics.
