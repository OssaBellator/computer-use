# Native select option actions

Native `<select>` controls now expose an explicit `select` semantic capability and can be changed through a bounded `select-option` task action. The implementation is designed to avoid copying a page's option list into agent state.

## Static task action

```ts
{
  id: 'choose-country',
  kind: 'select-option',
  target: { role: 'select', name: 'Country' },
  option: { input: 'country' },
  by: 'label',
  next: 'check-country',
  onFailure: 'failed',
}
```

`option` may be a literal program string or a declared trusted task input. `by` is fixed by the compiled program and may be only `label` or `value`. Page content cannot invent the option text or change the matching mode/control-flow edge.

## Privacy boundary

The browser-agent first resolves the semantic select target. Ambiguous or missing targets fail before the requested option string reaches CDP.

`CdpSelectController` then:

1. creates an isolated execution world in the target frame;
2. resolves the exact stable `backendNodeId` into that world;
3. matches the desired string against native option `label` or `value` inside Chromium;
4. returns only a coarse status and selected option index.

The page's option labels/values are never exported as an array, retained by the controller, or copied into task traces. Protocol errors are also collapsed to `protocol-error` rather than returning page exception prose.

## Matching and failure behavior

Matching is exact. The controller fails closed for:

- a missing/unstable backend-node identity;
- a non-select or disabled control;
- `multiple` selects (not yet supported by this single-option primitive);
- no matching option;
- multiple matching options;
- a disabled matching option; or
- protocol/verification failure.

Ambiguous option labels are deliberately rejected rather than silently choosing the first one. Callers that need stable disambiguation can match by an exact option `value` instead.

## Events and verification

For a new choice, the controller sets `selectedIndex`, dispatches bubbling native `input` and `change` events, and checks the selected index after synchronous page handlers have run. It then performs a second independent `Runtime.callFunctionOn` read requiring:

- the object is still a native `HTMLSelectElement`;
- it is still connected;
- it is still single-select; and
- its selected index is still the expected index.

If a page handler immediately reverts the choice, the result is `unverified`.

An already-selected exact match is also independently verified and returns `already-selected`. The task runtime treats both `selected` and `already-selected` as successful verified outcomes.

## Semantic perception

Native selects receive the `select` capability in DOM snapshots. Native `<label for="...">` associations for selects and textareas are also included in semantic naming, in addition to existing ARIA naming.

## Multi-page and risk behavior

`select-option` is an ordinary `interaction` action, so existing task risk/approval policy applies. `MultiPageTaskEngine` delegates it to the active semantic page and fails closed with `invalid-target` when no page is selected.

## Regression coverage

Unit regressions cover isolated-world/backend-node routing, result redaction, not-found/ambiguous/disabled/multiple outcomes, post-event reversion, already-selected verification, invalid targets, trusted-input task forwarding, trace redaction, missing-controller recovery, matching-mode validation, and multi-page delegation.

The Chromium regression discovers a real labeled native select through the pure-CDP semantic observer, verifies its `select` capability, changes it to `Banana`, asserts the semantic value becomes `b`, and confirms the page receives exactly one `input` and one `change` event. A direct protocol probe also verifies the isolated-world mutation and second-read behavior in this environment.
