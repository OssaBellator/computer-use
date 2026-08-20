# Bounded network-idle waits

`CdpNetworkActivityMonitor` tracks request lifecycle through the CDP `Network` domain without retaining URLs, headers, request bodies, response metadata, or initiator stacks. The monitor keeps only in-flight request IDs long enough to reconcile lifecycle events and exposes aggregate counters.

## Opt-in monitoring

Network monitoring is explicit on the browser-agent facade:

```ts
const engine = await createPureCdpBrowserAgentEngine(session, {
  networkActivity: true,
});
```

`prepare()` enables the `Network` domain before task execution. Without this opt-in, `wait-network-idle` fails closed rather than claiming that an unobserved page is quiet.

## Static task step

`wait-network-idle` is an observe-only task step:

```ts
{
  id: 'settle',
  kind: 'wait-network-idle',
  quietMs: 100,
  maxInflight: 0,
  timeoutMs: 2000,
  pollIntervalMs: 25,
  next: 'check-result',
  onTimeout: 'failed',
}
```

The step requires a continuous quiet period after the last network lifecycle change. `maxInflight` can tolerate a bounded number of long-lived requests when necessary. All timing/count fields are statically validated and bounded by the compiled program.

Because this is observation rather than interaction, the step never enters task risk/approval logic and does not contribute to the semantic no-progress stall counter. Missing monitoring support, monitor errors, or an exhausted timeout return `wait-timeout` and can only follow the predeclared `onTimeout` edge.

## Trace and privacy boundary

Task traces contain only normal step/outcome/fingerprint metadata. Network counters, request IDs, and request destinations are not copied into traces. The monitor itself never stores request URLs or payloads.

## Multi-page behavior

`MultiPageTaskEngine` delegates network-idle waits to the currently selected semantic page. With no active page, the wait returns non-idle and follows the normal timeout path. Each page engine must have network monitoring enabled through its page options for the wait to succeed.

## Regression coverage

Unit regressions cover lifecycle reconciliation, quiet-period timing, failed requests, URL redaction, task option forwarding, observe-only approval behavior, missing-monitor recovery, invalid budgets, and multi-page delegation. Real Chromium coverage observes an actual `fetch()` request, verifies URL-redacted idle, and runs a complete `wait-network-idle` task through the pure-CDP browser-agent engine.
