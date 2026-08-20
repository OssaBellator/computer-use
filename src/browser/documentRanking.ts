import type { DocumentContentBlock, DocumentContentSnapshot } from './documentContent.js';

export type DocumentBoilerplateClassification =
  | 'primary'
  | 'navigation'
  | 'cookie-banner'
  | 'sidebar'
  | 'footer'
  | 'recommendation'
  | 'repeated-chrome'
  | 'metadata'
  | 'unknown';

export interface DocumentRankingOptions {
  /** Maximum per-block assessments returned. Defaults to 512. */
  maxAssessedBlocks?: number;
  /** Maximum likely-primary block IDs returned. Defaults to 128. */
  maxPrimaryBlocks?: number;
  /** Maximum useful reading-order block IDs returned. Defaults to 256. */
  maxReadingOrderBlocks?: number;
  /** Maximum section groups returned. Defaults to 64. */
  maxSections?: number;
  /** Maximum interpreted tables returned. Defaults to 16. */
  maxTables?: number;
  /** Maximum rows retained per interpreted table. Defaults to 64. */
  maxRowsPerTable?: number;
  /** Maximum cells retained per interpreted table. Defaults to 512. */
  maxCellsPerTable?: number;
  /** Minimum content score for a block to be considered primary. Defaults to 0.58. */
  primaryScoreThreshold?: number;
  /** Minimum content score for inclusion in useful reading order. Defaults to 0.42. */
  readingScoreThreshold?: number;
}

export interface DocumentBlockAssessment {
  /** Identity from the source DocumentContentSnapshot. */
  blockId: string;
  frameId: string;
  /** Deterministic main-content likelihood in [0,1]. */
  contentScore: number;
  /** Confidence in the classification in [0,1]. */
  confidence: number;
  classification: DocumentBoilerplateClassification;
  /** Bounded generic signals explaining the score/classification. */
  reasons: string[];
}

export interface DocumentSectionGrouping {
  /** Derived grouping identity; contained block IDs remain source identities. */
  sectionId: string;
  frameId: string;
  headingBlockId?: string;
  headingLevel?: number;
  parentSectionId?: string;
  blockIds: string[];
}

export interface DocumentTableRow {
  rowIndex: number;
  cellBlockIds: string[];
}

export interface DocumentTableCellAssociation {
  /** Identity of the source table-cell block. */
  blockId: string;
  rowIndex: number;
  columnIndex: number;
  isHeader: boolean;
  headerRole?: 'row' | 'column' | 'both' | 'unspecified';
  /** Header cells earlier in the same row. */
  rowHeaderBlockIds: string[];
  /** Header cells in earlier rows at the same column position. */
  columnHeaderBlockIds: string[];
}

export interface DocumentTableInterpretation {
  /** Derived from the source frame ID and extractor DOM path to the table. */
  tableId: string;
  frameId: string;
  captionBlockId?: string;
  rows: DocumentTableRow[];
  cells: DocumentTableCellAssociation[];
  truncated: boolean;
}

export interface DocumentResearchView {
  /** Likely-primary source block identities, ranked by content likelihood. */
  primaryContentBlockIds: string[];
  /** Useful source block identities in original snapshot/DOM order. */
  readingOrderBlockIds: string[];
  /** Overall confidence that the selected primary set represents main content. */
  primaryContentConfidence: number;
  assessments: DocumentBlockAssessment[];
  sections: DocumentSectionGrouping[];
  tables: DocumentTableInterpretation[];
  /** True when source or derived-output limits caused information to be omitted. */
  truncated: boolean;
  sourceTruncated: boolean;
}

interface ScoredBlock {
  block: DocumentContentBlock;
  index: number;
  score: number;
  confidence: number;
  classification: DocumentBoilerplateClassification;
  reasons: string[];
}

interface PathInfo {
  path: string;
  segments: string[];
  tags: string[];
  parentPath: string;
}

interface TableCandidate {
  frameId: string;
  tablePath: string;
  tableId: string;
  captionBlockId?: string;
  rows: Map<string, DocumentContentBlock[]>;
  rowOrder: string[];
}

