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
- Windows provider capabilities projected into the neutral `ComputerCapabilityProfile` without inferring unrelated powers;
- explicit embodiment routing exposure with available embodiments, selection reason, fallback/conflict reason, and fail-closed authoritative target conflict handling.

## Research references

- Microsoft UI Automation specification: https://learn.microsoft.com/windows/win32/winauto/ui-automation-specification
- Microsoft UI Automation control patterns: https://learn.microsoft.com/windows/win32/winauto/uiauto-controlpatternsoverview
- Microsoft UI Automation client caching: https://learn.microsoft.com/windows/win32/winauto/uiauto-cachingforclients
- Microsoft UI Automation automated testing / RuntimeId guidance: https://learn.microsoft.com/windows/win32/winauto/uiauto-usefortesting
- Microsoft UFO² architecture: https://github.com/microsoft/UFO/blob/main/documents/docs/ufo2/overview.md
- Microsoft UFO² control detection: https://github.com/microsoft/UFO/blob/main/documents/docs/ufo2/core_features/control_detection/overview.md
