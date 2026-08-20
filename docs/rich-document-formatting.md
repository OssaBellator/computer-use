# Rich document formatting

This slice adds bounded, framework-independent formatting observation for native rich-document selections and a small set of verified native formatting operations. It builds on the existing document-selection and `RichTextController` foundations rather than introducing editor-specific APIs.

## Observation model

`DocumentFormattingObserver` evaluates each browser frame independently and returns only states whose current DOM selection is contained by one focused editing host. Text controls are not rich-formatting hosts. Selections spanning editing hosts, multiple ranges, unfocused hosts, or otherwise unobservable state are reported as frame errors instead of being guessed.

Each state includes a bounded list of coalesced formatting runs and distinct block contexts. Runs contain no selected text. They describe bold, italic, underline, strike, semantic/generic-monospace code state, optional bounded link URL, paragraph/heading context, and ordered/unordered list context. Link URLs have an independent UTF-8 byte budget. Browser-side traversal, selected-node, run, block, path, and URL limits keep observation bounded even when a host is very large.

Inline summaries use four values:

- `on`: every observed relevant run has the format.
- `off`: every observed relevant run lacks the format.
- `mixed`: both formatted and unformatted runs are present.
- `unknown`: the format cannot be established within the observation budget.

`complete` indicates whether all relevant selected text nodes were inspected. A certainly mixed value can still be reported when a traversal budget is exceeded, but uniform values become `unknown` when completeness is lost. `runsTruncated`, `blocksTruncated`, and the snapshot `truncated` flag report result-shaping limits separately.

Collapsed carets use browser-observable editing command state for bold, italic, underline, and strike where Chromium exposes it, with DOM/computed-style context as a fallback. Code/monospace and link presence remain structural observations.

## Native formatting operations

`RichTextController` accepts an optional `DocumentFormattingObserver` and exposes `setBold`, `setItalic`, `setUnderline`, and the generic `setInlineFormat`. The standalone CDP browser-agent wiring supplies that observer.

The controller dispatches only standard browser keyboard editing commands through `BrowserInput` (`Control`/`Meta` plus `B`, `I`, or `U`). It does not mutate editor DOM, call site-specific editor APIs, or synthesize page events. Strike, code, and link are observation-only in this slice because they do not have a sufficiently universal native keyboard operation.

A format operation first verifies one editable DOM selection, one formatting state, the same frame/editing-host identity, a complete observable summary, and a non-mixed starting value. Mixed or unknown selections fail closed rather than relying on browser/editor-dependent toggle semantics. After native input, the controller re-observes both selection identity and formatting state. `formatted` is returned only when the requested state is actually observed; otherwise the result is `unverified` or a more specific fail-closed status.

## Scope and limitations

The feature targets browser-native `contenteditable` and `designMode` behavior. Text inputs, textareas, multi-range selections, cross-host selections, and editors that hide or override native state are unsupported or unverified. There are no ProseMirror, Slate, Quill, clipboard, drag/drop, stealth, CAPTCHA, or anti-bot integrations.

Synthetic Chromium coverage uses local document fixtures only. Fixture setup may use runtime evaluation to create/select local DOM, while formatting interaction itself is sent through the existing native browser input path and verified by fresh document observation.
