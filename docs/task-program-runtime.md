# Plan-then-execute task runtime

The interaction engine is deliberately strong at **grounding and execution**: it resolves semantic targets, plans across keyboard/pointer/scroll modalities, dispatches browser input, observes the result, and replans when the browser diverges.

The task runtime adds the layer above that: a bounded, typed control-flow graph for multi-step browser work.

## Why this shape

Long-horizon browser agents fail for two recurring reasons:

1. the controller can keep inventing new actions after every page observation, which makes recovery hard to audit and lets untrusted page content influence control flow; and
2. retries and recovery loops often lack explicit budgets or semantic progress checks.

`TaskProgram` addresses both. A program is compiled **before execution**. Runtime browser state may satisfy a predicate or choose between predeclared branches, but it cannot create new actions, selectors, typed text, or destinations.

The runtime is intentionally model-agnostic: an LLM, rules engine, planner, or human can produce a `TaskProgram`, but execution is deterministic once the program and trusted inputs are fixed.

## Core guarantees

- **Static action graph.** `activate` and `type` actions, branch destinations, recovery edges, and completion conditions are declared before execution.
- **Trusted text flow.** Text can come only from literals in the program or named task inputs. Browser-derived text is not accepted as an action payload.
- **Fail-closed targeting.** Semantic actions require unambiguous targets by default.
- **Observed success.** Action steps advance only when `InteractionEngine` reports `verified` browser evidence.
- **Bounded recovery.** Global step budgets, per-step visit budgets, and semantic no-progress detection stop runaway loops.
- **Declared side-effect policy.** Steps marked `external-side-effect` are blocked by default unless the caller raises the risk budget or supplies an approval callback.
- **Auditable traces.** Trace entries record step IDs, outcomes, target IDs, action status, and compact browser-state fingerprints without logging typed task inputs or page text.
- **Fixed recovery paths.** Failures may follow only the `onFailure` / `onTimeout` edges already present in the program.

## Example

```ts
import {
  TaskRuntime,
  type TaskProgram,
} from './src/index.js';

const program: TaskProgram = {
  version: 1,
  name: 'update-profile',
  entry: 'type-name',
  inputs: ['displayName'],
  steps: [
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

const runtime = new TaskRuntime(engine);
const result = await runtime.run(
  program,
  { displayName: 'Ada' },
  {
    approve: async ({ risk, stepId }) => {
      // Connect this to your product's explicit approval UI/policy layer.
      return risk === 'external-side-effect' && stepId === 'save';
    },
  },
);
```

## Step kinds

- `activate`: acquire and semantically activate a target.
- `type`: acquire an editable target and type literal/trusted-input text.
- `assert`: require a browser predicate or route to a fixed recovery edge.
- `branch`: choose one of two predeclared destinations from observed browser state.
- `wait`: poll a predicate with a bounded observation budget.
- `complete`: terminate successfully, optionally behind a final browser-state condition.
- `fail`: terminate explicitly as a failed task.

Predicates compose with `all`, `any`, and `not`, and can test target existence or semantic node state such as focus, disabled/expanded/checked/selected/pressed state and input value.

## Security boundary

This runtime does not make arbitrary autonomous browsing safe by itself. It creates a narrower and inspectable execution boundary:

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
          +---- browser state may satisfy predicates
          +---- browser state may choose declared branches
          X---- browser state cannot synthesize actions
          |
          v
  InteractionEngine
          |
          v
 verified browser effects
```

For higher-risk deployments, keep credentials and secrets outside browser-readable state, restrict allowed origins in the surrounding browser/session layer, and require explicit approval for transactions or other irreversible operations.

## Next frontier slices

1. task-program compilation from higher-level typed website operations rather than raw browser actions;
2. first-class navigation, tab/window, download, dialog, and form-submission verification;
3. benchmark adapters that emit BrowserGym/WebArena-style trajectories and task metrics;
4. persistent cross-task semantic memory with origin-scoped invalidation;
5. incremental observation so task loops refresh only browser regions affected by the previous action.
