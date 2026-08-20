# Plan-then-execute task runtime

The interaction engine is deliberately strong at **grounding and execution**: it resolves semantic targets, plans across keyboard/pointer/scroll modalities, dispatches browser input, observes the result, and replans when the browser diverges.

The task runtime adds the layer above that: a bounded, typed control-flow graph for multi-step browser work, including browser navigation/state predicates, declared side-effect policy, and a page-grounded commitment gate immediately before commit-capable actions.

## Why this shape

Long-horizon browser agents fail for recurring reasons:

1. the controller can keep inventing actions after every page observation, making recovery hard to audit and allowing untrusted page content to influence control flow;
2. retries and recovery loops often lack explicit budgets or semantic progress checks; and
3. a program author can accidentally describe a high-consequence page action as an ordinary `activate`, even though the resolved browser control says **Place order**, **Publish**, **Delete account**, or similar.

`TaskProgram` addresses the first two structurally. A program is compiled **before execution**. Runtime browser state may satisfy a predicate or choose between predeclared branches, but it cannot create new actions, selectors, typed text, or destinations.

Version 0.40 addresses the third conservatively: `TaskRuntime` can infer a bounded commitment from the exact resolved activation target plus structured document context and require approval before dispatching browser input.

## Core guarantees

- **Static action graph.** Actions, branch destinations, recovery edges, and completion conditions are declared before execution.
- **Trusted data flow.** Typed text and navigation destinations can come only from program literals or named task inputs. Browser-derived text is not accepted as an action payload or destination.
- **Fail-closed targeting.** Semantic actions require unambiguous targets by default.
- **Observed success.** Semantic actions advance only on `verified` evidence. Navigation advances only after CDP reports no protocol error and a new document/URL state reaches the requested readiness level.
- **Navigation identity.** Browser state includes URL, origin, title, document readiness, history length, and `performance.timeOrigin`; the latter prevents an already-complete old document from being mistaken for a completed reload/navigation.
- **Bounded recovery.** Global step budgets, per-step visit budgets, bounded waits, and no-progress detection stop runaway loops.
- **Declared side-effect policy.** Steps marked `external-side-effect` are blocked by default unless the caller raises the risk budget or supplies an approval callback.
- **Dynamic commitment policy.** `activate`, plus Enter/Space on a focused activation control, can be upgraded to a commitment from bounded browser state even when the program did not declare one.
- **Explicit approval for inferred commitments.** Raising `maxRisk` does not silently bypass a page-grounded commitment. Inferred commitments require the approval callback unless `commitmentDetection: 'off'` is explicitly selected.
- **Auditable traces with data minimization.** Trace entries record step IDs, outcomes, target IDs, action status, fingerprints, and only commitment status/kind/confidence. Amount, counterparty, schedule, typed inputs, URLs, and page excerpts are not copied into ordinary traces.
- **Fixed recovery paths.** Failures may follow only `onFailure` / `onTimeout` edges already present in the program.

## CDP browser-agent facade

For Chromium/CDP usage, `createCdpBrowserAgentEngine()` composes semantic interaction, structured document observation, and browser-level navigation/state on the same CDP session:

```ts
import {
  createCdpBrowserAgentEngine,
  TaskRuntime,
  type TaskProgram,
} from './src/index.js';

const engine = createCdpBrowserAgentEngine(page, cdpSession);
const runtime = new TaskRuntime(engine);
```

The standalone `launchStandaloneBrowserAgent()` path provides the same task runtime without requiring Playwright, Puppeteer, Selenium/WebDriver, or an external CDP websocket client.

## Example: declared profile update

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
      next: 'done',
      onFailure: 'failed',
    },
    { id: 'done', kind: 'complete' },
    { id: 'failed', kind: 'fail' },
  ],
};

const result = await runtime.run(program, {
  profileUrl: 'https://example.test/profile',
  displayName: 'Ada',
}, {
  approve: async ({ risk, stepId }) =>
    risk === 'external-side-effect' && stepId === 'save',
});
```

## Example: inferred checkout commitment

The program below does **not** declare a side effect. If the resolved button is named `Confirm` on a page whose bounded document snapshot contains checkout evidence such as `Review your order`, `Order total AUD 25.00`, and `Payment method`, the runtime infers a purchase commitment before activation.

```ts
const checkout: TaskProgram = {
  version: 1,
  entry: 'confirm',
  steps: [
    {
      id: 'confirm',
      kind: 'activate',
      target: { role: 'button', name: 'Confirm' },
      next: 'done',
    },
    { id: 'done', kind: 'complete' },
  ],
};

