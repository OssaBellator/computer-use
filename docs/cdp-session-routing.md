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
- `router.attach(targetId)`: a `RoutedCdpSession` for one flattened page target;
- `router.activate(targetId)`: foregrounds a target with `Target.activateTarget`; and
- `router.detach(session)`: detaches the target session and removes every routed listener.

## Event isolation

`RoutedCdpSession.on()` wraps each listener and forwards an event only when the protocol message's `sessionId` matches that routed session. A console/dialog/runtime event from another tab cannot accidentally satisfy listeners on the active tab.

`CdpRootSession` applies the inverse rule: it forwards only messages with no `sessionId`. That lets browser-level controllers such as target discovery consume root `Target.*` events without also observing similarly named target-session traffic.

A detached routed session rejects future commands and drops registered wrappers.

## Why this unlocks real tab switching

The pure-CDP semantic frame runtime can construct a complete interaction/browser-agent engine from any `CdpSessionLike`. Combining it with `CdpTargetSessionRouter` means an arbitrary page target can now be:

1. attached from the browser websocket;
2. represented as an isolated routed session;
3. passed to `createPureCdpBrowserAgentEngine()`; and
4. activated/detached independently.

This is the protocol foundation for a higher-level multi-page agent that can switch its active semantic engine rather than merely create/close background targets.

## Regression coverage

Unit regressions cover flattened command routing, per-session event isolation, root-event isolation, detach cleanup, and post-detach failure. The Chromium regression connects to the real browser websocket, attaches the primary and a newly created secondary page, executes commands independently, verifies session-filtered console events, activates the second target, and detaches it cleanly.
