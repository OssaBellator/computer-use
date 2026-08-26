# DP11 Windows provider boundary

This note defines the behavior required from a production Windows provider behind the DP11 contracts. It is intentionally narrower than a full Windows implementation: it specifies where UIA observation, modal authority, visual grounding and SendInput-style fallback must connect to the neutral computer-use runtime.

## UIA cache lifecycle

UI Automation caches are snapshots. `WindowsUiaCacheState` records a provider-local invalidation epoch for an exact generation-bearing window.

A UIA structure/property/focus/window event may advance the epoch and record an invalidation reason. The event is not evidence that an intended action succeeded. Any action depending on the old cache must re-observe and re-resolve its target.

The production provider should acquire cached properties/patterns under an explicit `IUIAutomationCacheRequest` and bounded tree scope. It must stop acquisition before exceeding configured bounds rather than materializing an unbounded UI tree and truncating it afterward.

Microsoft reference: https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/caching-in-ui-automation-clients

## Exact element re-resolution

`RuntimeId` remains opaque comparison material. Before semantic dispatch, the provider must re-resolve the candidate under the exact process/window generation and use UIA element comparison to determine whether the current element is the same underlying UI object.

Microsoft documents `IUIAutomation::CompareElements` specifically for this purpose and notes that RuntimeIds may be reused over time.

References:
- https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation-compareelements
- https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-usefortesting

## Modal/top-level authority

A live HWND is not sufficient interaction authority. `WindowsWindowAuthoritySnapshot` records WindowPattern modal state and interaction state.

The resolver fails closed when the target is:

- closing;
- not responding;
- blocked by a modal window;
- associated with multiple plausible owned modal windows.

When exactly one owned modal is present, that modal becomes the exact interaction target. This prevents input intended for a dialog from leaking into its blocked owner window.

Microsoft's `WindowInteractionState` explicitly includes `BlockedByModalWindow`, `Closing`, `ReadyForUserInteraction`, and `NotResponding`, while WindowPattern exposes `IsModal`.

References:
- https://learn.microsoft.com/en-us/windows/win32/api/uiautomationcore/ne-uiautomationcore-windowinteractionstate
- https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nn-uiautomationclient-iuiautomationwindowpattern

## Native-input dispatch ledger

SendInput-style fallback must pass through `WindowsNativeInputGate` only after:

1. exact target surface binding;
2. interactive-host lease validation;
3. human-interference check;
4. UIPI integrity decision;
5. final dispatch.

The dispatcher reports both requested and inserted event counts because `SendInput` returns the number of events inserted.

Mapping is conservative:

- inserted = 0: definitely not dispatched;
- inserted = requested: dispatched once;
- 0 < inserted < requested: dispatch unknown, reconciliation required;
- malformed count result: dispatch unknown;
- exception at/after the call boundary: dispatch unknown.

A partial keyboard chord or pointer sequence must never be retried as if nothing happened.

Microsoft documents both the event-count return value and UIPI's equal-or-lower-integrity restriction, and notes that ordinary error reporting does not identify UIPI blocking.

Reference: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput

## Required production ordering

The provider execution path should converge on:

```text
intent
  -> semantic/native candidate resolution
  -> exact window authority / modal resolution
  -> exact UIA control re-resolution
  -> semantic UIA pattern when available
  -> otherwise frame-bound fallback grounding
  -> interactive-host lease + human interference check
  -> UIPI gate
  -> exactly one SendInput dispatch attempt
  -> authoritative re-observation
  -> semantic/native verification
  -> reconciliation when dispatch is unknown
```

This keeps Windows as an embodiment of the existing computer-use authority model rather than creating a second agent runtime inside the provider.
