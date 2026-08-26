# DP11 Windows provider boundary

This note defines the production Windows provider behind the DP11 contracts. TypeScript owns cross-channel safety semantics; the native Windows host owns platform calls and must not weaken those semantics.

## Provider execution chain

```text
intent
  -> semantic/native resolution
  -> modal/top-level window authority
  -> exact UIA re-resolution
  -> semantic pattern dispatch when available
  -> frame-bound visual fallback only when needed
  -> interactive-host lease
  -> UIPI integrity gate
  -> final foreground + physical-input revalidation
  -> exactly one native input call
  -> authoritative re-observation
  -> verification/reconciliation
```

No lower layer may promote transport success into higher-level semantic success.

## Native host shape

`native/windows/Ossa.ComputerUse.WindowsHost` is a line-delimited JSON sidecar with a fixed operation allowlist. There is no generic shell/command/exec operation. `hello.implementedOperations` reports only the primitives actually available in the current Windows session.

The host owns two dedicated MTA executors:

- UI Automation/window identity/event work runs on the UIA MTA;
- Windows.Graphics.Capture work runs on a separate capture MTA.

The Node runtime spawns the executable with `shell:false`, correlates one bounded response to each request, and treats process exit or malformed framing as loss of native authority.

## Bounded UIA cache planning

`WindowsUiaProviderRuntime` converts neutral observation limits into a provider cache plan containing tree scope, requested properties/patterns, maximum items, maximum depth, and maximum text bytes.

The native UIA service applies these bounds during Control View traversal. It does not materialize an unbounded subtree and trim it afterward. Returned recursive trees carry exact node/text accounting and one exact window generation throughout.

The cache surface includes identity, control type, enabled/offscreen state, bounds, common semantic patterns, and WindowPattern state required by the higher-level runtime.

Microsoft UI Automation cache requests are the intended mechanism: configure properties/patterns plus `TreeScope`, then obtain snapshot state through cache/update operations.

Microsoft reference: https://learn.microsoft.com/windows/win32/winauto/uiauto-cachingforclients

## UIA cache lifecycle

`WindowsUiaCacheState` records a provider-local invalidation epoch for an exact generation-bearing window. UIA structure/property/focus/window events may advance the epoch and record an invalidation reason. An event is never evidence that an intended action succeeded.

Native event registration/removal executes on the UIA MTA. Event callbacks only enqueue bounded invalidation codes; TypeScript polls those codes and feeds the monotonic epoch router. If the polling channel becomes unhealthy, the current cache is conservatively invalidated.

A cache build captures the current epoch. If an event advances the epoch while the cache is being built, the stale observation cannot be registered as current.

## Exact element re-resolution

`RuntimeId` remains opaque comparison material. Before semantic dispatch, the provider re-resolves the candidate under the exact process/window generation and uses UIA element comparison to determine whether the current element is the same underlying UI object.

`WindowsUiaProviderRuntime` requires a fresh provider snapshot and `compareElements` agreement during revalidation. The native service repeats resolution/comparison immediately before the real pattern call so the final identity check and effect boundary share one serialized MTA operation.

References:
- https://learn.microsoft.com/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation-compareelements
- https://learn.microsoft.com/windows/win32/winauto/uiauto-usefortesting

## Modal/top-level authority

A live HWND is not sufficient interaction authority. `uia.window-states` accepts a bounded batch of exact generation-bearing windows and returns normalized WindowPattern state plus an owner only when that owner can be resolved through the already-observed generation registry.

The native service combines:

- WindowPattern `IsModal`;
- WindowPattern topmost state;
- `WindowInteractionState`;
- Win32 `GW_OWNER`;
- exact observed-window generation validation.

`WindowsNativeHostWindowAuthority` descriptor-validates that batch before feeding `decideWindowsWindowAuthority`. A blocked owner may route to exactly one owned modal, nested unique modal chains are followed, and ambiguity/cycles/closing/not-responding windows fail closed.

References:
- https://learn.microsoft.com/windows/win32/api/uiautomationcore/ne-uiautomationcore-windowinteractionstate
- https://learn.microsoft.com/windows/win32/api/uiautomationclient/nn-uiautomationclient-iuiautomationwindowpattern