const READABLE_KINDS = new Set<DocumentContentBlock['kind']>([
  'heading', 'paragraph', 'list-item', 'definition-term', 'definition-description',
  'table-caption', 'table-cell', 'code', 'quote', 'figcaption',
]);

const BASE_SCORE: Record<DocumentContentBlock['kind'], number> = {
  heading: 0.56,
  paragraph: 0.62,
  'list-item': 0.45,
  'definition-term': 0.48,
  'definition-description': 0.52,
  'table-caption': 0.55,
  'table-cell': 0.46,
  code: 0.56,
  quote: 0.59,
  figcaption: 0.40,
  link: 0.17,
  image: 0.10,
  landmark: 0.12,
};

const RECOMMENDATION_PHRASES = [
  'related stories', 'related articles', 'recommended stories', 'recommended articles',
  'recommended for you', 'recommendations', 'you may also like', 'more stories',
  'more articles', 'read next', 'up next', 'also read',
];

const COOKIE_ACTION_PHRASES = [
  'accept all', 'accept cookies', 'reject all', 'reject cookies', 'cookie settings',
  'cookie preferences', 'manage preferences', 'privacy preferences', 'consent preferences',
];

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function unitInterval(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be in [0,1]`);
  return value;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number): number {
  return Math.round(clamp(value) * 1000) / 1000;
}

function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function sourcePath(block: DocumentContentBlock): string {
  const prefix = `${block.frameId}:`;
  return block.id.startsWith(prefix) ? block.id.slice(prefix.length) : block.id;
}

function tagFromSegment(segment: string): string {
  const match = /^([a-z][a-z0-9-]*)/i.exec(segment);
  return match?.[1]?.toLowerCase() ?? '';
}

function pathInfo(block: DocumentContentBlock): PathInfo {
  const path = sourcePath(block);
  const segments = path.split(' > ').filter(Boolean);
  return {
    path,
    segments,
    tags: segments.map(tagFromSegment).filter(Boolean),
    parentPath: segments.slice(0, -1).join(' > '),
  };
}

function hasTag(info: PathInfo, tag: string): boolean {
  return info.tags.includes(tag);
}

function semanticRole(block: DocumentContentBlock): string {
  return normalizeText(block.role || (block.kind === 'landmark' ? block.name : undefined));
}

function combinedText(block: DocumentContentBlock): string {
  return normalizeText([block.text, block.name, block.alt].filter(Boolean).join(' '));
}

function sentenceLike(text: string): boolean {
  return text.length >= 60 && /[.!?](?:\s|$)/.test(text);
}

function clusterPrefixes(
  blocks: readonly DocumentContentBlock[],
  infos: readonly PathInfo[],
  seed: (block: DocumentContentBlock, text: string) => boolean,
): Set<string> {
  const prefixes = new Set<string>();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const info = infos[index];
    if (!seed(block, combinedText(block)) || info.segments.length < 2) continue;
    const parentTag = tagFromSegment(info.segments[info.segments.length - 2] ?? '');
    // Never let a lexical seed classify an entire page/main/article. When a
    // seed is that shallow, classify only the seed block itself.
    const prefix = ['body', 'main', 'article'].includes(parentTag) ? info.path : info.parentPath;
    if (!prefix) continue;
    let members = 0;
    for (let candidate = 0; candidate < infos.length; candidate += 1) {
      if (blocks[candidate].frameId !== block.frameId) continue;
      if (infos[candidate].path === prefix || infos[candidate].path.startsWith(`${prefix} > `)) members += 1;
      if (members > 20) break;
    }
    if (members >= 1 && members <= 20) prefixes.add(`${block.frameId}:${prefix}`);
  }
  return prefixes;
}

function isWithinPrefixes(block: DocumentContentBlock, info: PathInfo, prefixes: ReadonlySet<string>): boolean {
  for (const prefix of prefixes) {
    const framePrefix = `${block.frameId}:`;
    if (!prefix.startsWith(framePrefix)) continue;
    const pathPrefix = prefix.slice(framePrefix.length);
    if (info.path === pathPrefix || info.path.startsWith(`${pathPrefix} > `)) return true;
  }
  return false;
}

function cookieSeed(_block: DocumentContentBlock, text: string): boolean {
  if (!text) return false;
  const mentionsCookie = /\b(cookie|cookies|consent)\b/.test(text);
  const mentionsPrivacy = /\bprivacy\b/.test(text);
  const hasAction = COOKIE_ACTION_PHRASES.some((phrase) => text.includes(phrase)) ||
    /\b(accept|reject|allow|preferences|settings|consent)\b/.test(text);
  return (mentionsCookie && hasAction) || (mentionsPrivacy && /\bpreferences\b/.test(text));
}

function recommendationSeed(block: DocumentContentBlock, text: string): boolean {
  if (!text || (block.kind !== 'heading' && block.kind !== 'landmark' && block.kind !== 'link')) return false;
  return RECOMMENDATION_PHRASES.some((phrase) => text.includes(phrase));
}

function classifyBlock(
  block: DocumentContentBlock,
  info: PathInfo,
  textCounts: ReadonlyMap<string, number>,
  cookiePrefixes: ReadonlySet<string>,
  recommendationPrefixes: ReadonlySet<string>,
): { classification: DocumentBoilerplateClassification; reasons: string[] } {
  const role = semanticRole(block);
  const text = combinedText(block);
  const reasons: string[] = [];

  if (isWithinPrefixes(block, info, cookiePrefixes)) {
    return { classification: 'cookie-banner', reasons: ['cookie/consent language cluster'] };
  }
  if (isWithinPrefixes(block, info, recommendationPrefixes)) {
    return { classification: 'recommendation', reasons: ['recommendation-language cluster'] };
  }
  if (hasTag(info, 'nav') || role === 'navigation' || role === 'search') {
    return { classification: 'navigation', reasons: ['navigation/search landmark'] };
  }
  if (hasTag(info, 'footer') || role === 'contentinfo') {
    return { classification: 'footer', reasons: ['footer/contentinfo landmark'] };
  }
  if (hasTag(info, 'aside') || role === 'complementary') {
    return { classification: 'sidebar', reasons: ['aside/complementary landmark'] };
  }

  const repeated = text.length > 0 && text.length <= 100 && (textCounts.get(text) ?? 0) >= 2;
  const chromeContext = hasTag(info, 'header') || role === 'banner' || block.kind === 'link' || block.kind === 'landmark';
  if (repeated && chromeContext) {
    return { classification: 'repeated-chrome', reasons: ['repeated short chrome text'] };
  }
  if ((hasTag(info, 'header') || role === 'banner') && !hasTag(info, 'article') && !hasTag(info, 'main')) {
    return { classification: 'metadata', reasons: ['page-level header/banner'] };
  }

  return { classification: 'unknown', reasons };
}

function scoreBlock(
  block: DocumentContentBlock,
  info: PathInfo,
  initial: DocumentBoilerplateClassification,
  initialReasons: readonly string[],
): ScoredBlock {
  let score = BASE_SCORE[block.kind];
  const reasons = [...initialReasons];
  const text = combinedText(block);
  const role = semanticRole(block);
  const primaryContext = hasTag(info, 'main') || hasTag(info, 'article') || role === 'main' || role === 'article';

  if (primaryContext) {
    score += 0.19;
    reasons.push('main/article structural context');
  }
  if (text.length >= 120) {
    score += Math.min(0.15, 0.05 + text.length / 4000);
    reasons.push('substantial textual content');
  } else if (text.length > 0 && text.length <= 24 && block.kind !== 'heading') {
    score -= 0.05;
  }
  if (sentenceLike(text)) {
    score += 0.05;
    reasons.push('sentence-like prose');
  }
  if (block.kind === 'heading' && block.level !== undefined && block.level <= 2) score += 0.05;
  if (block.rendered) score += 0.02;
  else score -= 0.25;
  if (block.truncated) score -= 0.04;

  if (initial === 'navigation' || initial === 'cookie-banner' || initial === 'footer' ||
      initial === 'recommendation' || initial === 'repeated-chrome') score -= 0.58;
  else if (initial === 'sidebar') score -= 0.36;
  else if (initial === 'metadata') score -= 0.28;

  if (block.kind === 'link' || block.kind === 'image' || block.kind === 'landmark') score -= 0.05;

  score = clamp(score);
  let classification = initial;
  if (classification === 'unknown' && READABLE_KINDS.has(block.kind) && score >= 0.58) classification = 'primary';

  const strongSemantic = initial !== 'unknown' || primaryContext;
  const decisionDistance = Math.abs(score - 0.5);
  const confidence = clamp(0.48 + decisionDistance * 0.75 + (strongSemantic ? 0.12 : 0));
  return {
    block,
    index: -1,
    score: rounded(score),
    confidence: rounded(confidence),
    classification,
    reasons: reasons.slice(0, 4),
  };
}

function groupSections(
  scored: readonly ScoredBlock[],
  readingIds: ReadonlySet<string>,
  frameOrder: readonly string[],
  maxSections: number,
): { sections: DocumentSectionGrouping[]; truncated: boolean } {
  const sections: DocumentSectionGrouping[] = [];
  let truncated = false;

  for (const frameId of frameOrder) {
    const frameBlocks = scored.filter((entry) => entry.block.frameId === frameId && readingIds.has(entry.block.id));
    const stack: Array<{ level: number; section: DocumentSectionGrouping }> = [];
    let root: DocumentSectionGrouping | undefined;

    for (const entry of frameBlocks) {
      const block = entry.block;
      if (block.kind === 'heading') {
        const level = block.level ?? 6;
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        if (sections.length >= maxSections) {
          truncated = true;
          const target = stack[stack.length - 1]?.section ?? root;
          target?.blockIds.push(block.id);
          continue;
        }
        const parent = stack[stack.length - 1]?.section;
        const section: DocumentSectionGrouping = {
          sectionId: `section:${block.id}`,
          frameId,
          headingBlockId: block.id,
          headingLevel: level,
          ...(parent ? { parentSectionId: parent.sectionId } : {}),
          blockIds: [block.id],
        };
        sections.push(section);
        stack.push({ level, section });
        continue;
      }

      let target = stack[stack.length - 1]?.section;
      if (!target) {
        if (!root) {
          if (sections.length >= maxSections) {
            truncated = true;
            continue;
          }
          root = { sectionId: `section:${frameId}:root`, frameId, blockIds: [] };
          sections.push(root);
        }
        target = root;
      }
      target.blockIds.push(block.id);
    }
  }
  return { sections, truncated };
}

function tableParts(block: DocumentContentBlock): { tablePath: string; rowPath?: string } | undefined {
  const info = pathInfo(block);
  const tableIndex = info.tags.findIndex((tag) => tag === 'table');
  if (tableIndex < 0) return undefined;
  const tablePath = info.segments.slice(0, tableIndex + 1).join(' > ');
  const rowIndex = info.tags.findIndex((tag, index) => index > tableIndex && tag === 'tr');
  const rowPath = rowIndex >= 0 ? info.segments.slice(0, rowIndex + 1).join(' > ') : undefined;
  return { tablePath, ...(rowPath ? { rowPath } : {}) };
}

function interpretTables(
  snapshot: DocumentContentSnapshot,
  maxTables: number,
  maxRowsPerTable: number,
  maxCellsPerTable: number,
): { tables: DocumentTableInterpretation[]; truncated: boolean } {
  const candidates = new Map<string, TableCandidate>();
  let outputTruncated = false;

  for (const block of snapshot.blocks) {
    if (block.kind !== 'table-cell' && block.kind !== 'table-caption') continue;
    const parts = tableParts(block);
    if (!parts) continue;
    const tableId = `${block.frameId}:${parts.tablePath}`;
    let table = candidates.get(tableId);
    if (!table) {
      table = { frameId: block.frameId, tablePath: parts.tablePath, tableId, rows: new Map(), rowOrder: [] };
      candidates.set(tableId, table);
    }
    if (block.kind === 'table-caption' && table.captionBlockId === undefined) {
      table.captionBlockId = block.id;
      continue;
    }
    if (!parts.rowPath) continue;
    let cells = table.rows.get(parts.rowPath);
    if (!cells) {
      cells = [];
      table.rows.set(parts.rowPath, cells);
      table.rowOrder.push(parts.rowPath);
    }
    cells.push(block);
  }

  const tables: DocumentTableInterpretation[] = [];
  for (const candidate of candidates.values()) {
    if (tables.length >= maxTables) {
      outputTruncated = true;
      break;
    }
    const rows: DocumentTableRow[] = [];
    const cells: DocumentTableCellAssociation[] = [];
    const priorColumnHeaders = new Map<number, string[]>();
    let tableTruncated = false;

    for (let rowIndex = 0; rowIndex < candidate.rowOrder.length; rowIndex += 1) {
      if (rows.length >= maxRowsPerTable || cells.length >= maxCellsPerTable) {
        tableTruncated = true;
        break;
      }
      const sourceCells = candidate.rows.get(candidate.rowOrder[rowIndex]) ?? [];
      const retained = sourceCells.slice(0, Math.max(0, maxCellsPerTable - cells.length));
      if (retained.length < sourceCells.length) tableTruncated = true;
      const rowHeaderIds: string[] = [];
      const rowCellIds: string[] = [];

      for (let columnIndex = 0; columnIndex < retained.length; columnIndex += 1) {
        const cell = retained[columnIndex];
        const normalizedRole = normalizeText(cell.role);
        const isHeader = cell.tagName.toLowerCase() === 'th' || normalizedRole.includes('header');
        const inTableHead = pathInfo(cell).tags.includes('thead');
        const explicitRowHeader = normalizedRole === 'rowheader';
        const explicitColumnHeader = normalizedRole === 'columnheader';
        const rowHeader = isHeader && (explicitRowHeader || (!inTableHead && !explicitColumnHeader && columnIndex === 0));
        const columnHeader = isHeader && (explicitColumnHeader || inTableHead);
        const headerRole = !isHeader ? undefined
          : rowHeader && columnHeader ? 'both'
          : rowHeader ? 'row'
          : columnHeader ? 'column'
          : 'unspecified';
        cells.push({
          blockId: cell.id,
          rowIndex,
          columnIndex,
          isHeader,
          ...(headerRole ? { headerRole } : {}),
          rowHeaderBlockIds: [...rowHeaderIds],
          columnHeaderBlockIds: [...(priorColumnHeaders.get(columnIndex) ?? [])],
        });
        rowCellIds.push(cell.id);
        if (rowHeader) rowHeaderIds.push(cell.id);
        if (columnHeader) {
          const prior = priorColumnHeaders.get(columnIndex) ?? [];
          priorColumnHeaders.set(columnIndex, [...prior, cell.id]);
        }
      }
      rows.push({ rowIndex, cellBlockIds: rowCellIds });
      if (tableTruncated) break;
    }
    if (candidate.rowOrder.length > rows.length) tableTruncated = true;
    tables.push({
      tableId: candidate.tableId,
      frameId: candidate.frameId,
      ...(candidate.captionBlockId ? { captionBlockId: candidate.captionBlockId } : {}),
      rows,
      cells,
      truncated: tableTruncated,
    });
    outputTruncated ||= tableTruncated;
  }
  return { tables, truncated: outputTruncated };
}

/**
 * Build a deterministic research/content-analysis view over an existing
 * DocumentContentSnapshot. The source snapshot is never mutated and every block
 * reference in the result uses the extractor's original block identity.
 */
export function rankDocumentContent(
  snapshot: DocumentContentSnapshot,
  options: DocumentRankingOptions = {},
): DocumentResearchView {
  const maxAssessedBlocks = positiveInteger('maxAssessedBlocks', options.maxAssessedBlocks ?? 512);
  const maxPrimaryBlocks = positiveInteger('maxPrimaryBlocks', options.maxPrimaryBlocks ?? 128);
  const maxReadingOrderBlocks = positiveInteger('maxReadingOrderBlocks', options.maxReadingOrderBlocks ?? 256);
  const maxSections = positiveInteger('maxSections', options.maxSections ?? 64);
  const maxTables = positiveInteger('maxTables', options.maxTables ?? 16);
  const maxRowsPerTable = positiveInteger('maxRowsPerTable', options.maxRowsPerTable ?? 64);
  const maxCellsPerTable = positiveInteger('maxCellsPerTable', options.maxCellsPerTable ?? 512);
  const primaryScoreThreshold = unitInterval('primaryScoreThreshold', options.primaryScoreThreshold ?? 0.58);
  const readingScoreThreshold = unitInterval('readingScoreThreshold', options.readingScoreThreshold ?? 0.42);

  const infos = snapshot.blocks.map(pathInfo);
  const textCounts = new Map<string, number>();
  for (const block of snapshot.blocks) {
    const text = combinedText(block);
    if (text && text.length <= 100) textCounts.set(text, (textCounts.get(text) ?? 0) + 1);
  }
  const cookiePrefixes = clusterPrefixes(snapshot.blocks, infos, cookieSeed);
  const recommendationPrefixes = clusterPrefixes(snapshot.blocks, infos, recommendationSeed);

  const scored = snapshot.blocks.map((block, index) => {
    const classified = classifyBlock(block, infos[index], textCounts, cookiePrefixes, recommendationPrefixes);
    const result = scoreBlock(block, infos[index], classified.classification, classified.reasons);
    result.index = index;
    if (READABLE_KINDS.has(block.kind) && result.classification === 'unknown' && result.score >= primaryScoreThreshold) {
      result.classification = 'primary';
    } else if (result.classification === 'primary' && result.score < primaryScoreThreshold) {
      result.classification = 'unknown';
    }
    return result;
  });

  const assessments = scored.slice(0, maxAssessedBlocks).map((entry) => ({
    blockId: entry.block.id,
    frameId: entry.block.frameId,
    contentScore: entry.score,
    confidence: entry.confidence,
    classification: entry.classification,
    reasons: [...entry.reasons],
  }));

  const eligibleForPrimary = scored
    .filter((entry) => READABLE_KINDS.has(entry.block.kind) &&
      entry.score >= primaryScoreThreshold &&
      !['navigation', 'cookie-banner', 'sidebar', 'footer', 'recommendation', 'repeated-chrome', 'metadata'].includes(entry.classification))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const primaryContentBlockIds = eligibleForPrimary.slice(0, maxPrimaryBlocks).map((entry) => entry.block.id);
  const primarySet = new Set(primaryContentBlockIds);

  const readingEligible = scored
    .filter((entry) => READABLE_KINDS.has(entry.block.kind) &&
      (entry.score >= readingScoreThreshold || primarySet.has(entry.block.id)) &&
      !['navigation', 'cookie-banner', 'sidebar', 'footer', 'recommendation', 'repeated-chrome', 'metadata'].includes(entry.classification))
    .sort((a, b) => a.index - b.index);
  const readingEntries = readingEligible.slice(0, maxReadingOrderBlocks);
  const readingOrderBlockIds = readingEntries.map((entry) => entry.block.id);
  const readingSet = new Set(readingOrderBlockIds);

  const frameOrder = snapshot.frames.map((frame) => frame.frameId);
  for (const block of snapshot.blocks) if (!frameOrder.includes(block.frameId)) frameOrder.push(block.frameId);
  const grouped = groupSections(scored, readingSet, frameOrder, maxSections);
  const interpreted = interpretTables(snapshot, maxTables, maxRowsPerTable, maxCellsPerTable);

  const selectedPrimary = eligibleForPrimary.slice(0, maxPrimaryBlocks);
  const primaryContentConfidence = selectedPrimary.length
    ? rounded(selectedPrimary.reduce((sum, entry) => sum + entry.confidence, 0) / selectedPrimary.length)
    : 0;

  const derivedTruncated = snapshot.blocks.length > maxAssessedBlocks ||
    eligibleForPrimary.length > maxPrimaryBlocks ||
    readingEligible.length > maxReadingOrderBlocks ||
    grouped.truncated || interpreted.truncated;

  return {
    primaryContentBlockIds,
    readingOrderBlockIds,
    primaryContentConfidence,
    assessments,
    sections: grouped.sections,
    tables: interpreted.tables,
    truncated: snapshot.truncated || derivedTruncated,
    sourceTruncated: snapshot.truncated,
  };
}
