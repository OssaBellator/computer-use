# Computer environment registry trust boundaries

`ComputerEnvironmentRegistry` is the low-level neutral router beneath `ComputerRuntimeComposition` and `ComputerTaskRuntime`. It is public because advanced integrations sometimes need direct adapter routing, but it is intentionally narrower than a task-safety orchestration layer.

This document describes which values the registry treats as neutral authority, which values it snapshots, and which values remain adapter-owned.

## Registration authority

A registered adapter contributes a neutral descriptor:

- adapter ID;
- environment kind;
- adapter version;
- advertised capability IDs.

The registry snapshots that descriptor before validation/storage and uses the same validated snapshot as routing authority. Caller-owned descriptor objects are not retained as live authority.

Capability acquisition is bounded to at most 512 entries. A descriptor that exceeds the bound is rejected rather than copied into registry state.

`ComputerRuntimeComposition` adds another boundary on top of this: it binds adapter methods at registration time and gives each created task runtime its own registry snapshot. Later mutation/replacement in the composition therefore does not silently rebind a runtime that already exists.

## Neutral request snapshots

Before routing an observation, the registry snapshots the neutral observation envelope:

- `adapterId`;
- observation `channel`;
- surface identity and generation;
- target identity and generation;
- observation limits.

Before routing an action, it snapshots the neutral action safety/routing fields:

- `adapterId`;
- `actionId`;
- capability ID;
- effect class;
- idempotency class;
- target identity and generation.

Those snapshots are used for lookup, validation, adapter invocation, and response-coherence checks. A caller mutating its original request object after dispatch begins cannot change those neutral fields across the adapter await.

### Opaque action payloads

`ComputerActionRequest.payload` is deliberately **not** generically deep-cloned by the registry.

Payload schema, bounds, secrecy rules, trusted revision bindings, and accessor/proxy handling are adapter/controller-specific concerns. A filesystem read payload, terminal execution payload, remote-session command, browser action payload, and local-compute operation do not share one safe generic serialization contract.

Typed adapter/controller layers must therefore snapshot and validate their own payload schema before using it as authority across awaits.

This separation is deliberate: the neutral registry protects neutral safety fields without becoming a universal computer object model.

## Neutral response snapshots

After an observation adapter completes, the registry snapshots neutral response metadata before coherence validation:

- adapter ID;
- environment kind;
- observation channel;
- sequence;
- completeness/truncation flags;
- surface identity/generation;
- target identity/generation.

After an action adapter completes, it snapshots:

- action status;
- dispatch state;
- verification state;
- bounded machine-readable evidence.

This prevents accessor-backed or mutable adapter-owned envelopes from presenting different neutral values to different registry checks.

### Opaque response data

Observation `data` and action `details` remain adapter-owned by reference. Their schemas belong to typed capabilities above the neutral registry. Ordinary task traces should not retain arbitrary opaque response data.

## Dispatch uncertainty

The registry preserves a conservative distinction between:

- `not-dispatched`;
- `dispatched-once`;
- `unknown`.

An exception from `adapter.act()` after invocation begins is mapped to `dispatch: 'unknown'`, not to a retry-safe failure. Invalid post-invocation result metadata is also treated conservatively.

This matters because transport failure is not proof that a side effect did not happen.

## Registry `act()` versus task execution

`ComputerEnvironmentRegistry.act()` is intentionally a low-level routing primitive. It validates the neutral request and preserves dispatch/result coherence, but it does **not** replace the stateful task-runtime safety path.

For effectful task execution, callers should normally retain a `ComputerTaskRuntime`. The task runtime adds:

- generation-aware target revalidation;
- approval hooks;
- checkpoint action state;
- no-replay behavior after uncertain dispatch;
- domain verification;
- reconciliation requirements for unresolved dispatch state.

For the same reason, `ComputerRuntimeComposition` does not expose a direct effectful `act()` convenience. It exposes registration, read-only observation, introspection, and task-runtime construction.

## Identity model

The registry does not flatten environments into a universal DOM. Browser, desktop UI, filesystem, terminal, process, remote-session, device, local-compute, and semantic/document models remain peer capabilities.

Neutral identity is adapter-scoped and generation-aware. Surface/entity labels, paths, titles, coordinates, process IDs, or backend handles do not become cross-environment universal identity merely because they are observable.

## What this boundary does not guarantee

The registry does not:

- authenticate durable checkpoints;
- deep-copy arbitrary adapter payloads, observation data, or result details;
- infer effect classes from opaque payloads;
- grant approval for consequential effects;
- prove a higher-level side effect succeeded merely because dispatch succeeded;
- provide a universal semantic model across all applications/environments;
- make concrete host adapters part of the package-root API.

Those responsibilities remain in the appropriate task runtime, typed controller, adapter, backend, or application-semantic layer.
