# Commitment result identity

This layer strengthens the existing post-commit verifier by binding explicit result evidence to the approved browser operation when a page exposes a durable, non-secret identifier.

It does not replace the existing safety chain. The runtime still requires commitment detection, approval, fresh target/material revalidation, a complete neutral result baseline, exactly one input dispatch, and explicit post-dispatch result verification.

## Identity model

`src/browser/commitmentIdentity.ts` extracts a small set of explicitly labelled identifiers for the approved commitment kind, such as order, booking, reservation, transfer, subscription, publication, deployment, workflow-run, confirmation, and reference identifiers.

The snapshot is deliberately narrow:

- at most 128 rendered structured-document blocks are examined by default;
- at most 8 unique identifiers are retained;
- each identifier is bounded to at most 96 UTF-8 bytes;
- arbitrary URLs, titles, page excerpts, cookies, tokens, card numbers, and account numbers are not retained;
- all-numeric values of 12 or more digits, compact/spaced IBAN-shaped values, common credential-shaped token prefixes, JWT-shaped values, and URL-shaped values are rejected even when a page gives them a generic reference label;
- short ordinary identifiers are not rejected merely for sharing a prefix with a credential family (for example, `SK-42` remains a valid order reference);
- whitespace-only labels require an ID-shaped value, preventing prose such as `Order number will be assigned` from being treated as an identifier.

The browser-side provider signal is the page origin. Opaque `null` origins are treated as unknown, and full URLs are not part of the identity snapshot. Top-level browser state is never attributed to a child-frame commitment when no frame-local browser-state channel exists.

## Relations

Post-dispatch identity comparison produces one of four relations:

- `matched-expected`: the baseline contained exactly one unique identifier value and the result contains that same value, even if a safe result label changes (for example, `Order reference` to `Confirmation number`);
- `fresh-result-identity`: the baseline contained no identifier and the result exposes a new labelled identifier;
- `conflict`: a unique baseline identifier and the result expose the same identifier category with different values;
- `unbound`: no safe binding can be made.

A baseline containing multiple distinct identifiers is deliberately treated as unbound. The verifier does not guess which historical/order identifier belongs to the approved action.

## Provider/origin binding

A same-origin explicit success phrase can still confirm, but when identity tracking is active it remains medium-confidence unless it is strengthened by a matching or fresh result identity.

A positive result after an origin change is stricter: it requires `matched-expected`. A merely fresh identifier on a different provider is not enough because the agent cannot prove that a newly observed provider result belongs to the operation that was approved.

Adverse and pending outcomes remain observable across an unbound handoff. This asymmetry is intentional: uncertainty must not broaden positive confirmation.

## Redirects

The verification reader brackets each bounded document read with browser-state observations. If `performance.timeOrigin`, URL, or origin changes while the document is being read, that sample is discarded. A stable cross-document redirect may be verified on a later poll, using the original commitment frame identity where it survives navigation.

## Popups and new tabs

Multi-page verification never searches arbitrary tabs for success text.

A popup is eligible only when all of the following are true:

1. the baseline was captured from a known active CDP page target;
2. exactly one additional page target exists after dispatch;
3. the new page's creation sequence is newer than the baseline topology;
4. CDP reports its `openerId` as the approved page target;
5. the popup document remains stable while it is read.

`MultiPageCdpAgent.inspectEngine()` attaches a known page for bounded observation without activating it. This lets result verification inspect an opener-bound popup without changing the user's selected page. If multiple new pages appear, the result channel is ambiguous and none is searched for positive confirmation.

Cross-origin popup confirmation still requires an exact pre-dispatch identifier match.

## Mismatch and retry behavior

An identifier conflict is a commitment verification `mismatch`, even when the page also contains success-looking language. The runtime therefore terminates with its existing side-effect mismatch behavior and does not redispatch the action.

Identity does not weaken the 0.41 no-auto-retry rule. Once the approved action has been dispatched, a pending, declined, canceled, mismatched, or unverified result terminates that runtime path rather than following a generic action retry branch.

## Trace privacy

Detailed identity snapshots, including bounded identifier values, are available only through the explicit commitment verification result/callback.

Ordinary task traces expose only classification enums:

- `commitmentIdentityRelation`
- `commitmentProviderRelation`

They do not contain identifier values, amounts, counterparties, page text, or provider URLs.

## Validation scope

Repository coverage for this layer is intentionally local and synthetic:

- strict TypeScript/Node seams for extraction, identity comparison, verifier policy, and task/popup binding;
- synthetic unit fixtures for matching, fresh, conflicting, ambiguous, unrelated-tab, redirect, opener-bound popup, child-frame, and privacy-filter cases;
- the existing raw-Chromium synthetic checkout fixture carries a fake order reference through the receipt and asserts exactly one activation plus trace privacy.

No real purchase, payment, booking, transfer, publication, account/security change, deletion, deployment, or external process trigger is used for validation.

GitHub Actions remain disabled and are not required by this feature. Windows Tester is not used.

## Current limitations

This is provider-neutral bounded evidence, not provider-specific transaction reconciliation. It does not inspect network payloads, payment-provider APIs, account ledgers, emails, or external receipts. It cannot safely bind a cross-provider result if no unique pre-dispatch identifier survives the handoff.

The capability therefore remains partial: durable identity strengthens explicit post-commit verification when sites expose suitable browser-visible references, while ambiguous or unsupported cases fail closed.
