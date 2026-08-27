# DP11 leading-edge computer-use foundations

This note records the architecture decisions and production Windows embodiment delivered by DP11. The Windows provider now includes a native UI Automation host, exact HWND-bound Windows.Graphics.Capture, generation-aware frame binding, bounded one-shot visual grounding evidence, guarded SendInput fallback, modal/window authority, human-interference detection, integrity gating, transient screenshot retention, and post-action verification. These facilities do not weaken the neutral computer-use safety contracts.

## Decisions implemented in this branch

### 1. Observation trust is machine-represented

Environmental content is observation, not authority. The new `observationTrust.ts` contract distinguishes user-authored instructions, host policy, trusted application state, external untrusted content, and agent-derived observations.

A summary, graph node, retrieval result, or model interpretation cannot acquire instruction authority merely because it was derived from authoritative or untrusted source material. Original user/host authority must remain separately referenced.

This is intended to make prompt-injection consequence gating an architectural property rather than prompt wording.

### 2. Host input requires an interaction lease

`desktopInteractionLease.ts` models three execution modes:

- `background-semantic`
- `interactive-host`
- `isolated-environment`

Interactive-host leases bind an exact desktop and optional generation-bearing surface plus a monotonic human-input baseline. Any observed human input after lease acquisition invalidates dispatch eligibility. Expired, released, or target-drifted leases fail closed.

The dispatching adapter should revalidate the lease immediately before native pointer/keyboard dispatch. If interference occurs after dispatch may have happened, the existing neutral dispatch state must remain `unknown`; callers must not convert that case into a retry-safe failure.

### 3. Grounding is a resolver, not planner identity

`groundingResolver.ts` ranks valid candidates by embodiment strength:

1. application/native API
2. semantic UI
3. keyboard-semantic operation
4. visual grounding
5. raw coordinates

Confidence breaks ties *within* an embodiment class; it does not allow a high-confidence pixel target to outrank a valid semantic/native target.

Visual and coordinate candidates must be bound to a generation-bearing surface and a concrete frame sequence. They are short-lived evidence, not durable control identity.

## Why this direction

Microsoft UI Automation exposes semantic element properties and control patterns, including `Invoke`, `Value`, `Toggle`, `Selection`, `ExpandCollapse`, `Scroll`, `RangeValue`, `Window`, and `Text`. UIA caching exists specifically to avoid repeated cross-process property calls and should be the basis of bounded snapshot acquisition in a production Windows backend.

Microsoft also documents that `RuntimeId` is desktop-local opaque comparison material and can be reused over time. That maps naturally onto this repository's existing generation model: Windows control identity must combine process/window generation with opaque UIA comparison material rather than treating names, AutomationIds, or coordinates as global durable IDs.

UFO² independently converges on the same high-level architecture: UI Automation and Windows/native APIs are preferred, with vision used to cover custom/inaccessible controls. Its picture-in-picture/isolated execution work also validates treating human/agent interference as a first-class desktop concern.

## Production Windows embodiment status

The Windows-specific provider is now implemented without weakening the neutral contract:

