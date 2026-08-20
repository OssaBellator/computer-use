# Structured document-content observation

The interactive semantic snapshot is optimized for controls: buttons, inputs, composites, scroll containers, focus, and action state. Research and reading tasks need a different view of the page: bounded, ordered, non-interactive document content.

`src/browser/documentContent.ts` adds that reading model without Playwright/Puppeteer locator APIs. It operates on the same `SnapshotPageLike` / frame abstraction used by the pure-CDP observer and is exposed through `CdpInteractionObserver.documentContent()`.

## Returned content

The flattened `DocumentContentSnapshot` contains per-frame metadata plus typed blocks in deterministic frame/DOM order.

Current block kinds are:

- headings with level
- paragraphs
- list items
- definition terms/descriptions
- table captions and cells
- preformatted/standalone code
- quotations
- figure captions
- links with resolved URLs
- images with alt text
- document landmarks with role/name

Frame metadata includes bounded title, document language, description metadata, and canonical URL when present.

Each block also records:

- frame-scoped structural identity
- tag name and composed-tree depth
- frame-local document rectangle when available
- whether it participates in rendered layout
- whether it currently intersects that frame's viewport
- whether any of its fields were truncated

Offscreen rendered content is included by default. This matters for reading long articles: viewport visibility is not equivalent to document relevance. `viewportOnly: true` is available when a caller explicitly wants the current visual window.

Hidden/non-rendered content is excluded by default and can be requested with `includeHidden: true`.

## Frames and open Shadow DOM

The host walks every frame exposed by `SnapshotPageLike`; the CDP observer refreshes its pure-CDP runtime page before document extraction.

Within a frame, extraction traverses the composed structure of open Shadow DOM. For slots, assigned elements are followed with `flatten: true`; fallback slot children are used when there are no assignments. A visited-element set prevents duplicated assigned nodes.

Closed shadow roots remain inaccessible to ordinary page JavaScript and are not claimed as covered by this slice.

## Bounds

There are two independent layers of limits.

Browser-side hard caps prevent an adversarial or simply enormous page from returning an unbounded evaluation result:

- 20,000 visited elements per frame
- 2,000 emitted blocks per frame
- 250,000 retained textual characters per frame
- 12,000 characters per ordinary textual field
- 4,096 characters for URLs
- 256 characters for roles
- 8,192 characters for metadata fields
- composed-tree depth 128

Text is accumulated through bounded text-node walking rather than calling `body.innerText` or materializing an unlimited subtree `textContent` string.

Caller-side limits are stricter by default and apply across all frames:

- `maxBlocks`: 500
- `maxTextBytes`: 262,144 UTF-8 bytes
- `maxTextBytesPerBlock`: 8,192 UTF-8 bytes per returned textual field
- `maxDepth`: 64

UTF-8 truncation never splits a code point. The snapshot-level `truncated` flag is set for browser-side or caller-side shortening/omission.

A failed/detached frame is recorded in `frameErrors` while other frames remain usable. If the global caller budget is already exhausted, later frames are not evaluated at all.

## Example

```ts
const content = await agent.activeEngine?.interaction.observer.documentContent?.({
  maxBlocks: 300,
  maxTextBytes: 128 * 1024,
});

for (const block of content?.blocks ?? []) {
  if (block.kind === 'heading') {
    console.log(block.level, block.text);
  }
}
```

The structured reader is observation only. It does not alter the page or synthesize events.

## Local browser validation

The Chromium regression is stacked on the standalone raw-CDP runtime. Its fixture covers:

- title/language/description/canonical metadata
- heading and paragraph text
- relative-link resolution through an explicit base URL
- list items
- table caption/header/cell content
- preformatted code
- image alt text
- open-shadow heading and slotted light-DOM paragraph
- an offscreen but rendered paragraph
- a `display:none` paragraph excluded by default
- `viewportOnly` filtering

A separate raw remote-debugging-pipe probe was used while developing the fixture and caught two test-design errors before commit: relative URLs on `about:blank` needed an explicit base URL, and replacing `head.innerHTML` after assigning `document.title` removes the generated title node. Both cases are pinned correctly in the repository smoke fixture.

## What this is not yet

This is a **reading** model, not a rich-document editing model. It does not yet expose:

- selection/range state
- editable runs and formatting marks
- caret geometry
- contenteditable mutation primitives
- clipboard-rich fragments
- drag/drop document operations
- table structural relationships beyond ordered caption/cell blocks
- article/main-content ranking or boilerplate suppression
- incremental document diffs/targeted refresh

Those remain separate capabilities so research/reading progress does not get conflated with editor automation.