await runtime.run(checkout, {}, {
  approve: async ({ commitment }) => {
    if (commitment?.kind !== 'purchase') return false;
    return commitment.amount?.currency === 'AUD';
  },
});
```

The approval callback may inspect the bounded commitment summary. The ordinary trace does not receive the amount/counterparty fields.

## Commitment detection behavior

Strong labels such as `Place order`, `Pay now`, `Confirm transfer`, `Publish`, `Change password`, `Delete account`, and `Run workflow` are sufficient to trigger a commitment gate from the semantic target alone.

Generic labels such as `Confirm`, `Submit`, `Continue`, and `Delete` are ambiguous. When `documentContent()` is available, the runtime requests one bounded document snapshot and looks for corroborating transaction/publication/security/process context. If that available document channel fails or is too incomplete to rule out the commitment safely, approval is required rather than treating extraction failure as evidence of safety.

Custom engines that expose no structured document channel retain compatibility for generic ambiguous buttons; the capability is therefore reported as **partial**, not complete. `commitmentDetection: 'off'` explicitly restores declaration-only risk gating.

See [`commitment-safety.md`](commitment-safety.md) for evidence classes, limits, and fail-closed details.

## Step kinds

The runtime supports semantic activation/hover/type/select/upload, keyboard and viewport-scroll actions, navigation/history, page switching/open/close, dialogs, bounded network-idle waits, assertions, branches, waits, completion, and explicit failure.

Predicates compose with `all`, `any`, and `not`. Semantic predicates can test target existence or node state. Browser predicates can test URL/origin/title/readiness/history. Document predicates can test bounded structured content such as headings, paragraphs, links, and tables without pretending non-interactive text is an interactive node.

## Navigation safety boundary

`CdpNavigationController` accepts absolute `http:`, `https:`, `about:`, and `data:` URLs. It rejects schemes such as `javascript:` and does not enable `file:` navigation by default. Navigation destinations remain subject to the same trusted-input rule as typed text.

For deployed agents, add origin policy in the surrounding session layer and keep credentials/secrets outside browser-readable state.

## Local and browser validation

The project intentionally does not rely on GitHub Actions. Run locally:

```bash
npm run typecheck
npm test
npm run test:chromium
```

`test:chromium` uses local deterministic fixtures and does not require internet access. The commitment-safety smoke test creates a synthetic checkout page, proves the unapproved action is blocked before browser input, then approves the same bounded summary and verifies one native browser activation. It does not make a real purchase or contact a merchant.

A separate opt-in live website test remains behind `RUN_LIVE_WEB=1`; it is unrelated to transaction testing.

## Security boundary

```text
user goal / trusted inputs
          |
          v
 planner / compiler
          |
          v
   typed TaskProgram  <------ static policy
          |
          v
      TaskRuntime
          |
          +---- browser state may satisfy declared predicates
          +---- browser state may choose declared branches
          X---- browser state cannot synthesize actions/destinations
          |
          +---- pre-action semantic target
          +---- bounded commitment detector
          +---- explicit approval when required
          |
          +---- semantic actions -> InteractionEngine
          +---- navigation -------> CDP navigation controller
          |
          v
 verified browser effects
```

The dynamic detector is a safety interlock, not authorization to perform financial or identity actions unattended. Higher-risk deployments should impose narrower origin/action policy and stronger approval requirements.

## Next frontier slices

1. bind post-action verification to the pre-commit summary so completed/pending/declined/canceled and changed amount/recipient/terms are first-class;
2. rich clipboard, formatting-run, drag/drop, and editor-specific verification for collaboration/publishing;
3. user-mediated authentication/passkey handoff and permission state;
4. durable long-running task checkpoint/replay;
5. incremental observation and targeted invalidation for lower-latency long-horizon loops.
