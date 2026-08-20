# Computer-use architecture

The long-term architecture is a **computer-use agent with environment adapters**, not a browser agent that gradually accumulates special cases for every non-browser task.

The standalone Chromium stack remains valuable: it is the first high-fidelity adapter and already supplies difficult invariants around identity, bounded observation, native input, pre-action safety, exactly-once side effects, result verification, and checkpointing. The migration goal is to lift those invariants into an environment-neutral core while keeping browser-specific protocol details inside the browser adapter.

## Broader task scope

The computer-use capability model tracks seven broad categories:

1. Document Creation & Media Production
2. Data Processing & Analytics
3. File & Storage Management
4. System Administration & Security
5. Communication & Remote Access
6. Gaming & Digital Entertainment
7. Process Automation

These are deliberately broader than the existing seven web-task categories. A browser can contribute to many tasks, but broad native-computer coverage requires capabilities that a browser does not provide: filesystem/process state, terminal execution, desktop accessibility, OS settings, remote sessions, device state, and direct local application control.

## Core layering

```text
Task / planner / policy
        |
        v
computer-use core
  - capability assessment
  - environment/surface/entity identity
  - observation routing
  - effect classification + approval
  - dispatch-state tracking
  - verification + retry policy
  - checkpoint/recovery contracts
        |
        +----------------+----------------+----------------+----------------+
        |                |                |                |                |
        v                v                v                v                v
 browser adapter    desktop UI       filesystem      terminal/process   remote/device
 (CDP today)        adapter           adapter         adapters            adapters
```

The core must not depend on DOM nodes, CDP frame IDs, browser tabs, Windows HWNDs, Unix PIDs, filesystem paths, terminal PTYs, or device handles. Those are adapter implementation details.

## Environment adapters

`ComputerEnvironmentAdapter` is the lowest common execution boundary. Initial environment kinds are:

- `browser`
- `desktop-ui`
- `filesystem`
- `terminal`
- `process`
- `remote-session`
- `device`

The interface is intentionally small: describe capabilities, observe one channel, and act. Typed higher-level controllers should sit above it; task authors should not manufacture arbitrary adapter payloads.

This lets the planner eventually choose the most appropriate execution path. For example, moving a local file should normally use a filesystem adapter rather than dragging an icon through a desktop UI. Editing a spreadsheet cell may use a native application accessibility adapter when available, but visual/pointer fallback remains possible when semantic APIs are incomplete.

## Identity: adapter -> surface -> entity -> generation

Browser automation already showed that stable identity matters more than labels or coordinates. The generalized model keeps that lesson.

A `ComputerSurfaceRef` identifies an adapter-owned interaction surface such as:

- a browser page/target;
- a desktop window;
- a terminal tab/session;
- a remote desktop session;
- a device configuration surface.

A `ComputerEntityRef` identifies an adapter-owned entity such as a UI control, document, file, directory, process, terminal session, remote host, media object, device, selection, or visual region.

References contain only bounded opaque IDs plus environment/surface/generation information. User-visible titles, paths, page text, command output, credentials, clipboard contents, or file contents are not identity.

Generation is first-class because a recycled window handle, renderer, process ID, terminal session, or device connection must not silently inherit the authority granted to an earlier object.

## Channelized observation instead of one giant "computer DOM"

The core defines observation channels rather than flattening all computer state into one universal tree:

- semantic UI
- document/content
- visual
- selection
- filesystem
- terminal
- process
- network
- media
- device

Each adapter/channel owns a bounded typed schema. The generic observation envelope carries routing/completeness/truncation metadata but treats channel data as opaque.

This preserves the separation already used in the browser stack: article/document content should not bloat interactive-control state, and visual motion should not pretend to be semantic UI structure. The same principle applies to filesystem trees, process tables, terminal transcripts, and device telemetry.

## Direct state adapters and UI adapters are peers

Computer use should not mean "move a mouse for everything."

Where a trusted native interface exists, direct adapters are preferable because they are more observable and verifiable:

- filesystem enumeration/read/write instead of File Explorer/Finder automation;
- process observation instead of reading Task Manager visually;
- bounded terminal execution instead of typing commands into a terminal window;
- native accessibility APIs for desktop controls when available.

UI/visual interaction remains essential for applications whose semantics are exposed only through accessibility trees, rendering, or input. The planner should be able to mix direct and UI adapters within one task while preserving a single safety/verification model.

## Effect classification and approval

The browser commitment gate generalizes into environment-neutral effect classes:

- observe-only
- local reversible
- local destructive
- system configuration
- external communication
- external transaction
- security-sensitive
- process trigger
- remote execution
- hardware-affecting

Everything except observe-only and local-reversible actions requires approval by default in the current core policy helper.

Examples:

- reading a directory: observe-only;
- focusing a window: local reversible;
- deleting/overwriting a file: local destructive;
- changing a firewall rule: security-sensitive/system configuration;
- sending a message: external communication;
- running a deployment script: process trigger or remote execution;
- partitioning a drive: local destructive/system configuration;
- changing a VR/peripheral mode: hardware-affecting.

