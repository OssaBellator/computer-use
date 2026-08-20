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

## Current standalone Chromium profile

`STANDALONE_CHROMIUM_CAPABILITY_PROFILE` describes the version-0.35 standalone stack as the 0.36 capability layer sees it.

### Strong current foundations

- standalone Chromium launch and raw CDP transport
- task-program execution
- multi-page target/session control
- navigation and history
- semantic interactive-element observation
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
- generic action verification exists for some remote side effects, but transaction/publishing semantics are not specialized
- generic semantic activation can operate some media controls, but playback/fullscreen state is not first-class
- ordinary UI interaction can reach some sign-in/MFA pages, but user-handoff/passkey/authentication state is not first-class

### Important missing primitives

- general document/article content observation
- rich-text editing semantics
- clipboard read/write
- drag/drop
- first-class media playback/fullscreen controls
- browser permission and camera/microphone state
- credential/passkey control and explicit user-mediated authentication state
- page-side commitment detection before purchases/publishing/security changes
- specialized external-side-effect/process-trigger verification
- long-running task checkpoints/replay

The capability model intentionally exposes these gaps. A broad category should not appear complete merely because generic clicking and typing are available.

## Program requirement inference

`analyzeTaskProgramCapabilities(program)` derives mechanical requirements from existing `TaskProgram` steps and predicates.

Examples:

- `navigate` -> `navigation`
- `type` -> `text-entry` + `keyboard-input`
- `upload` -> `file-upload` + `explicit-confirmation-gate`
- `switch-page` / `open-tab` / `close-latest-tab` -> `multi-page`
- `wait-network-idle` -> `network-activity-observation`
- browser/download/dialog/target predicates -> their corresponding observation capabilities
- any step explicitly marked `external-side-effect` or `requiresApproval` -> `explicit-confirmation-gate`

The returned capability set is stable-sorted in taxonomy order, and the analysis also surfaces side-effecting/approval step IDs.

This is deliberately mechanical rather than semantic. A `click` on a button called “Place order” cannot yet infer `financial` commitment solely from the TaskProgram action kind. That is what future commitment detection and higher-level task descriptors must add.

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

This model complements `TaskRuntime`'s existing `interaction` / `external-side-effect` risk handling; it does not weaken it.

## Why document observation is now the next high-leverage slice

The capability assessment makes a structural weakness obvious: the current semantic snapshot is optimized for **interactive nodes**. That is excellent for clicking, typing, widgets, and games, but insufficient for broad research and reading tasks because headings, paragraphs, article text, table content, code blocks, lists, and other non-interactive document content are not represented as a bounded reading model.

A general document-content observer should therefore be implemented on the standalone CDP/session contracts, with:

- frame and open-shadow traversal;
- bounded text/structure extraction rather than `document.body.innerText` dumping;
- headings, landmarks, paragraphs, lists, tables, code/preformatted content, links, images/alt text, and metadata;
- visibility plus document/viewport coordinates where useful;
- stable structural/backend identity when available;
- explicit byte/node/depth budgets;
- deterministic ordering and truncation metadata;
- optional targeted/region refresh for long documents;
- no dependency on Playwright-style locator APIs.

That primitive directly improves information research, content consumption, collaboration, creation/editing context, transaction review, and account-setting comprehension, making it a broader next investment than another site-specific action.
