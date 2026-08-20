# Rich document formatting

This slice adds bounded, framework-independent formatting observation for native rich-document selections and a small set of verified native formatting operations. It builds on the existing document-selection and `RichTextController` foundations rather than introducing editor-specific APIs.

## Observation model

`DocumentFormattingObserver` evaluates each browser frame independently and returns only states whose current DOM selection is contained by one focused editing host. Text controls are not rich-formatting hosts. Descendants made explicitly non-editable with `contenteditable="false"` are not treated as part of an ancestor editing host. Selections spanning editing hosts, multiple ranges, unfocused hosts, or otherwise unobservable state are reported as frame errors instead of being guessed.

Each state includes a bounded list of coalesced formatting runs and distinct block contexts. Runs contain no selected text. They describe bold, italic, underline, strike, semantic/generic-monospace code state (including the CSS `ui-monospace` generic family), optional bounded link URL, paragraph/heading context, and ordered/unordered list context. Link URLs have an independent UTF-8 byte budget. Browser-side traversal, selected-node, run, block, path, and URL limits keep observation bounded even when a host is very large.

For non-collapsed ranges, text traversal begins at the range common ancestor rather than scanning from the start of the entire editing host. This keeps a small selection late in a large editor observable without spending the traversal budget on unrelated preceding content. The fixed browser-side traversal and selected-node caps still fail closed for genuinely broad selections. Each selected text node must also resolve back to the same effective editing host; a range that crosses an explicitly non-editable island or a separately re-enabled nested host becomes incomplete/unobservable instead of being treated as one uniformly editable range.

Inline summaries use four values:

- `on`: every observed relevant run has the format.
- `off`: every observed relevant run lacks the format.
- `mixed`: both formatted and unformatted runs are present.
- `unknown`: the format cannot be established within the observation budget.

Link presence uses that same inline summary. URL identity is reported separately as `linkTarget`: `none`, `uniform`, `mixed`, or `unknown`. A `uniform` target carries one bounded URL. Different link destinations are therefore explicit even when every selected run is linked. Truncated browser-side URLs cannot be claimed as a uniform target and are reported as `unknown`; host-side URL byte truncation preserves an already-established target state while marking the returned URL truncated.

`complete` indicates whether all relevant selected text nodes were inspected within one effective editing host. A certainly mixed value can still be reported when a traversal budget is exceeded, but uniform values become `unknown` when completeness is lost. Cross-editability boundaries likewise make the state incomplete, so native formatting actions fail closed before input dispatch. `runsTruncated`, `blocksTruncated`, and the snapshot `truncated` flag report result-shaping limits separately.

Collapsed carets use browser-observable editing command state for bold, italic, underline, and strike where Chromium exposes it, with DOM/computed-style context as a fallback. Code/monospace and link presence remain structural observations.

## Native formatting operations

`RichTextController` accepts an optional `DocumentFormattingObserver` and exposes `setBold`, `setItalic`, `setUnderline`, and the generic `setInlineFormat`. The standalone CDP browser-agent wiring supplies that observer.

The controller dispatches only standard browser keyboard editing commands through `BrowserInput` (`Control`/`Meta` plus `B`, `I`, or `U`). It does not mutate editor DOM, call site-specific editor APIs, or synthesize page events. Strike, code, and link are observation-only in this slice because they do not have a sufficiently universal native keyboard operation. Runtime format names and primary shortcut modifiers are validated before dispatch so unsupported JavaScript values cannot fall through to a different or bare key command.

A format operation first verifies one editable DOM selection, one formatting state, the same frame/editing-host identity, a complete observable summary, and a non-mixed starting value. Mixed or unknown selections fail closed rather than relying on browser/editor-dependent toggle semantics. After native input, the controller re-observes both selection and formatting state. It requires the selection to remain collapsed/non-collapsed as before and, when selected text is fully observed, requires that text to remain unchanged. `formatted` is returned only when the requested state is actually observed; otherwise the result is `unverified` or a more specific fail-closed status.

## Scope and limitations

The feature targets browser-native `contenteditable` and `designMode` behavior. Text inputs, textareas, explicitly non-editable islands, ranges crossing editability boundaries, multi-range selections, cross-host selections, and editors that hide or override native state are unsupported or unverified. There are no ProseMirror, Slate, Quill, clipboard, drag/drop, stealth, CAPTCHA, or anti-bot integrations.

Synthetic Chromium coverage uses local document fixtures only. Fixture setup may use runtime evaluation to create/select local DOM, while formatting interaction itself is sent through the existing native browser input path and verified by fresh document observation.
