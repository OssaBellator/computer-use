# DP11 Windows provider boundary

This note defines the behavior required from a production Windows provider behind the DP11 contracts. The TypeScript runtime owns safety semantics; the eventual COM/Win32 bridge owns platform calls and must not weaken those semantics.

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
  -> exactly one native input call
  -> authoritative re-observation
  -> verification/reconciliation
```

No lower layer may promote transport success into higher-level semantic success.

## Bounded UIA cache planning

`WindowsUiaProviderRuntime` converts neutral observation limits into a provider cache plan containing tree scope, requested properties/patterns, maximum items, maximum depth, and maximum text bytes.

The COM bridge must apply these bounds while traversing/building the UIA cache. It must not materialize an unbounded subtree and trim it afterward.

The default cache surface includes identity, control type, enabled/offscreen state, bounds, common semantic patterns, and WindowPattern modal/interaction state.

Microsoft UI Automation cache requests are the intended implementation mechanism: configure properties/patterns plus `TreeScope`, then obtain elements with BuildCache APIs. Cached state is a snapshot.

## UIA cache lifecycle

`WindowsUiaCacheState` records a provider-local invalidation epoch for an exact generation-bearing window. A UIA structure/property/focus/window event may advance the epoch and record an invalidation reason. The event is not evidence that an intended action succeeded.

A cache build captures the current epoch. If an event advances the epoch while the cache is being built, the stale observation cannot be registered as current.

Microsoft reference: https://learn.microsoft.com/windows/win32/winauto/uiauto-cachingforclients

## Exact element re-resolution

`RuntimeId` remains opaque comparison material. Before semantic dispatch, the provider must re-resolve the candidate under the exact process/window generation and use UIA element comparison to determine whether the current element is the same underlying UI object.

`WindowsUiaProviderRuntime` requires a fresh provider snapshot and `compareElements` agreement during revalidation. The production COM bridge should implement that operation with `IUIAutomation::CompareElements`.

References:
- https://learn.microsoft.com/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation-compareelements
- https://learn.microsoft.com/windows/win32/winauto/uiauto-usefortesting

## Event routing and invalidation epochs

`WindowsUiaEventRouter` serializes registration/removal of UIA handlers. Microsoft warns that UIA clients should not concurrently add/remove event handlers, and current handler-group APIs are preferred on modern Windows.

Event delivery has one authority only: increment the invalidation epoch for the affected window. Structure/property/focus/window events do not verify that an earlier action succeeded.

References:
- https://learn.microsoft.com/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation-addautomationeventhandler
- https://learn.microsoft.com/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationeventhandlergroup-addautomationeventhandler

## Modal/top-level authority

A live HWND is not sufficient interaction authority. `WindowsWindowAuthoritySnapshot` records WindowPattern modal state and interaction state.

The resolver fails closed when the target is closing, not responding, blocked by a modal window, or associated with multiple plausible owned modal windows. When exactly one owned modal is present, that modal becomes the exact interaction target.

Microsoft's `WindowInteractionState` explicitly includes `BlockedByModalWindow`, `Closing`, `ReadyForUserInteraction`, and `NotResponding`, while WindowPattern exposes `IsModal`.

References:
- https://learn.microsoft.com/windows/win32/api/uiautomationcore/ne-uiautomationcore-windowinteractionstate
- https://learn.microsoft.com/windows/win32/api/uiautomationclient/nn-uiautomationclient-iuiautomationwindowpattern

## Native-input dispatch ledger

SendInput-style fallback must pass through `WindowsNativeInputGate` only after exact target surface binding, interactive-host lease validation, human-interference check, UIPI integrity decision, and final dispatch.

The dispatcher reports both requested and inserted event counts because `SendInput` returns the number of events inserted.

Mapping is conservative:

- inserted = 0: definitely not dispatched;
- inserted = requested: dispatched once;
- 0 < inserted < requested: dispatch unknown, reconciliation required;
- malformed count result: dispatch unknown;
- exception at/after the call boundary: dispatch unknown.

A partial keyboard chord or pointer sequence must never be retried as if nothing happened.

Reference: https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput

## Visual fallback

Visual coordinates bind the exact window/process generation, capture generation, frame sequence, frame size, window geometry, and DPI. Movement, resize, DPI change, recapture, or target replacement invalidates them.

## Production bridge still required

The repository still does not claim a live COM provider. The next implementation layer should supply:

- COM apartment/thread ownership;
- `IUIAutomationCacheRequest` construction and bounded traversal;
- `IUIAutomationEventHandlerGroup` or equivalent serialized subscription;
- `IUIAutomation::CompareElements` exact comparison;
- WindowPattern state acquisition;
- typed Invoke/Value/Toggle/SelectionItem/ExpandCollapse/Scroll/RangeValue/Window calls;
- HWND-bound Windows.Graphics.Capture;
- caller/target integrity token inspection;
- `SendInput` dispatch returning exact requested/inserted counts.

The platform bridge is an embodiment provider, not a planner and not an alternate safety runtime.
