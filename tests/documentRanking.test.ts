import test from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentContentBlock, DocumentContentSnapshot } from '../src/browser/documentContent.js';
import { rankDocumentContent } from '../src/browser/documentRanking.js';

function block(
  id: string,
  text: string | undefined,
  overrides: Partial<DocumentContentBlock> = {},
): DocumentContentBlock {
  return {
    id,
    frameId: 'main',
    kind: 'paragraph',
    tagName: 'p',
    depth: 3,
    ...(text !== undefined ? { text } : {}),
    rect: { x: 20, y: 20, width: 680, height: 40 },
    rendered: true,
    inViewport: true,
    truncated: false,
    ...overrides,
  };
}

function snapshot(blocks: DocumentContentBlock[], truncated = false): DocumentContentSnapshot {
  return {
    frames: [{ frameId: 'main', title: 'Synthetic article', includedBlocks: blocks.length, browserExtractionTruncated: false }],
    blocks,
    totalTextBytes: 0,
    truncated,
    frameErrors: [],
  };
}

test('ranks main article content above generic boilerplate while preserving source identities', () => {
  const source = snapshot([
    block('main:body:nth-of-type(1) > nav:nth-of-type(1)', undefined, { kind: 'landmark', tagName: 'nav', role: 'nav' }),
    block('main:body:nth-of-type(1) > nav:nth-of-type(1) > a:nth-of-type(1)', 'Home', { kind: 'link', tagName: 'a', href: 'https://example.test/' }),
    block('main:body:nth-of-type(1) > div:nth-of-type(1) > p:nth-of-type(1)', 'We use cookies. Manage consent preferences or accept all cookies.'),
    block('main:body:nth-of-type(1) > div:nth-of-type(1) > a:nth-of-type(1)', 'Accept all', { kind: 'link', tagName: 'a' }),
    block('main:body:nth-of-type(1) > div:nth-of-type(1) > a:nth-of-type(2)', 'Reject all', { kind: 'link', tagName: 'a' }),
    block('main:body:nth-of-type(1) > main:nth-of-type(1)', undefined, { kind: 'landmark', tagName: 'main', role: 'main' }),
    block('main:body:nth-of-type(1) > main:nth-of-type(1) > article:nth-of-type(1) > h1:nth-of-type(1)', 'A deterministic research layer', { kind: 'heading', tagName: 'h1', level: 1 }),
    block('main:body:nth-of-type(1) > main:nth-of-type(1) > article:nth-of-type(1) > p:nth-of-type(1)', 'This article explains how deterministic structural signals can recover the useful reading surface without replacing the underlying document snapshot. It keeps identities stable and derives ranking separately.'),
    block('main:body:nth-of-type(1) > main:nth-of-type(1) > article:nth-of-type(1) > h2:nth-of-type(1)', 'Associations', { kind: 'heading', tagName: 'h2', level: 2 }),
    block('main:body:nth-of-type(1) > main:nth-of-type(1) > article:nth-of-type(1) > p:nth-of-type(2)', 'Section-aware reading order remains grounded in the original DOM order. The ranking score changes only the derived view, never the source block identifier.'),
    block('main:body:nth-of-type(1) > aside:nth-of-type(1) > section:nth-of-type(1) > h2:nth-of-type(1)', 'Related stories', { kind: 'heading', tagName: 'h2', level: 2 }),
    block('main:body:nth-of-type(1) > aside:nth-of-type(1) > section:nth-of-type(1) > a:nth-of-type(1)', 'Another story', { kind: 'link', tagName: 'a' }),
    block('main:body:nth-of-type(1) > footer:nth-of-type(1)', undefined, { kind: 'landmark', tagName: 'footer', role: 'footer' }),
    block('main:body:nth-of-type(1) > footer:nth-of-type(1) > a:nth-of-type(1)', 'Privacy', { kind: 'link', tagName: 'a' }),
  ]);
  const before = structuredClone(source);
  const view = rankDocumentContent(source);

  assert.deepEqual(source, before);
  assert.ok(view.primaryContentBlockIds.includes('main:body:nth-of-type(1) > main:nth-of-type(1) > article:nth-of-type(1) > p:nth-of-type(1)'));
  assert.ok(view.primaryContentBlockIds.includes('main:body:nth-of-type(1) > main:nth-of-type(1) > article:nth-of-type(1) > h1:nth-of-type(1)'));
  assert.ok(!view.primaryContentBlockIds.some((id) => id.includes('nav:nth-of-type')));
  assert.ok(!view.primaryContentBlockIds.some((id) => id.includes('footer:nth-of-type')));

  const classes = new Map(view.assessments.map((item) => [item.blockId, item.classification]));
  assert.equal(classes.get('main:body:nth-of-type(1) > nav:nth-of-type(1) > a:nth-of-type(1)'), 'navigation');
  assert.equal(classes.get('main:body:nth-of-type(1) > div:nth-of-type(1) > a:nth-of-type(1)'), 'cookie-banner');
  assert.equal(classes.get('main:body:nth-of-type(1) > aside:nth-of-type(1) > section:nth-of-type(1) > a:nth-of-type(1)'), 'recommendation');
  assert.equal(classes.get('main:body:nth-of-type(1) > footer:nth-of-type(1) > a:nth-of-type(1)'), 'footer');

  assert.deepEqual(view.readingOrderBlockIds, [
    'main:body:nth-of-type(1) > main:nth-of-type(1) > article:nth-of-type(1) > h1:nth-of-type(1)',
    'main:body:nth-of-type(1) > main:nth-of-type(1) > article:nth-of-type(1) > p:nth-of-type(1)',
    'main:body:nth-of-type(1) > main:nth-of-type(1) > article:nth-of-type(1) > h2:nth-of-type(1)',
    'main:body:nth-of-type(1) > main:nth-of-type(1) > article:nth-of-type(1) > p:nth-of-type(2)',
  ]);
  const headlineSection = view.sections.find((section) => section.headingBlockId?.endsWith('h1:nth-of-type(1)'));
  const childSection = view.sections.find((section) => section.headingBlockId?.endsWith('h2:nth-of-type(1)'));
  if (!headlineSection) throw new Error('missing headline section');
  assert.equal(childSection?.parentSectionId, headlineSection.sectionId);
  assert.ok(view.primaryContentConfidence > 0.5);
});