- HWND + process-start identity and generation tracking;
- bounded UIA Control View acquisition using cache requests;
- per-control instance identity using opaque RuntimeId comparison plus structural/application hints, never labels alone;
- semantic UIA control-pattern actions before keyboard/pointer fallback;
- event-driven cache invalidation where events trigger re-observation rather than count as proof;
- modal and multi-window ambiguity detection;
- exact-window WGC capture with DPI/geometry/frame generation metadata;
- transient, one-shot artifact consumption for production visual grounding;
- frame-bound visual candidates that are forbidden from manufacturing semantic entity identity;
- foreground lease enforcement before `SendInput`-style fallback;
- non-injected human-input freshness checks at the native dispatch boundary;
- explicit UIPI/integrity failure without silent elevation;
- built-in semantic UIA post-state verification where normalized state exists;
- visual post-action assessment retained strictly as weak evidence that cannot manufacture semantic success;
- password controls marked with UIA `IsPassword`, with Value text redacted before native-host serialization;
- brokered credential application for exact generation-bound password controls using opaque credential references; credential grants are trusted-source-bound, purpose-bound, capped at 60 seconds, and one-shot, and no secret-read/export operation exists in the computer-use protocol;
- the native Windows Credential Manager backend validates the password target before secret lookup and again at application time, copies credential bytes only inside the trusted sidecar, zeroes that private byte copy after use, immediately frees the OS-owned credential allocation, and reports only bounded status/evidence; UIA `ValuePattern.SetValue` necessarily requires a short-lived managed string, so DP11 does not claim deterministic managed-string zeroization;
- semantic password presence automatically escalates screenshot retention to `credential-adjacent` limits;
- authentication orchestration separates credential application, login/continue dispatch, authoritative session verification, and MFA/passkey/Windows Hello/user-presence handoffs; factor use requires a trusted exact-purpose/exact-kind grant capped at 60 seconds plus independent `security-sensitive` consequence authority, and the one-shot grant is consumed before the broker boundary so ambiguous dispatch cannot be retried; factors remain broker-owned opaque references and authentication success requires a newer authoritative state observation;
- runtime capability truth distinguishes password credential application from authentication-factor application; an external trusted factor broker may provide the full factor family, while the native sidecar advertises only partial factor support for exact-target TOTP and never infers passkey/Windows Hello/push authority from generic UIA/native input support; TOTP grants require an exact generation-aware UIA target, the sidecar reads only the named base32 seed from Windows Credential Manager, generates and applies the six-digit TOTP entirely inside the trusted process, zeroes private credential/decoded-seed byte buffers, never serializes seed/code material, and reconciles ambiguous UIA dispatch locally; passkey/Windows Hello/push/user-presence factors are forbidden from acquiring this generic UIA text-target path;
- authenticated-session authority is separately bounded to a trusted-source grant, opaque account reference, exact process/window generation, a maximum 15-minute lifetime, and an observation captured after login; expiry, account drift, generation drift, logout, or an authoritative re-authentication signal fail closed into re-authentication/re-observation rather than silently reusing prior login state;
- long-horizon neutral computer-task checkpoints preserve cursor and dispatch uncertainty plus bounded non-secret resume-context bindings for stable task identity/policy lineage (for example account/tenant identity, environment lineage, and authority revision); resume requires an exact binding match before adapter execution, and the task step budget is cumulative across checkpoint/process resumes so restart cannot manufacture fresh exploration or retry budget;
- short-lived authenticated-session freshness is deliberately not inherited from task history: a trusted continuation gate runs before adapter work and suspends without consuming a step when the Windows session expires, re-authentication is signaled, the account/window generation drifts, re-observation is required, or the authority provider is uncertain; this allows long-running work to pause for a fresh ceremony and later continue under newly proven session authority;
- long-horizon runtimes may attach a durable checkpoint sink; before crossing an action adapter boundary the runtime first persists a conservative `unknown-dispatch` write-ahead fence, and it advances durable state to `completed` only after verified execution and cursor transition; if pre-dispatch persistence is ambiguous the action is not dispatched, and a restart from the durable fence requires reconciliation rather than blind replay;
- Windows Hello/passkey/push/user-presence ceremonies have a separate bounded challenge state model (maximum five minutes) containing only opaque references and trusted state; external webpage content cannot prove ceremony completion, TOTP cannot enter this user-presence path, and ceremony completion remains evidence only until the authenticated-session verifier separately proves login success;
- Windows provider capabilities projected into the neutral `ComputerCapabilityProfile` without inferring unrelated powers;
- explicit embodiment routing exposure with available embodiments, selection reason, fallback/conflict reason, and fail-closed authoritative target conflict handling.

## Research references

- Microsoft UI Automation specification: https://learn.microsoft.com/windows/win32/winauto/ui-automation-specification
- Microsoft UI Automation control patterns: https://learn.microsoft.com/windows/win32/winauto/uiauto-controlpatternsoverview
- Microsoft UI Automation client caching: https://learn.microsoft.com/windows/win32/winauto/uiauto-cachingforclients
- Microsoft UI Automation automated testing / RuntimeId guidance: https://learn.microsoft.com/windows/win32/winauto/uiauto-usefortesting
- Microsoft UFO² architecture: https://github.com/microsoft/UFO/blob/main/documents/docs/ufo2/overview.md
- Microsoft UFO² control detection: https://github.com/microsoft/UFO/blob/main/documents/docs/ufo2/core_features/control_detection/overview.md
