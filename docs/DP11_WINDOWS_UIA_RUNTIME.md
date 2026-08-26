# DP11 Windows UIA semantic runtime

This note records the rationale for the Windows-specific contracts introduced during DP11 preparation. The core remains provider-neutral: COM/Win32 bindings belong in a production Windows provider, while identity, authority and fail-closed semantics live in the TypeScript runtime.

## Identity

A Windows UI target is not identified by text, AutomationId, RuntimeId or HWND alone.

`WindowsUiaWindowRef` binds:

- opaque HWND representation;
- desktop/session identity;
- PID plus process-start identity to defeat PID reuse;
- window generation.

`WindowsUiaControlRef` additionally binds:

- opaque RuntimeId comparison material;
- optional AutomationId locator hint;
- control type;
- optional structural-path hash;
- control generation.

Microsoft documents that AutomationId is generally unique only among siblings and is not guaranteed stable across application releases. RuntimeId is unique only within the desktop UI where it was produced, can be reused over time, and should be treated as opaque comparison material. A production provider should therefore use UIA element comparison plus the surrounding process/window/control generations rather than promoting either identifier into durable identity.

Reference:
- https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-usefortesting
- https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationelement-getruntimeid

## Cached semantic acquisition

UI Automation property and pattern access can require cross-process calls. Microsoft recommends UIA cache requests/bulk fetching when clients need multiple properties over multiple elements. A cache is a snapshot and must be refreshed when UI state changes; events are an invalidation/re-observation signal rather than proof of semantic success.

The `WindowsUiaProvider.observeCached()` contract therefore receives hard acquisition limits and returns an explicit provider-local invalidation epoch. A production provider must apply those limits while traversing/building the UIA cache, not enumerate an unbounded tree and truncate afterward.

Reference:
- https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-cachingforclients

## Semantic action ladder

`WindowsUiaSemanticRuntime` exposes semantic UIA actions corresponding to these control-pattern families:

1. Invoke
2. Value
3. Toggle
4. SelectionItem
5. ExpandCollapse
6. Scroll
7. RangeValue
8. Window

A semantic call is dispatched only after the exact control is revalidated and the required pattern is still advertised. The semantic provider method is forbidden from silently falling back to SendInput or coordinates. This preserves DP11's embodiment hierarchy: semantic/native operations remain distinguishable from lower-level input fallback.

A provider exception at the dispatch boundary becomes sticky `dispatch: unknown`; it is never converted into an ordinary retry-safe failure.

## UIPI and native input

Windows `SendInput` is subject to User Interface Privilege Isolation (UIPI). Microsoft documents that input injection is permitted only into applications at an equal or lower integrity level, and that the ordinary return/error values do not reliably identify UIPI as the cause.

`decideWindowsInputIntegrity()` therefore fails closed when either integrity level is unknown and rejects a higher-integrity target before native input is attempted. The production Windows input backend should perform this check before acquiring/using an interactive-host input lease.

Reference:
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput

## Next implementation slice

The next production provider should implement:

- bounded `IUIAutomationCacheRequest` acquisition over the target HWND;
- process-start/window generation tracking;
- exact UIA control re-resolution and comparison immediately before dispatch;
- UIA event-driven cache invalidation without treating events as proof;
- typed control-pattern dispatch with no hidden input fallback;
- modal/top-level-window ambiguity detection;
- Windows.Graphics.Capture frame generation tied to exact HWND geometry/DPI;
- SendInput behind both UIPI gating and the DP11 foreground/human-interference lease.

The provider should remain an embodiment of the existing neutral computer-use contracts, not become a second planner or agent runtime.
