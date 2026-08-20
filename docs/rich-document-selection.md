# Rich document selection and native insertion

Version 0.39 adds the first rich-document editing foundation on top of the standalone raw-CDP browser runtime: bounded selection/caret observation plus native exact insertion/replacement and keyboard selection commands.

The implementation does not depend on Playwright/Puppeteer/WebDriver locators and does not mutate editor DOM directly.

## Selection observation

`DocumentSelectionObserver` / `snapshotDocumentSelection()` inspect every frame through `SnapshotPageLike`.

Two selection kinds are represented:

- `dom` — ordinary Selection/Range state, including contenteditable and document text selections;
- `text-control` — focused `<input>` / `<textarea>` state using `selectionStart`, `selectionEnd`, and `selectionDirection`.

Each selection reports:

- frame ID;
- collapsed/non-collapsed state;
- forward/backward/none direction;
- bounded selected text;
- structural anchor/focus paths and offsets;
- editing-host identity where present;
- text-control start/end offsets;
- bounded range rectangles and a bounding rectangle in frame-local document coordinates.

Text-node paths use `::text(childNodeIndex)` so anchor/focus identity remains explicit without inventing a CSS selector for a text node.

Collapsed DOM carets outside an editable host are excluded by default; callers can opt into them. Collapsed carets inside contenteditable or text controls remain observable.

## Bounds and raw-CDP evaluation

Browser-side hard caps are fixed inside the serialized frame callback:

- selected text: 32,768 characters;
- individual range rectangles: 128.

Caller-side limits then apply exact UTF-8/array bounds:

- selected text: 16,384 UTF-8 bytes by default;
- range rectangles: 32 by default.

The separation is deliberate. Pure-CDP frame evaluation serializes the callback source, so it cannot close over Node-side option variables. This was caught during review before the browser regression was committed; caller options are now applied only after the bounded browser result returns.

## Exact insertion

`BrowserInput` gains an optional `insertText(text)` capability.

The standalone Chromium `CdpInputAdapter` implements it with:

```text
Input.insertText
```

This is distinct from `typeText()`:

- `typeText()` exercises deterministic key mappings and chords;
- `insertText()` inserts exact text at the current editable selection/caret and is useful for arbitrary Unicode and IME-like text replacement.

No page-side synthetic key/input events are dispatched by the project.

## RichTextController

Every `CdpBrowserAgentEngine` created through the normal factory exposes `richText`.

The controller currently supports:

- `observe()` — bounded selection snapshot;
- `insertText()` — exact insertion/replacement with a caller payload byte cap;
- `selectAll()` — native primary-modifier + A (`Meta` on Darwin, `Control` elsewhere, overrideable);
- `deleteSelection()` — native Backspace over a non-collapsed editable selection.

Editing is fail-closed around a unique editable selection:

- no editable selection -> no dispatch;
- multiple editable selections across frames -> no dispatch;
- insertion capability absent -> no dispatch;
- payload above the configured UTF-8 cap -> no dispatch.

After insertion/deletion, the controller re-observes selection state. `inserted` / `deleted` means the same frame/editing host remained active and the resulting selection collapsed. This is selection-state verification, not a claim that an arbitrary editor's internal document model or formatting state was semantically verified.

## Chromium semantics validated locally

A direct raw-pipe Chromium probe confirmed:

- focusing a contenteditable **before** establishing a DOM range preserves that selection;
- `Input.insertText('δ')` replaces selected `beta` in `alpha beta gamma` with `δ`;
- a backward `<input>` selection with `selectionStart=1`, `selectionEnd=4`, `selectionDirection='backward'` represents anchor offset 4 / focus offset 1;
- `Input.insertText('XYZ')` replaces `bcd` in `abcdef` and collapses the caret after the inserted text.

The repository integration fixture exercises the same behavior through `launchStandaloneBrowserAgent()` and `activeEngine.richText`, then verifies native select-all/delete on the input.

## Capability scope

The current standalone capability profile upgrades `rich-text-editing` from unsupported to **partial**.

That is intentionally not `supported` yet. Missing pieces include:

- formatting-run observation and verified bold/italic/list/etc. commands;
- rich clipboard read/write;
- drag/drop;
- editor-specific document-model verification;
- selection/range task predicates and task-program edit actions;
- cross-frame focused-editing ownership when multiple frames preserve stale selections;
- arbitrary collaborative-editor model synchronization.

These should be added as explicit primitives rather than treating generic typing as full rich-editor automation.
