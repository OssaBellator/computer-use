# Document research ranking and diffing

This layer derives research-oriented structure from an existing `DocumentContentSnapshot`. It does not alter CDP extraction, mutate the snapshot, or replace extractor block identities.

The implementation is split between:

- `src/browser/documentRanking.ts` — deterministic content ranking, boilerplate classification, reading order, section grouping, and table relationships.
- `src/browser/documentDiff.ts` — deterministic snapshot diffing, relocation/content-update hints, and targeted refresh suggestions.

Both modules are framework-independent and have no network, ML, site allowlist, or site-specific selector dependency.

## Ranking model

`rankDocumentContent(snapshot, options)` scores existing source blocks with generic signals already present in the snapshot:

- block kind and text amount;
- sentence-like prose;
- `main` / `article` structural ancestry encoded in extractor DOM-path IDs;
- semantic landmark roles;
- generic `nav`, `aside`, `header`, and `footer` ancestry;
- short repeated chrome text;
- bounded cookie/consent language clusters; and
- bounded recommendation-language clusters.

The result is a `DocumentResearchView` containing:

- `primaryContentBlockIds`, ranked by main-content likelihood;
- `readingOrderBlockIds`, kept in original snapshot/DOM order;
- per-block `assessments` with score, confidence, classification, and bounded reasons;
- hierarchical `sections` based on heading levels and source order;
- interpreted `tables`; and
- `truncated` / `sourceTruncated` signals.

All block references are IDs from the supplied `DocumentContentSnapshot`. Section/table IDs are derived grouping identities only. The source snapshot is never rewritten.

### Boilerplate classes

The deterministic classes are `primary`, `navigation`, `cookie-banner`, `sidebar`, `footer`, `recommendation`, `repeated-chrome`, `metadata`, and `unknown`.

Classification is deliberately conservative. It uses HTML/ARIA semantics, extractor paths, repeated short text, and small lexical clusters rather than domains, CSS classes, or per-site rules. A classification is a research hint, not a browser-action authorization signal.

### Bounds

Every potentially large returned collection has an explicit option and a default bound. The defaults include 512 assessments, 128 primary IDs, 256 reading-order IDs, 64 sections, 16 tables, 64 rows per table, and 512 cells per table. `truncated` becomes true when a source limit or derived-output limit omits detail.

## Table interpretation

The extractor already retains `caption`, `th`, and `td` block kinds/tags plus structural DOM paths. `rankDocumentContent` uses those paths to recover table and row membership without rereading the page.

For each retained cell the derived view reports:

- row and column position in source order;
- whether the cell is a header;
- inferred header role (`row`, `column`, `both`, or `unspecified`);
- earlier row-header block IDs; and
- earlier column-header block IDs.

`thead` headers and explicit ARIA `columnheader` roles feed column associations. Body first-column `th` cells and explicit `rowheader` roles feed row associations.

The raw snapshot does not currently retain `scope`, `headers`, `rowspan`, or `colspan`, so the research layer intentionally does not invent span-aware relationships. Those would require additional extractor structure in a separate change.

## Snapshot diffing

`diffDocumentContent(previous, current, options)` keeps exact identity changes separate from derived guesses:

- `addedBlockIds` and `removedBlockIds` are exact ID-set differences;
- `changedBlocks` compare same-ID source fields and distinguish semantic/content changes from presentation/viewport changes;
- `relocatedBlocks` deterministically pair removed/added blocks only when frame, kind, tag, and normalized semantic payload are identical; and
- `likelyContentUpdates` use the ranking layer to prioritize content-like additions, removals, and same-ID semantic modifications.

Relocation pairing never erases exact added/removed results. It only prevents a structurally moved but semantically identical block from being misreported as a likely content update.

Viewport movement or rectangle changes alone are presentation changes, not semantic content updates.

## Targeted refresh hints

The diff result includes bounded `refreshHints`. These are advisory only; they do not call the extractor or browser.

Hints identify:

- frame-local changed-content regions when source rectangles are available;
- structural-change regions for deterministic relocations;
- whole frames with extraction errors; and
- whole frames/affected regions when extraction was truncated.

Region grouping uses generic semantic ancestors such as `main`, `article`, `section`, and `table`, or the nearest available structural parent. Rectangles remain frame-local document coordinates, matching `DocumentContentBlock.rect`.

A future targeted-refresh implementation can consume these hints without changing the ranking/diff contracts. Any actual refresh should remain a separate CDP/extractor concern.

## Determinism and safety boundaries

The algorithms contain no randomness, current-time inputs, network calls, remote models, browser automation frameworks, anti-bot behavior, or side effects. Equal input snapshots and options produce equal structured output.

This layer is research/content analysis only. It does not modify commitment detection, verification, `TaskRuntime`, or raw CDP extraction.

## Focused tests

Synthetic snapshot coverage lives in:

- `tests/documentRanking.test.ts`
- `tests/documentDiff.test.ts`

The tests cover main-content versus boilerplate ranking, identity preservation, reading/section order, table header associations, deterministic relocation/content diffing, viewport-only changes, refresh hints, and output bounds. No live sites or transaction-like actions are involved.
