# Plan-then-execute task runtime

The interaction engine is deliberately strong at **grounding and execution**: it resolves semantic targets, plans across keyboard/pointer/scroll modalities, dispatches browser input, observes the result, and replans when the browser diverges.

The task runtime adds the layer above that: a bounded, typed control-flow graph for multi-step browser work, including first-class browser navigation and browser-state predicates.

## Why this shape

Long-horizon browser agents fail for two recurring reasons:

1. the controller can keep inventing new actions after every page observation, which makes recovery hard to audit and lets untrusted page content influence control flow; and
2. retries and recovery loops often lack explicit budgets or semantic progress checks.

`TaskProgram` addresses both. A program is compiled **before execution**. Runtime browser state may satisfy a predicate or choose between predeclared branches, but it cannot create new actions, selectors, typed text, or destinations.

The runtime is intentionally model-agnostic: an LLM, rules engine, planner, or human can produce a `TaskProgram`, but execution is deterministic once the program and trusted inputs are fixed.

## Core guarantees

- **Static action graph.** `activate`, `type`, and `navigate` actions, branch destinations, recovery edges, and completion conditions are declared before execution.
- **Trusted data flow.** Typed text and navigation destinations can come only from literals in the program or named task inputs. Browser-derived text is not accepted as an action payload or destination.
- **Fail-closed targeting.** Semantic actions require unambiguous targets by default.
- **Observed success.** Semantic actions advance only on `verified` evidence. Navigation advances only after CDP reports no protocol error and a new document/URL state reaches the requested readiness level.
- **Navigation identity.** Browser state includes URL, origin, title, document readiness, history length, and `performance.timeOrigin`; the latter prevents an already-complete old document from being mistaken for a completed reload/navigation.
- **Bounded recovery.** Global step budgets, per-step visit budgets, bounded waits, and no-progress detection stop runaway loops.
- **Declared side-effect policy.** Steps marked `external-side-effect` are blocked by default unless the caller raises the risk budget or supplies an approval callback.
- **Auditable traces.** Trace entries record step IDs, outcomes, target IDs, action status, and compact state fingerprints without logging typed task inputs, navigation URLs, or page text.
- **Fixed recovery paths.** Failures may follow only `onFailure` / `onTimeout` edges already present in the program.

## CDP browser-agent facade

For Chromium/CDP usage, `createCdpBrowserAgentEngine()` composes the semantic interaction engine and browser-level navigation/state on the same CDP session:

```ts
import {
  createCdpBrowserAgentEngine,
  TaskRuntime,
  type TaskProgram,
} from './src/index.js';

const engine = createCdpBrowserAgentEngine(page, cdpSession);
const runtime = new TaskRuntime(engine);
```

You can still access lower-level interaction capabilities through `engine.interaction` when a task needs explicit planning or acquisition diagnostics.

## Example: navigate, fill, verify, save

```ts
const program: TaskProgram = {
  version: 1,
  name: 'update-profile',
  entry: 'open-profile',
  inputs: ['profileUrl', 'displayName'],
  steps: [
    {
      id: 'open-profile',
      kind: 'navigate',
      url: { input: 'profileUrl' },
      waitUntil: 'complete',
      next: 'verify-location',
      onFailure: 'failed',
    },
    {
      id: 'verify-location',
      kind: 'assert',
      condition: {
        kind: 'browser',
        state: { url: { input: 'profileUrl' }, readyState: 'complete' },
      },
      next: 'type-name',
      onFailure: 'failed',
    },
    {
      id: 'type-name',
      kind: 'type',
      target: { role: 'textbox', name: 'Display name' },
      text: { input: 'displayName' },
      expectedValue: { input: 'displayName' },
      next: 'save',
      onFailure: 'failed',
    },
    {
      id: 'save',
      kind: 'activate',
      target: { role: 'button', name: 'Save' },
      risk: 'external-side-effect',
      next: 'wait-saved',
      onFailure: 'failed',
    },
    {
      id: 'wait-saved',
      kind: 'wait',
      condition: { kind: 'exists', target: { role: 'status', name: 'Saved' } },
      maxPolls: 20,
      pollIntervalMs: 100,
      next: 'done',
      onTimeout: 'failed',
    },
    { id: 'done', kind: 'complete' },
    { id: 'failed', kind: 'fail' },
  ],
};

const result = await runtime.run(
  program,
  { profileUrl: 'https://example.test/profile', displayName: 'Ada' },
  {
    approve: async ({ risk, stepId }) => {
      return risk === 'external-side-effect' && stepId === 'save';
    },
  },
);
```

## Step kinds

- `navigate`: navigate to a literal/trusted-input absolute URL and wait for `commit`, `interactive`, or `complete`.
- `activate`: acquire and semantically activate a target.
- `type`: acquire an editable target and type literal/trusted-input text.
- `assert`: require a semantic or browser-level predicate or route to a fixed recovery edge.
- `branch`: choose one of two predeclared destinations from observed state.
- `wait`: poll a predicate with a bounded observation budget.
- `complete`: terminate successfully, optionally behind a final condition.
- `fail`: terminate explicitly as a failed task.

Predicates compose with `all`, `any`, and `not`. Semantic predicates can test target existence or node state such as focus, disabled/expanded/checked/selected/pressed state and input value. Browser predicates can test exact/partial URL, origin, exact/partial title, ready state, and history length.

## Navigation safety boundary

`CdpNavigationController` accepts absolute `http:`, `https:`, `about:`, and `data:` URLs. It rejects schemes such as `javascript:` and does not enable `file:` navigation by default. Navigation destinations remain subject to the same trusted-input rule as typed text.

For production agents, add an origin allowlist in the surrounding session/policy layer and mark sensitive navigation or submission actions as `external-side-effect` when they can trigger irreversible state.

## Local and live validation

The project intentionally does not rely on GitHub Actions. Run local regressions with:

```bash
npm run typecheck
npm test
npm run test:chromium
```

`test:chromium` includes deterministic browser-level navigation coverage that uses real Chromium/CDP without requiring internet access.

A separate opt-in test exercises a real public website when the machine has unrestricted network access:

```bash
npm run test:live
```

The live test is skipped during ordinary `test:chromium` runs unless `RUN_LIVE_WEB=1` is set.

## Security boundary

```text
user goal / trusted inputs
          |
          v
 planner / compiler
          |
          v
   typed TaskProgram   <---- review / policy / approval
          |
          v
      TaskRuntime
          |
          +---- semantic/browser state may satisfy predicates
          +---- semantic/browser state may choose declared branches
          X---- browser state cannot synthesize actions or destinations
          |
          +---- semantic actions -> InteractionEngine
          +---- navigation -------> CDP navigation controller
          |
          v
 verified browser effects
```

For higher-risk deployments, keep credentials and secrets outside browser-readable state, restrict allowed origins in the surrounding browser/session layer, and require explicit approval for transactions or other irreversible operations.

## Next frontier slices

1. first-class tab/window lifecycle and popup ownership;
2. download and file-transfer verification with explicit filesystem policy;
3. JavaScript dialog detection/handling and dialog-aware task predicates;
4. typed form-submit/navigation outcomes rather than treating submission as generic activation;
5. benchmark adapters that emit BrowserGym/WebArena-style trajectories and task metrics;
6. persistent cross-task semantic memory with origin-scoped invalidation;
7. incremental observation so task loops refresh only browser regions affected by the previous action.
