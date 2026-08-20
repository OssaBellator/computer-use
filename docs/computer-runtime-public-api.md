# Computer runtime public API

The package root exposes an intentionally small, environment-neutral computer-use surface. It is designed for composing peer environment adapters and running `ComputerTaskRuntime` programs without importing concrete host backends or source-private implementation modules.

```ts
import {
  createComputerRuntimeComposition,
  type ComputerEnvironmentAdapter,
  type ComputerTaskProgram,
} from 'semantic-browser-interaction-engine';
```

## Public layers

The package-root computer surface currently includes:

- neutral environment identity, observation, action, and adapter contracts;
- `ComputerEnvironmentRegistry` for low-level neutral routing;
- capability and profile composition helpers;
- computer task program validation/snapshot contracts;
- task checkpoint encoding/validation contracts;
- `ComputerTaskRuntime` and its approval, target-revalidation, verification, dispatch-state, and recovery semantics;
- `ComputerRuntimeComposition` / `createComputerRuntimeComposition` as the small composition root;
- application-neutral document/editor semantics under the `computerDocumentModels` namespace.

Browser APIs that predate the computer-use surface remain available from the package root.

## Compose peer adapters

Adapters remain peer capabilities. Composition does not flatten browser, desktop UI, filesystem, terminal/process, remote-session, device, local-compute, or document semantics into one universal model.

```ts
const filesystemAdapter: ComputerEnvironmentAdapter = /* environment integration */;
const processAdapter: ComputerEnvironmentAdapter = /* environment integration */;

const computer = createComputerRuntimeComposition([
  filesystemAdapter,
  processAdapter,
]);

for (const descriptor of computer.descriptors()) {
  console.log(descriptor.id, descriptor.kind, descriptor.capabilities);
}
```

`register()` validates adapter descriptors through the neutral registry. Registration is transactional at the composition layer: if composition cannot safely snapshot/bind the adapter methods, the routed descriptor is rolled back rather than left half-installed.

## Read-only observation

The composition root keeps a read-only observation convenience:

```ts
const observation = await computer.observe({
  adapterId: 'filesystem:workspace',
  channel: 'filesystem',
  limits: { maxItems: 128, maxTextBytes: 16_384, maxDepth: 4 },
});
```

There is deliberately no direct `computer.act()` convenience. Effectful task execution belongs on a retained `ComputerTaskRuntime`, where target freshness, approval, dispatch state, post-dispatch verification, and checkpoint/reconciliation semantics remain on the normal safety path.

Advanced callers that intentionally need the low-level routing contract can use `ComputerEnvironmentRegistry` directly.

## Construct and retain a task runtime

```ts
const program: ComputerTaskProgram = {
  id: 'inspect-workspace',
  entry: 'read-files',
  steps: [
    {
      kind: 'observe',
      id: 'read-files',
      request: {
        adapterId: 'filesystem:workspace',
        channel: 'filesystem',
      },
    },
  ],
};

const runtime = computer.createTaskRuntime(program, {
  executionId: '0123456789abcdef0123456789abcdef',
});

const result = await runtime.run();
const checkpoint = runtime.checkpoint();
```

Retaining the runtime is part of the public safety contract. A stateless `runTask()` convenience is intentionally not provided because it could discard no-replay state after uncertain dispatch or incomplete verification.

## Resume from a checkpoint

Use the same program and execution ID when resuming:

```ts
const resumed = computer.createTaskRuntime(program, {
  executionId: '0123456789abcdef0123456789abcdef',
  checkpoint,
});

const resumedResult = await resumed.run();
```

If the checkpoint records `unknown-dispatch` or `dispatched-unverified`, the runtime requires reconciliation rather than silently replaying the action.

Checkpoint provenance, program binding, payload binding rules, and execution identity remain enforced by `ComputerTaskRuntime` / `ComputerTaskCheckpoint`; composition does not duplicate or weaken them.

## Adapter bindings are stable per runtime

`ComputerRuntimeComposition` may be changed after a runtime is constructed:

```ts
const runtime = computer.createTaskRuntime(program, {
  executionId: '11111111111111111111111111111111',
});

computer.unregister('filesystem:workspace');
computer.register(replacementFilesystemAdapter);
```

The existing `runtime` keeps the adapter bindings captured when it was constructed. A newly constructed runtime uses the current composition bindings. This prevents an in-flight program from being silently rebound to another backend instance merely because the composition changed under the same adapter ID.

## Document semantics namespace

Application-neutral document/editor models are exposed under one deliberate namespace instead of being flattened into the historical browser API:

```ts
import { computerDocumentModels } from 'semantic-browser-interaction-engine';

console.log(computerDocumentModels.DOCUMENT_KINDS);
```

This keeps semantic/document models a peer capability rather than turning them into a universal computer DOM.

## Intentionally not public yet

The following source modules are intentionally **not** package-root exports:

- `browserEnvironmentAdapter.ts` / `browserEnvironmentAdapterCore.ts`;
- `desktopUiAdapter.ts`, `desktopUiBackend.ts`, `syntheticDesktopUiBackend.ts`;
- `filesystemAdapter.ts`;
- `processAdapter.ts`, `terminalAdapter.ts`;
- `remoteSessionAdapter.ts`;
- `systemDeviceAdapter.ts`;
- `localComputeAdapter.ts`;
- `realtimeSurfaceTypes.ts`, `realtimeSurfaceCore.ts`, `realtimeSurfaceCalibration.ts`, `realtimeSurfaceRuntime.ts`;
- individual `documentModel*.ts` modules outside the `computerDocumentModels` namespace.

These modules currently expose backend acquisition, host authority/configuration, synthetic-test seams, or experimental contracts that are not ready to become stable package API. Their existence in `src/computer/` is not an invitation to import them as public contracts.

## Architecture invariants

Using the public composition surface does not change the computer-use architecture invariants:

- browser, desktop UI, filesystem, terminal/process, remote session, device, local compute, and semantic/document models remain peer capabilities;
- there is no universal "computer DOM";
- adapter-specific backend handles stay out of neutral core APIs where possible;
- surface/entity generation participates in freshness and authority;
- approval remains explicit for effectful work;
- unknown dispatch is not treated as safe-to-retry;
- effectful dispatch requires verification before completion can be trusted;
- checkpoint provenance and reconciliation remain part of the no-replay boundary.

See [Computer-use architecture](./computer-use-architecture.md) for the broader layering and capability model.
