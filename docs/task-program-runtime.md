# Plan-then-execute task runtime

The interaction engine is deliberately strong at **grounding and execution**: it resolves semantic targets, plans across keyboard/pointer/scroll modalities, dispatches browser input, observes the result, and replans when the browser diverges.

The task runtime adds the layer above that: a bounded, typed control-flow graph for multi-step browser work, including browser navigation/state predicates, declared side-effect policy, page-grounded commitment approval immediately before commit-capable actions, and retry-safe result verification after approved commitments.

## Why this shape

Long-horizon browser agents fail for recurring reasons:

1. the controller can keep inventing actions after every page observation, making recovery hard to audit and allowing untrusted page content to influence control flow;
2. retries and recovery loops often lack explicit budgets or semantic progress checks;
3. a program author can accidentally describe a high-consequence page action as an ordinary `activate`, even though the resolved browser control says **Place order**, **Publish**, **Delete account**, or similar; and
4. after a high-consequence action is dispatched, weak generic verification can accidentally send control flow through `onFailure` and repeat an action that may already have succeeded remotely.

`TaskProgram` addresses the first two structurally. A program is compiled **before execution**. Runtime browser state may satisfy a predicate or choose between predeclared branches, but it cannot create new actions, selectors, typed text, or destinations.

The commitment boundary addresses the latter two conservatively: `TaskRuntime` can infer a bounded commitment from the exact resolved activation target plus structured document context, require approval before dispatch, and then independently classify the resulting page state before deciding whether the task may advance.

## Core guarantees

- **Static action graph.** Actions, branch destinations, recovery edges, and completion conditions are declared before execution.
- **Trusted data flow.** Typed text and navigation destinations can come only from program literals or named task inputs. Browser-derived text is not accepted as an action payload or destination.
- **Fail-closed targeting.** Semantic actions require unambiguous targets by default.
- **Observed success.** Ordinary semantic actions advance only on their action-specific verified evidence. Approved detected commitments use the specialized commitment-result verifier instead: an explicit matching result may confirm a side effect even when generic click verification is weak, while generic `verified` cannot override pending/declined/canceled/mismatched/unknown commitment state.
- **Navigation identity.** Browser state includes URL, origin, title, document readiness, history length, and `performance.timeOrigin`; the latter prevents an already-complete old document from being mistaken for a completed reload/navigation.
- **Bounded recovery.** Global step budgets, per-step visit budgets, bounded waits, and no-progress detection stop runaway loops.
- **Declared side-effect policy.** Steps marked `external-side-effect` are blocked by default unless the caller raises the risk budget or supplies an approval callback.
- **Dynamic commitment policy.** `activate`, plus Enter/Space on a focused activation control, can be upgraded to a commitment from bounded browser state even when the program did not declare one.
- **Explicit approval for inferred commitments.** Raising `maxRisk` does not silently bypass a page-grounded commitment. Inferred commitments require the approval callback unless `commitmentDetection: 'off'` is explicitly selected.
- **No automatic retry after dispatched commitments.** Post-commit `pending`, `declined`, `canceled`, `mismatch`, and `unknown` results terminate with distinct `side-effect-*` statuses rather than following the commit step's `onFailure` edge.
- **Auditable traces with data minimization.** Trace entries record step IDs, outcomes, target IDs, action status, fingerprints, pre/post commitment classification, and only names of mismatched material fields. Amount, counterparty, schedule, typed inputs, URLs, and page excerpts are not copied into ordinary traces.
- **Fixed recovery paths for ordinary actions.** Ordinary failures may follow only `onFailure` / `onTimeout` edges already present in the program. Dispatched commitments deliberately terminate instead of using those retry-capable edges unless result verification confirmed the commitment and the task advances normally.

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

A declared `external-side-effect` is not automatically a detected page-grounded commitment. Specialized post-commit verification is attached when the resolved browser action is actually classified as a commitment.

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

const result = await runtime.run(checkout, {}, {
  approve: async ({ commitment }) => {
    if (commitment?.kind !== 'purchase') return false;
    return commitment.amount?.currency === 'AUD';
  },
  onCommitmentVerification: async ({ verification }) => {
    // Detailed result terms are available here, not in the ordinary trace.
    console.log(verification.status);
  },
});
```

If the post-action page explicitly confirms the matching purchase, the commitment step advances. If it remains pending, is declined/canceled, exposes conflicting material terms, or provides no explicit result evidence, the runtime returns a distinct `side-effect-*` status and does not execute the commit step's `onFailure` path.

## Commitment detection and verification behavior

Strong labels such as `Place order`, `Pay now`, `Confirm transfer`, `Publish`, `Change password`, `Delete account`, and `Run workflow` are sufficient to trigger a commitment gate from the semantic target alone.

Generic labels such as `Confirm`, `Submit`, `Continue`, and `Delete` are ambiguous. When `documentContent()` is available, the runtime requests one bounded document snapshot and looks for corroborating transaction/publication/security/process context in the target's owning frame. If that available document channel fails or is too incomplete to rule out the commitment safely, approval is required rather than treating extraction failure as evidence of safety.

After approved dispatch, the runtime polls bounded structured-document state in the same owning frame. Terminal result text returns immediately; explicit pending state may poll briefly in case it settles. Generic navigation, target disappearance, or arbitrary DOM mutation never proves commitment success by itself.

Result statuses are:

- `confirmed`
- `pending`
- `declined`
- `canceled`
- `mismatch`
- `unknown`

Material comparisons currently cover explicitly visible amount, currency, counterparty, schedule, and recurrence when both the approved summary and result expose comparable values.

Custom engines that expose no structured document channel can still use pre-commit strong-label gating, but an approved detected commitment without post-action result evidence terminates `side-effect-unverified` by default. `commitmentDetection: 'off'` and `commitmentVerification: 'off'` are explicit compatibility opt-outs.

See [`commitment-safety.md`](commitment-safety.md) for evidence classes, limits, trace privacy, and fail-closed details.

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

`test:chromium` uses local deterministic fixtures and does not require internet access. The commitment-safety smoke test creates a synthetic checkout page, proves the unapproved action is blocked before browser input, then approves the same bounded summary, verifies exactly one native browser activation, and independently confirms the synthetic result before task completion. It does not make a real purchase or contact a merchant.

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
          +---- bounded post-action document polling
          +---- commitment-bound result verifier
          X---- unresolved commitment cannot auto-retry via onFailure
          |
          v
 verified browser effects
```

The commitment boundary is a safety interlock, not authorization to perform financial or identity actions unattended. Higher-risk deployments should impose narrower origin/action policy and stronger approval requirements.

## Next frontier slices

1. durable provider/result identity across redirects, popups, and multi-provider commitment handoffs;
2. rich clipboard, formatting-run, drag/drop, and editor-specific verification for collaboration/publishing;
3. user-mediated authentication/passkey handoff and permission state;
4. durable long-running task checkpoint/replay;
5. incremental observation and targeted invalidation for lower-latency long-horizon loops.
