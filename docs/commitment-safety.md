# Commitment safety

Version 0.41 gives the task runtime a bounded **pre-commit + post-commit** safety boundary around page actions that may finalize an external effect.

The goal is not to infer every website's business semantics. The goal is to prevent a deterministic task program from treating a page-side **Place order**, **Confirm transfer**, **Publish**, **Delete account**, or similar action as an ordinary click, and then prevent a weak action verifier from causing that irreversible action to be retried automatically.

## Architecture

`TaskRuntime` still starts from the program's declared `risk`, `requiresApproval`, and `maxRisk` policy. Page-grounded commitment handling is additive; it does not replace static policy.

For `activate` actions, and for `Enter`/`Space` on a focused activation control, the runtime performs two bounded phases.

### Before input dispatch

1. Resolve the exact semantic target from the current interaction snapshot.
2. Run `detectBrowserCommitment()` on the target label.
3. Strong labels such as `Place order` or `Confirm transfer` become commitments immediately.
4. Ambiguous labels such as `Confirm`, `Submit`, `Continue`, or `Delete` request one bounded structured-document snapshot when that channel exists.
5. Corroborate ambiguous actions against purchase, booking, transfer, subscription, publishing, destructive, security, or process-trigger context in the **same owning frame**.
6. Invoke `TaskRuntimeOptions.approve` before browser input when a commitment is detected, or when available context is too incomplete to rule one out safely.

### After approved input dispatch

1. Re-read bounded structured document state from the approved target's owning frame.
2. Poll briefly without redispatching input so a transient result can settle.
3. Require explicit outcome language for the approved commitment kind; navigation, target disappearance, or generic DOM change alone never proves success.
4. Classify the result as `confirmed`, `pending`, `declined`, `canceled`, `mismatch`, or `unknown`.
5. Compare explicitly visible material terms against the approved summary when both sides provide them: amount, currency, counterparty, schedule, and recurrence.
6. Advance the task only for `confirmed`. Every other post-commit result terminates the run without following the commit step's `onFailure` edge.

This makes retry safety explicit. Once a possibly irreversible action has been dispatched, a generic verifier failure is not permission to click the same control again.

## Strong versus ambiguous targets

Strong labels can gate from the semantic target alone. Examples include:

- `Place order`, `Buy now`, `Pay now`, `Confirm purchase`
- `Confirm booking`, `Confirm reservation`
- `Confirm transfer`, `Send money`, `Pay bill`
- `Subscribe`, `Start free trial`
- `Publish`, `Make public`
- `Delete account`, `Permanently delete`
- `Change password`, `Remove passkey`
- `Deploy`, `Run workflow`

Generic labels are not automatically declared commitments. `Submit` on a profile form, for example, should not become a financial action. Generic labels therefore request corroborating document context when the engine can provide it.

Corroborating signals are deliberately conservative. Examples include `Order total`, `You will be charged`, `Transfer amount`, `Recipient`, `Booking summary`, `Renews`, `Will be published`, `Cannot be undone`, and `Production deployment`.

Phrase matching is word-bounded. For example, `Unpublished` does not satisfy a `published` result check.

## Post-commit result semantics

The specialized verifier recognizes explicit result families for the detected commitment kind.

- **confirmed** — explicit success/receipt language such as an order confirmation, completed transfer, confirmed booking, published item, completed deletion/security change, or completed process.
- **pending** — explicit processing/queued/pending state. The verifier polls briefly in case it settles, then returns pending if it remains unresolved.
- **declined** — explicit declined/failed result.
- **canceled** — explicit canceled/cancelled result.
- **mismatch** — a material term visible after dispatch conflicts with the approved pre-commit term.
- **unknown** — no sufficiently explicit result evidence is available.

`TaskRuntime` exposes distinct terminal run statuses for unresolved side effects:

- `side-effect-pending`
- `side-effect-declined`
- `side-effect-canceled`
- `side-effect-mismatch`
- `side-effect-unverified`

None of those statuses traverse `onFailure` from the commitment action. This avoids accidental duplicate side effects.

A post-commit `confirmed` result is stronger evidence than the generic action verifier. If browser input was dispatched and the generic click verifier is weak or returns `unverified`, an explicit matching receipt can still allow the task to advance. Conversely, a generic action result of `verified` cannot override a pending, declined, canceled, mismatched, or unknown commitment result.

## Structured approval and verification context

`TaskApprovalContext.commitment` can contain a bounded pre-commit summary:

- commitment status and confidence;
- kind and commitment class;
- target identity/role/label;
- visible amount/currency when recognized;
- explicitly labeled merchant/payee/recipient/provider when recognized;
- explicitly labeled schedule/date when recognized;
- recurring/unknown recurrence;
- irreversible/security-sensitive flags;
- bounded evidence codes rather than raw document excerpts.

`TaskRuntimeOptions.onCommitmentVerification` is the explicit channel for the detailed post-commit result, including observed material values.

The ordinary task trace intentionally keeps less data. It records pre-commit status/kind/confidence, post-commit status, and only the **names** of mismatched material fields. Amounts, counterparties, schedules, and page excerpts are not copied into the trace.

## Bounds

Both phases operate over bounded semantic/document state. Neither performs an unbounded DOM query.

The pre-commit and post-commit structured-document reads use fixed budgets:

- at most 128 document blocks;
- at most 32 KiB of retained document text fields;
- at most 2 KiB per block field;
- maximum structural depth 64;
- hidden content excluded;
- offscreen rendered content allowed.

Post-commit verification defaults to at most eight document polls with a 75 ms interval. Callers can lower those bounds through `commitmentVerificationMaxPolls` and `commitmentVerificationPollIntervalMs`.

## Fail-closed behavior

If a strong commitment label is present, missing document context does not remove the approval requirement.

If an ambiguous commitment needs contextual reading and the runtime has a structured document channel, extraction failure or incomplete context is treated as uncertainty rather than proof that the action is safe.

After an approved detected commitment is dispatched, missing result evidence is `side-effect-unverified`, not success. A pending result remains `side-effect-pending`; it is never converted into success by timeout.

For compatibility with custom engines, `commitmentDetection: 'off'` explicitly restores declaration-only pre-commit gating, and `commitmentVerification: 'off'` explicitly restores generic post-action behavior. Both are opt-outs, not the standalone defaults.

## Capability status

The current standalone profile is `standalone-chromium-0.41`.

`commitment-detection`, `external-side-effect-verification`, and `process-trigger-verification` remain **partial**. The runtime now has first-class bounded mechanics for approval-bound result classification and duplicate-side-effect prevention, but provider-specific receipt schemas, durable transaction/process identifiers, redirects across provider domains, and arbitrary keyboard/form submission semantics are not yet complete enough to claim full support.

The next transaction-safety refinement should bind durable provider/result identifiers where available and distinguish expected result identity across cross-page or multi-provider handoffs without weakening the current fail-closed boundary.
