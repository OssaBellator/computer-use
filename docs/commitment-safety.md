# Commitment safety

Version 0.41 gives the task runtime a bounded **pre-commit + post-commit** safety boundary around page actions that may finalize an external effect.

The goal is not to infer every website's business semantics. The goal is to prevent a deterministic task program from treating a page-side **Place order**, **Confirm transfer**, **Publish**, **Delete account**, or similar action as an ordinary click, and then prevent a weak or stale result signal from causing an irreversible action to be repeated or falsely reported as successful.

## Architecture

`TaskRuntime` still starts from the program's declared `risk`, `requiresApproval`, and `maxRisk` policy. Page-grounded commitment handling is additive; it does not replace static policy.

For `activate` actions, and for `Enter`/`Space` on a focused activation control, the runtime performs bounded pre-dispatch and post-dispatch phases.

### Before input dispatch

1. Resolve the exact semantic target from the current interaction snapshot.
2. Run `detectBrowserCommitment()` on the target label.
3. Strong labels such as `Place order` or `Confirm transfer` become commitments immediately.
4. Ambiguous labels such as `Confirm`, `Submit`, `Continue`, or `Delete` request one bounded structured-document snapshot when that channel exists.
5. Corroborate ambiguous actions against purchase, booking, transfer, subscription, publishing, destructive, security, or process-trigger context in the **same owning frame**.
6. Invoke `TaskRuntimeOptions.approve` before browser input when a commitment is detected, or when available context is too incomplete to rule one out safely.
7. **After approval, perform a fresh bounded result-baseline read immediately before input.** The earlier observation is not reused because the page may have changed while approval was pending.
8. Require that fresh baseline to be result-neutral (`unknown`). A pre-existing confirmation, pending/adverse result, material mismatch, missing result channel, or failed fresh read blocks dispatch before any browser input.

The fresh result-neutral baseline prevents a previous receipt or status banner in the same frame from being recycled as evidence that the new action succeeded.

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
- **mismatch** — a material term visible in the fresh baseline or after dispatch conflicts with the approved pre-commit term.
- **unknown** — no sufficiently explicit result evidence is available.

A non-`unknown` baseline is a **pre-dispatch policy block**, not a post-action result. It means current page state is unsuitable for attributing a future result safely.

`TaskRuntime` exposes distinct terminal run statuses for unresolved side effects after input has actually been dispatched:

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

The ordinary task trace intentionally keeps less data. It records pre-commit status/kind/confidence, result classification, and only the **names** of mismatched material fields. Amounts, counterparties, schedules, and page excerpts are not copied into the trace.

## Bounds

Every commitment phase operates over bounded semantic/document state. None performs an unbounded DOM query.

The contextual, fresh-baseline, and post-commit structured-document reads use fixed budgets:

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

Approval alone is not enough to dispatch a detected commitment when specialized verification is enabled. A fresh, result-neutral, same-frame baseline must be available after approval and immediately before input. If the result channel is unavailable, extraction fails, material terms already conflict, or an explicit result state is already present, the action is `policy-blocked` before dispatch.

After dispatch, missing result evidence is `side-effect-unverified`, not success. A pending result remains `side-effect-pending`; it is never converted into success by timeout.

For compatibility with custom engines or callers that intentionally provide another result-verification layer, `commitmentDetection: 'off'` explicitly restores declaration-only pre-commit gating, and `commitmentVerification: 'off'` explicitly restores generic action/result behavior. Both are opt-outs, not the standalone defaults.

## Capability status

The current standalone profile is `standalone-chromium-0.41`.

`commitment-detection`, `external-side-effect-verification`, and `process-trigger-verification` remain **partial**. The runtime now has first-class bounded mechanics for approval-bound fresh-baseline checks, result classification, and duplicate-side-effect prevention, but provider-specific receipt schemas, durable transaction/process identifiers, redirects across provider domains, and arbitrary keyboard/form submission semantics are not yet complete enough to claim full support.

The next transaction-safety refinement should bind durable provider/result identifiers where available and distinguish expected result identity across cross-page or multi-provider handoffs without weakening the current fail-closed fresh-baseline boundary.
