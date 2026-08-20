# Local compute execution modes

The repository exposes two intentionally different local-compute execution models. They share registered-operation authority, bounded canonical JSON input/output, generation-aware job identity, and an adapter-lifetime non-evicted dispatch ledger, but they do **not** make the same timeout/isolation guarantees.

## Guarantee matrix

| Property | Trusted cooperative local compute | Isolated local compute |
| --- | --- | --- |
| Execution model | `trusted-in-process-cooperative` | `isolated-child-process-enforceable-timeout` |
| Process boundary | None; callback runs in the adapter process | Separate child process |
| Deadline | Cooperative abort plus post-return overrun detection | Parent wall-clock deadline covering launch through parent-side result verification |
| Timeout termination | Not enforceable for a blocking/uncooperative callback | Child is force-terminated; termination is only claimed when exit/signal is confirmed |
| Serialized input/output | Canonical JSON with configured byte/depth/item bounds | Canonical JSON with configured byte/depth/item bounds |
| Dispatch replay ledger | Non-evicted for adapter lifetime; capacity exhaustion fails closed | Non-evicted for adapter lifetime; capacity exhaustion fails closed |
| Memory | `memoryBytesHint` only; no hard memory guarantee | `memoryBytesHint` only; no hard child-process memory guarantee |
| Filesystem/network | Trusted callback authority; not sandboxed | Trusted registered module authority; not sandboxed |
| Shell/command payload | Not accepted as local-compute authority | Not accepted; only registered file-backed operation exports are dispatched |

The exported `LOCAL_COMPUTE_GUARANTEES` and `ISOLATED_LOCAL_COMPUTE_GUARANTEES` constants expose the same distinction programmatically.

## When to use each mode

Use `LocalComputeAdapter` for trusted callbacks where cooperative cancellation is sufficient and in-process execution is desirable. Do not use it when a blocking callback must be forcibly stopped at a deadline.

Use `IsolatedLocalComputeAdapter` (preferably through `createIsolatedLocalComputeAdapter`) when the host must be able to terminate unresponsive work after the advertised execution deadline. The child-process boundary is an execution-isolation mechanism, **not** an OS security sandbox: a registered file module still has whatever filesystem/network/runtime authority the host process makes available to it.

## Defining an isolated operation module

```ts
import { defineIsolatedLocalComputeOperation } from 'semantic-browser-interaction-engine';

export const summarize = defineIsolatedLocalComputeOperation((input, context) => {
  context.diagnostic('summary.started');
  return { input };
});
```

The operation module is registered by host code; an action payload cannot supply a module URL, export name, shell command, or arbitrary process invocation.

## Constructing the isolated adapter

```ts
import { createIsolatedLocalComputeAdapter } from 'semantic-browser-interaction-engine';

const adapter = createIsolatedLocalComputeAdapter({
  id: 'local-isolated',
  operations: [
    {
      id: 'summary.run',
      effect: 'pure-read-only',
      moduleUrl: new URL('./operations.js', import.meta.url).href,
      exportName: 'summarize',
    },
  ],
});
```

The preferred factory snapshots registrations and rejects non-`file:` module URLs before adapter construction. The worker independently repeats the `file:` scheme check as defense in depth.

## Exactly-once and uncertainty semantics

A generation-aware identity is sealed in the adapter's dispatch ledger before isolated launch. Once execution may have begun, launch or termination uncertainty does not reopen that identity for replay. Detail/artifact retention may be bounded and evicted, but ledger entries are not evicted during the adapter lifetime; when ledger capacity is exhausted, new identities fail closed before dispatch.

This is an in-memory adapter-lifetime exactly-once dispatch guarantee. It is not a cross-process-restart or durable-storage guarantee beyond the lifetime of that adapter instance.

## Resource limits

`timeBudgetMs`, input/output byte limits, JSON depth/item limits, and diagnostic byte limits are validated bounds used by the adapter/worker path. `memoryBytesHint` is deliberately named and documented as a hint: the child-process mechanism used here does not provide a strict total-memory enforcement guarantee.
