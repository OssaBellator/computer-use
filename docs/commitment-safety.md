# Commitment safety

Version 0.40 adds a bounded, heuristic commitment detector immediately before browser actions that can plausibly finalize an external effect.

The goal is not to infer every website's business semantics. The goal is to stop a deterministic task program from treating a page-side **Place order**, **Confirm transfer**, **Publish**, **Delete account**, or similar action as an ordinary low-risk click merely because the program author forgot to label the step as an external side effect.

## Architecture

`TaskRuntime` still starts from the program's declared `risk`, `requiresApproval`, and `maxRisk` policy. Commitment detection is an additional page-grounded gate; it does not replace static policy.

For `activate` actions, and for `Enter`/`Space` on a focused activation control, the runtime:

1. resolves the exact semantic target from the current interaction snapshot;
2. runs `detectBrowserCommitment()` on the target label;
3. if the label is strong (for example `Place order` or `Confirm transfer`), treats it as a commitment immediately;
4. if the label is ambiguous (for example `Confirm`, `Submit`, `Continue`, or `Delete`), requests one bounded structured-document snapshot when the engine exposes that channel;
5. corroborates the ambiguous action against bounded purchase, booking, transfer, subscription, publishing, destructive, security, or process-trigger context;
6. invokes `TaskRuntimeOptions.approve` before input dispatch when a commitment is detected, or when an available document channel is too incomplete to rule one out safely.

The standalone raw-CDP engine exposes structured document observation, so ambiguous actions can use the contextual path without requiring Playwright/Puppeteer/WebDriver locators.

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

## Structured approval context

`TaskApprovalContext.commitment` can contain a bounded summary:

- commitment status and confidence;
- kind and commitment class;
- target identity/role/label;
- visible amount/currency when recognized;
- explicitly labeled merchant/payee/recipient/provider when recognized;
- explicitly labeled schedule/date when recognized;
- recurring/unknown recurrence;
- irreversible/security-sensitive flags;
- bounded evidence codes rather than raw document excerpts.

The ordinary task trace intentionally keeps less data. It records only commitment status, kind, and confidence. Amount, counterparty, schedule, and page excerpts are not copied into the trace.

## Bounds

The commitment detector operates over already bounded semantic state. It does not perform an unbounded DOM query.

When contextual reading is needed, `TaskRuntime` requests a fixed document budget:

- at most 128 document blocks;
- at most 32 KiB of retained document text fields;
- at most 2 KiB per block field;
- maximum structural depth 64;
- hidden content excluded;
- offscreen rendered content allowed.

The detector applies its own caps to inspected blocks, evidence items, and returned scalar fields.

## Fail-closed behavior

If a strong commitment label is present, missing document context does not remove the approval requirement.

If an ambiguous commitment needs contextual reading and the runtime has a structured document channel, extraction failure or incomplete context is treated as uncertainty that requires approval instead of as proof that the action is safe.

For compatibility with non-standalone/custom engines that do not expose any structured document channel, a generic ambiguous label by itself is not upgraded to a commitment. This is one reason `commitment-detection` remains **partial**, not fully supported, in the capability model.

`commitmentDetection: 'off'` explicitly disables the dynamic gate and restores declaration-only risk handling. This is an opt-out, not the default.

## Capability status

The current standalone profile is `standalone-chromium-0.40`.

`commitment-detection` is **partial**. As a result, the broad `transactions-commerce` capability target becomes mechanically runnable (no required capability is completely unsupported), but it is still not fully supported. Site-specific commitment semantics remain heuristic, and `external-side-effect-verification` is still partial.

The next safety slice should strengthen post-action verification: confirm that the intended order/booking/transfer/publication/process actually happened, distinguish success from pending/declined/error states, and bind the verification to the pre-commit summary rather than relying only on generic DOM change.
