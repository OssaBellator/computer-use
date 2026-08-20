# Desktop UI production backend seams

`DesktopUiEnvironmentAdapter` remains the environment-neutral boundary. Production OS integrations implement `DesktopPlatformBridge` and are wrapped by `PlatformDesktopUiBackend`; deterministic tests continue to use `SyntheticDesktopUiBackend`.

## Identity and replacement rules

Window handles and accessibility element handles are locators, not authority. A platform bridge must expose an `instanceToken` for the exact live window/control instance behind each native locator.

`PlatformDesktopUiBackend` keeps a stable public window ID for a native window slot and increments its generation whenever that slot's instance token changes. A generation-bearing surface reference therefore cannot silently authorize a replacement window.

Control identity is stricter: within one window generation, each returned `controlId` is bound to one exact control instance. If the OS recycles a native control locator for a replacement control, the backend emits a new opaque `controlId`; the old ID is never reused. Replacement invalidates any prior focus/input authority for that control. When the window generation changes, all control leases for the previous generation are discarded.

## Dispatch boundary

The final platform bridge `dispatch()` call carries the expected window instance token and, for control focus, the expected control instance token. The native helper must re-read and compare those tokens immediately before OS input emission in the same native critical section. If the target is missing or replaced, it returns `rejected` with `dispatched:false` and emits no input.

If a native helper throws or disconnects after input may have been emitted, that exception must propagate. `DesktopUiEnvironmentAdapter` maps it conservatively to `status:'unknown'`, `dispatch:'unknown'`, `verification:'unverified'`. Transport/native-input success is never treated as proof of an application-domain outcome; typed controllers remain responsible for domain verification.

No platform bridge may use browser/page-side `dispatchEvent()` or equivalent synthetic page event injection. Integrations use OS accessibility APIs and native keyboard/pointer facilities subject to the host's ordinary accessibility/security permissions; this layer contains no permission bypass.

## Bounded acquisition

Window enumeration, accessibility traversal, and visual capture receive hard acquisition limits before native work begins. Native helpers must stop enumeration/traversal before exceeding those limits. Visual helpers must reject or down-scope capture before allocating pixel/encoded buffers beyond `maxPixels`/`maxBytes`.

The JSON process bridge also caps helper stdout and execution time. Returned backend-owned objects are rebuilt/frozen again by `PlatformDesktopUiBackend` and then defensively rebuilt/frozen by `DesktopUiEnvironmentAdapter` before crossing the neutral envelope.

## Platform matrix

| Platform | Native semantic API | Window/focus identity seam | Visual seam | Native input seam | Current repository implementation | Main limitations |
| --- | --- | --- | --- | --- | --- | --- |
| Windows | UI Automation (UIA) | Native helper supplies window/control instance tokens; wrapper provides neutral generations/non-reused IDs | Bounded helper capture artifact metadata | Helper uses Windows native keyboard/pointer/focus APIs and atomically revalidates expected tokens | Production-quality JSON/helper seam via `windowsUiAutomationBridge()` | No in-repo UIA helper binary yet; ordinary Windows accessibility/UIPI/security policy still applies; secure desktop/elevated targets may be unavailable |
| macOS | Accessibility (AX) | Native helper supplies AX window/control instance tokens; wrapper provides neutral generations/non-reused IDs | Bounded helper capture artifact metadata | Helper uses macOS native event/focus APIs and atomically revalidates expected tokens | Production-quality JSON/helper seam via `macOsAccessibilityBridge()` | No in-repo AX helper binary yet; Accessibility/Screen Recording permissions are not bypassed; protected surfaces may be unavailable |
| Linux | AT-SPI / native desktop integration | Native helper supplies AT-SPI/native instance tokens; wrapper provides neutral generations/non-reused IDs | Bounded helper capture artifact metadata | Helper uses compositor/X11/portal/native input facilities as available and atomically revalidates expected tokens | Production-quality, rigorously testable process bridge via `linuxAtSpiBridge()` | Current execution environment does not expose a desktop session/native AT-SPI helper binary, so real-host smoke execution is not enabled; Wayland compositor/portal policy may restrict global input/capture |

## Native helper protocol

`NativeJsonDesktopPlatformBridge` invokes a configured helper with `--request <json>`. Requests are versioned and use four operations: `enumerate-windows`, `accessibility`, `visual`, and `dispatch`. The helper is intentionally outside the neutral adapter package so each OS implementation can use its native SDK/toolchain without coupling the core to COM, Objective-C/Swift, D-Bus, X11, or compositor-specific libraries.

For `dispatch`, the helper receives exact expected instance tokens. It must treat validation + input emission as one native authority operation rather than acknowledging a JavaScript-side preflight and dispatching later.

Real host smoke tests should be opt-in and only run where a desktop session and the corresponding helper are locally available. Deterministic contract tests must remain the default validation path.