## Native-input dispatch ledger

SendInput fallback passes through `WindowsNativeInputGate` only after exact target surface binding, interactive-host lease validation, human-interference check, and UIPI integrity decision.

The final native operation carries an immutable authority snapshot containing the exact generation-bearing target window and the lease's physical-input baseline. Inside one UIA MTA work item, immediately before `SendInput`, the native host repeats:

1. process-start generation validation;
2. exact observed HWND/UIA generation validation;
3. HWND/PID agreement;
4. physical/non-injected input sequence agreement;
5. exact foreground HWND agreement;
6. a second physical-input sequence check;
7. exactly one `SendInput` call.

The low-level keyboard/mouse monitor ignores injected events, so the agent's own `SendInput` does not invalidate its lease. If hooks cannot be installed, both `input.human-sequence` and production `input.send` are omitted from `implementedOperations`.

The dispatcher reports requested and inserted event counts because `SendInput` returns the number of events inserted.

Mapping is conservative:

- proven pre-effect validation failure: definitely not dispatched;
- inserted = 0 after the effect call: definitely not dispatched;
- inserted = requested: dispatched once;
- 0 < inserted < requested: dispatch unknown, reconciliation required;
- malformed count/result: dispatch unknown;
- exception at/after the call boundary: dispatch unknown.

A partial keyboard chord or pointer sequence is never retried as if nothing happened.

Reference: https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput

## HWND-bound Windows.Graphics.Capture

When `GraphicsCaptureSession.IsSupported()` succeeds in the current session, the host advertises both `capture.next-frame` and `artifact.release`.

Capture authority originates from an exact window emitted by `system.windows`. The UIA MTA validates that generation immediately before capture, the capture MTA creates a `GraphicsCaptureItem` for the HWND, and the UIA MTA validates the same window again before the artifact is returned. A replacement during capture revokes the artifact.

The capture service uses a free-threaded frame pool, exact `ContentSize`, system-relative frame time, current HWND geometry/DPI, and a D3D11 device with hardware then WARP fallback. A one-shot frame is encoded to PNG behind a bounded artifact token; raw bytes do not cross the neutral computer-use contract.

Native limits bound pixels, encoded bytes, retained artifact count, and retained bytes. Artifact buffers are cryptographically zeroed on release, expiry, revocation, and host disposal. Native storage imposes a 60-second absolute lifetime even if a caller bypasses the stricter TypeScript retention manager; sensitive and credential-adjacent leases remain capped at 5 seconds and 1 second respectively.

Visual coordinates bind the exact window/process generation, capture generation, frame sequence, frame size, window geometry, and DPI. Movement, resize, DPI change, recapture, or target replacement invalidates them.

## Visual grounding boundary

`WindowsVisualGroundingProvider` is model/vendor neutral. A trusted backend receives an artifact token, the exact frame reference, and a bounded query. It must echo the artifact token, capture generation, and frame sequence in its response.

Returned points/regions are accepted only when they remain inside that exact image. Candidate IDs, labels, confidence and evidence are bounded and descriptor-validated. Screenshot-derived candidates never contain or manufacture a durable semantic control identity.

The production runtime reports visual grounding as supported only when both live WGC capture and an explicitly supplied grounding backend are present. Capture alone remains partial visual grounding capability.

## Validation status

The earlier Windows VM validation established the production UIA/native subset against real Notepad and the interactive desktop: bounded semantic trees, exact element comparison, semantic Value/SelectionItem/ExpandCollapse/Window actions, event registration/invalidation, integrity reads, stale-ref rejection, and real relative/absolute SendInput were exercised successfully.

Changes after that validation include the concrete WGC implementation, native artifact expiry, non-injected human-input hooks, final native foreground/interference SendInput checks, native modal/window-state batches, and the exact-frame visual-grounding boundary. These newer changes must pass the next Windows receipt (`scripts/test.ps1`) and targeted live tests before they are described as Windows-validated.

The platform bridge is an embodiment provider, not a planner and not an alternate safety runtime.
