# Browser-root CDP target session routing

Chromium's browser websocket can attach to multiple page targets with `Target.attachToTarget({ flatten: true })`. Commands and events for those flattened sessions carry a top-level `sessionId`. `CdpTargetSessionRouter` turns that multiplexed transport into ordinary event-capable `CdpSessionLike` objects so the rest of the engine can remain session-local.

## Transport contract

`CdpMultiplexConnectionLike` is intentionally small:

```ts
interface CdpMultiplexConnectionLike {
  send(method, params?, sessionId?): Promise<any>;
  on(event, listener): unknown;
  off?(event, listener): unknown;
}
```

A WebSocket/CDP client implements that browser-root envelope once. The router then provides:

- `router.root`: a `CdpEventSessionLike` that receives only browser-root events;
- `router.attach(targetId)`: a routed session for one flattened page target;
- `router.adopt(targetId, sessionId)`: registers a flattened session created externally, such as browser-root security auto-attach;
- `router.sessionFor(targetId)`: returns the live routed session already owned for a target;
- `router.activate(targetId)`: foregrounds a target with `Target.activateTarget`; and
- `router.detach(session)`: detaches the target session, removes every routed listener, and forgets the registry binding.

A target has at most one routed session in a router. Repeated `attach(targetId)` calls return the same live object instead of creating multiple debugger attachments. After detach, a later attach is allowed to create a fresh session.

## Event isolation

`RoutedCdpSession.on()` wraps each listener and forwards an event only when the protocol message's `sessionId` matches that routed session. A console/dialog/runtime event from another tab cannot accidentally satisfy listeners on the active tab.

`CdpRootSession` applies the inverse rule: it forwards only messages with no `sessionId`. That lets browser-level controllers such as target discovery consume root `Target.*` events without also observing similarly named target-session traffic.

A detached routed session rejects future commands and drops registered wrappers.

## Security-session adoption

Browser-root policy enforcement may attach a target *before* normal semantic control so the initial document cannot run outside policy. `adopt()` makes that security session the router's canonical session for the target. When `MultiPageCdpAgent` later switches into that page, its normal `attach()` path reuses the already-guarded session rather than opening a second debugger channel.

This provides a clean ownership handoff between pre-execution containment and semantic browser use.

## Why this unlocks real tab switching

The pure-CDP semantic frame runtime can construct a complete interaction/browser-agent engine from any `CdpSessionLike`. Combining it with `CdpTargetSessionRouter` means an arbitrary page target can now be:

1. attached or adopted from the browser websocket;
2. represented as an isolated routed session;
3. passed to `createPureCdpBrowserAgentEngine()`; and
4. activated/detached independently.

## Regression coverage

Unit regressions cover flattened command routing, per-session event isolation, root-event isolation, repeated-attach reuse, externally-created session adoption, conflicting adoption rejection, detach cleanup, registry removal, fresh reattach, and post-detach failure. The Chromium regression connects to the real browser websocket, attaches the primary and a newly created secondary page, executes commands independently, verifies session-filtered console events, activates the second target, and detaches it cleanly.