Individual adapters can provide richer effect descriptors later, but they must not weaken the core classification silently.

## Dispatch and retry semantics

The browser side-effect work established an important invariant: after a potentially consequential operation might have been dispatched, the runtime must not casually retry it.

The generalized action result therefore distinguishes:

- `not-dispatched`
- `dispatched-once`
- `unknown`

and separately records verification state.

`computerActionMayAutoRetry()` permits automatic repetition after a known pre-dispatch failure, and permits repeatable read-only observations. It fails closed after a possible side-effecting dispatch.

This applies equally to purchases, file deletion, package installation, terminal commands, remote SSH commands, sending messages, process triggers, or device configuration.

## Verification is domain-specific, policy is shared

The core should not define a single generic "success" heuristic. Verification belongs to typed controllers:

- filesystem operation -> inode/path/metadata/content-hash or directory-state checks;
- process launch -> process identity plus expected state/exit evidence;
- terminal command -> command/session identity plus exit status and bounded output evidence;
- desktop edit -> application/document identity plus changed semantic state;
- system setting -> OS-authoritative readback;
- remote command -> host/session identity plus remote result state;
- browser commitment -> current commitment/result identity verifier.

The shared runtime decides what to do with `verified`, `pending`, `rejected`, `mismatch`, and `unverified`; adapters decide how those states are established.

## Checkpointing and recovery

The existing pure task-checkpoint codec should become environment-neutral before runtime recovery is enabled.

A future computer checkpoint should contain only:

- program/execution identity;
- current task cursor and budgets;
- adapter IDs and non-sensitive surface/entity fingerprints needed to prove continuity;
- verification state necessary to prevent replay.

It must not persist terminal transcripts, command secrets, clipboard contents, document text, file contents, credentials, tokens, financial details, or arbitrary adapter observations.

Restoring a checkpoint must revalidate every adapter/surface generation used by the next step. A restarted PID, new terminal session, replaced browser target, remounted filesystem, or reconnected remote desktop session cannot be assumed equivalent because an opaque ID happens to match.

## Browser migration plan

The browser architecture should be generalized incrementally rather than rewritten.

### Phase 1: neutral contracts and capability bridge

This slice introduces the computer-use taxonomy, adapter/identity/action contracts, and a conservative projection from the existing browser capability profile.

No browser runtime behavior changes in this phase.

### Phase 2: core observation/action ports

Extract the parts of `TaskRuntime` and planning that only need:

- stable entity identity;
- observation requests;
- typed actions;
- effect descriptors;
- verification outcomes.

Keep browser-specific target resolution and CDP controllers behind an adapter implementation.

### Phase 3: read-only native adapters

Add low-risk adapters first:

1. filesystem observation and bounded reads;
2. process observation/resource state;
3. desktop accessibility observation;
4. terminal-session observation without command execution.

Read-only adapters exercise identity/routing/checkpoint semantics without introducing destructive execution.

### Phase 4: bounded local mutation

Add explicit typed operations with fresh-state preflight and post-action verification:

- file create/write/move/copy/delete;
- process launch/control;
- terminal command execution;
- desktop application editing;
- software/system setting operations.

Each capability gets its own effect classification and retry-safe verifier before being promoted.

### Phase 5: remote and hardware adapters

Add SSH/RDP/VNC and device/peripheral adapters only after local dispatch, identity, approval, and recovery semantics are mature. Remote execution and hardware-affecting actions should fail closed on host/device identity drift.

## Browser capability projection

`computerProfileFromBrowserProfile()` intentionally preserves browser strengths while refusing false equivalences.

For example:

- browser document observation -> computer `document-observation`;
- browser pointer/keyboard/text -> corresponding input capabilities, scoped to the browser adapter;
- browser rich-text editing -> partial computer document editing;
- browser media playback -> partial computer media playback;
- browser realtime/game input -> partial computer game control.

But:

- web upload/download != local filesystem management;
- browser network observation != general network-session control;
- Chromium process launch != general OS process control;
- browser pages != RDP/VNC/SSH sessions;
- web settings != OS/firewall/device settings.

The bridge tests those negative claims so later capability growth is explicit and reviewable.

## Near-term priorities

After the neutral core is stable, the highest-leverage sequence is:

1. refactor browser runtime interfaces behind the neutral identity/observation/action ports without changing behavior;
2. add read-only filesystem and process adapters;
3. generalize checkpoint fingerprints across adapters;
4. add desktop accessibility observation (Windows UI Automation, macOS Accessibility, Linux AT-SPI through separate native adapters rather than framework coupling);
5. add bounded filesystem mutation with approval + exact verification;
6. add terminal/process execution with command/session identity, exit verification, and no-auto-retry after uncertain dispatch;
7. add native office/IDE/media application controllers incrementally;
8. add remote-session and hardware/device adapters last.

This keeps the project moving from browser automation toward computer use while preserving the safety and verification discipline already established in the browser stack.