test('does not broaden a lexical boilerplate seed across a small main article', () => {
  const seedId = 'main:body:nth-of-type(1) > main:nth-of-type(1) > article:nth-of-type(1) > p:nth-of-type(1)';
  const articleId = 'main:body:nth-of-type(1) > main:nth-of-type(1) > article:nth-of-type(1) > p:nth-of-type(2)';
  const view = rankDocumentContent(snapshot([
    block(seedId, 'The article discusses how sites ask visitors to accept cookies and manage consent preferences.'),
    block(articleId, 'The substantive analysis continues here with enough sentence-like prose to remain primary content.'),
  ]));
  const classes = new Map(view.assessments.map((item) => [item.blockId, item.classification]));

  assert.notEqual(classes.get(articleId), 'cookie-banner');
  assert.ok(view.primaryContentBlockIds.includes(articleId));
});

test('derives table row/column header relationships from existing extractor paths', () => {
  const source = snapshot([
    block('main:body:nth-of-type(1) > main:nth-of-type(1) > table:nth-of-type(1) > caption:nth-of-type(1)', 'Quarterly totals', { kind: 'table-caption', tagName: 'caption' }),
    block('main:body:nth-of-type(1) > main:nth-of-type(1) > table:nth-of-type(1) > thead:nth-of-type(1) > tr:nth-of-type(1) > th:nth-of-type(1)', 'Region', { kind: 'table-cell', tagName: 'th' }),
    block('main:body:nth-of-type(1) > main:nth-of-type(1) > table:nth-of-type(1) > thead:nth-of-type(1) > tr:nth-of-type(1) > th:nth-of-type(2)', 'Revenue', { kind: 'table-cell', tagName: 'th' }),
    block('main:body:nth-of-type(1) > main:nth-of-type(1) > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(1) > th:nth-of-type(1)', 'North', { kind: 'table-cell', tagName: 'th' }),
    block('main:body:nth-of-type(1) > main:nth-of-type(1) > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(1)', '$12', { kind: 'table-cell', tagName: 'td' }),
  ]);

  const table = rankDocumentContent(source).tables[0];
  assert.equal(table.captionBlockId, source.blocks[0].id);
  assert.deepEqual(table.rows.map((row) => row.cellBlockIds.length), [2, 2]);
  const revenue = table.cells.find((cell) => cell.blockId.endsWith('td:nth-of-type(1)'));
  assert.deepEqual(revenue?.rowHeaderBlockIds, [source.blocks[3].id]);
  assert.deepEqual(revenue?.columnHeaderBlockIds, [source.blocks[2].id]);
  assert.equal(revenue?.rowIndex, 1);
  assert.equal(revenue?.columnIndex, 1);
  assert.equal(table.cells.find((cell) => cell.blockId === source.blocks[3].id)?.headerRole, 'row');
  assert.equal(table.cells.find((cell) => cell.blockId === source.blocks[2].id)?.headerRole, 'column');
});

test('bounds derived output without changing source snapshot', () => {
  const source = snapshot(Array.from({ length: 8 }, (_, index) => block(
    `main:body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(${index + 1})`,
    `Paragraph ${index + 1} contains enough sentence-like article content to remain a useful primary candidate.`,
  )));
  const view = rankDocumentContent(source, {
    maxAssessedBlocks: 3,
    maxPrimaryBlocks: 2,
    maxReadingOrderBlocks: 2,
    maxSections: 1,
  });

  assert.equal(view.assessments.length, 3);
  assert.equal(view.primaryContentBlockIds.length, 2);
  assert.equal(view.readingOrderBlockIds.length, 2);
  assert.equal(view.sections.length, 1);
  assert.equal(view.truncated, true);
  assert.equal(source.blocks.length, 8);
});
