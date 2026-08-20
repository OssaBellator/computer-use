import type { Rect } from '../types.js';
import type { DocumentContentBlock, DocumentContentSnapshot } from './documentContent.js';
import { rankDocumentContent, type DocumentBlockAssessment } from './documentRanking.js';

export type DocumentBlockChangedField =
  | 'kind'
  | 'tagName'
  | 'depth'
  | 'text'
  | 'level'
  | 'href'
  | 'alt'
  | 'role'
  | 'name'
  | 'rect'
  | 'rendered'
  | 'inViewport'
  | 'truncated';

export interface DocumentDiffOptions {
  /** Maximum exact added block IDs returned. Defaults to 256. */
  maxAddedBlocks?: number;
  /** Maximum exact removed block IDs returned. Defaults to 256. */
  maxRemovedBlocks?: number;
  /** Maximum same-identity changed block records returned. Defaults to 256. */
  maxChangedBlocks?: number;
  /** Maximum deterministic relocation pairs returned. Defaults to 128. */
  maxRelocatedBlocks?: number;
  /** Maximum likely content-update records returned. Defaults to 128. */
  maxLikelyContentUpdates?: number;
  /** Maximum added/removed frame IDs returned for each side. Defaults to 64. */
  maxFrameChanges?: number;
  /** Maximum refresh hints returned. Defaults to 32. */
  maxRefreshHints?: number;
  /** Maximum source block IDs retained on one refresh hint. Defaults to 24. */
  maxHintBlockIds?: number;
}

export interface DocumentBlockChange {
  blockId: string;
  changedFields: DocumentBlockChangedField[];
  /** Text/semantic target data changed, rather than only viewport/layout state. */
  contentChanged: boolean;
  /** Geometry/rendering/viewport/depth changed. */
  presentationChanged: boolean;
}

export interface DocumentRelocatedBlock {
  previousBlockId: string;
  currentBlockId: string;
}

export interface DocumentLikelyContentUpdate {
  kind: 'added' | 'removed' | 'modified';
  previousBlockId?: string;
  currentBlockId?: string;
  confidence: number;
  reasons: string[];
}

export type DocumentRefreshReason =
  | 'content-update'
  | 'structural-change'
  | 'frame-error'
  | 'truncated-extraction';

export interface DocumentRefreshHint {
  frameId: string;
  scope: 'frame' | 'region';
  priority: number;
  reason: DocumentRefreshReason;
  /** Frame-local document coordinates when changed blocks had geometry. */
  rect?: Rect;
  /** Source identities from either side of the diff, bounded by maxHintBlockIds. */
  relatedBlockIds: string[];
}

export interface DocumentContentDiff {
  addedBlockIds: string[];
  removedBlockIds: string[];
  changedBlocks: DocumentBlockChange[];
  relocatedBlocks: DocumentRelocatedBlock[];
  addedFrameIds: string[];
  removedFrameIds: string[];
  likelyContentUpdates: DocumentLikelyContentUpdate[];
  refreshHints: DocumentRefreshHint[];
  unchangedBlockCount: number;
  /** True when source snapshots or derived-output bounds omitted detail. */
  truncated: boolean;
}

interface HintAccumulator {
  frameId: string;
  reason: DocumentRefreshReason;
  priority: number;
  rect?: Rect;
  relatedBlockIds: string[];
  regionKey?: string;
}

const CONTENT_FIELDS = new Set<DocumentBlockChangedField>([
  'kind', 'tagName', 'text', 'level', 'href', 'alt', 'role', 'name',
]);
const PRESENTATION_FIELDS = new Set<DocumentBlockChangedField>([
  'depth', 'rect', 'rendered', 'inViewport',
]);
const BOILERPLATE = new Set<DocumentBlockAssessment['classification']>([
  'navigation', 'cookie-banner', 'footer', 'recommendation', 'repeated-chrome', 'metadata', 'sidebar',
]);

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number): number {
  return Math.round(clamp(value) * 1000) / 1000;
}

function normalize(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function rectEqual(a: Rect | undefined, b: Rect | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function changedFields(previous: DocumentContentBlock, current: DocumentContentBlock): DocumentBlockChangedField[] {
  const fields: DocumentBlockChangedField[] = [];
  if (previous.kind !== current.kind) fields.push('kind');
  if (previous.tagName !== current.tagName) fields.push('tagName');
  if (previous.depth !== current.depth) fields.push('depth');
  if (previous.text !== current.text) fields.push('text');
  if (previous.level !== current.level) fields.push('level');
  if (previous.href !== current.href) fields.push('href');
  if (previous.alt !== current.alt) fields.push('alt');
  if (previous.role !== current.role) fields.push('role');
  if (previous.name !== current.name) fields.push('name');
  if (!rectEqual(previous.rect, current.rect)) fields.push('rect');
  if (previous.rendered !== current.rendered) fields.push('rendered');
  if (previous.inViewport !== current.inViewport) fields.push('inViewport');
  if (previous.truncated !== current.truncated) fields.push('truncated');
  return fields;
}

function semanticFingerprint(block: DocumentContentBlock): string {
  const payload = [block.text, block.href, block.alt, block.role, block.name]
    .map(normalize)
    .filter(Boolean)
    .join('|');
  if (!payload) return '';
  return [block.frameId, block.kind, block.tagName.toLowerCase(), payload].join('\u001f');
}

function pairRelocations(
  removed: readonly DocumentContentBlock[],
  added: readonly DocumentContentBlock[],
  maxPairs: number,
): { pairs: DocumentRelocatedBlock[]; pairedRemoved: Set<string>; pairedAdded: Set<string>; truncated: boolean } {
  const addedByFingerprint = new Map<string, DocumentContentBlock[]>();
  for (const block of added) {
    const fingerprint = semanticFingerprint(block);
    if (!fingerprint) continue;
    const bucket = addedByFingerprint.get(fingerprint) ?? [];
    bucket.push(block);
    addedByFingerprint.set(fingerprint, bucket);
  }

  const pairs: DocumentRelocatedBlock[] = [];
  const pairedRemoved = new Set<string>();
  const pairedAdded = new Set<string>();
  let truncated = false;
  for (const block of removed) {
    const fingerprint = semanticFingerprint(block);
    if (!fingerprint) continue;
    const candidates = addedByFingerprint.get(fingerprint);
    const candidate = candidates?.find((item) => !pairedAdded.has(item.id));
    if (!candidate) continue;
    if (pairs.length >= maxPairs) {
      truncated = true;
      continue;
    }
    pairs.push({ previousBlockId: block.id, currentBlockId: candidate.id });
    pairedRemoved.add(block.id);
    pairedAdded.add(candidate.id);
  }
  return { pairs, pairedRemoved, pairedAdded, truncated };
}

function sourcePath(block: DocumentContentBlock): string {
  const prefix = `${block.frameId}:`;
  return block.id.startsWith(prefix) ? block.id.slice(prefix.length) : block.id;
}

function tagOf(segment: string): string {
  return /^([a-z][a-z0-9-]*)/i.exec(segment)?.[1]?.toLowerCase() ?? '';
}

function regionKey(block: DocumentContentBlock): string {
  const segments = sourcePath(block).split(' > ').filter(Boolean);
  let semanticIndex = -1;
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (['main', 'article', 'section', 'table', 'aside', 'nav', 'header', 'footer'].includes(tagOf(segments[index]))) {
      semanticIndex = index;
    }
  }
  if (semanticIndex >= 0) return segments.slice(0, semanticIndex + 1).join(' > ');
  return segments.slice(0, Math.max(1, segments.length - 1)).join(' > ');
}

function unionRect(a: Rect | undefined, b: Rect | undefined): Rect | undefined {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return { ...a };
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function assessmentMap(snapshot: DocumentContentSnapshot): Map<string, DocumentBlockAssessment> {
  const ranked = rankDocumentContent(snapshot, { maxAssessedBlocks: Math.max(1, snapshot.blocks.length) });
  return new Map(ranked.assessments.map((assessment) => [assessment.blockId, assessment]));
}

function isContentLike(assessment: DocumentBlockAssessment | undefined): boolean {
  return assessment !== undefined && !BOILERPLATE.has(assessment.classification) && assessment.contentScore >= 0.48;
}

function updateConfidence(...assessments: Array<DocumentBlockAssessment | undefined>): number {
  const present = assessments.filter((item): item is DocumentBlockAssessment => item !== undefined);
  if (!present.length) return 0.5;
  const average = present.reduce((sum, item) => sum + (item.contentScore + item.confidence) / 2, 0) / present.length;
  const primaryBonus = present.some((item) => item.classification === 'primary') ? 0.1 : 0;
  return rounded(average + primaryBonus);
}

function addHint(
  hints: Map<string, HintAccumulator>,
  block: DocumentContentBlock,
  reason: DocumentRefreshReason,
  priority: number,
  maxHintBlockIds: number,
): void {
  const region = regionKey(block);
  const key = block.rect ? `${block.frameId}|${reason}|${region}` : `${block.frameId}|${reason}|@frame`;
  const existing = hints.get(key) ?? {
    frameId: block.frameId,
    reason,
    priority: 0,
    relatedBlockIds: [],
    regionKey: region,
  };
  existing.priority = Math.max(existing.priority, priority);
  existing.rect = unionRect(existing.rect, block.rect);
  if (existing.relatedBlockIds.length < maxHintBlockIds && !existing.relatedBlockIds.includes(block.id)) {
    existing.relatedBlockIds.push(block.id);
  }
  hints.set(key, existing);
}

function addFrameHint(
  hints: Map<string, HintAccumulator>,
  frameId: string,
  reason: DocumentRefreshReason,
  priority: number,
): void {
  const key = `${frameId}|${reason}|@frame`;
  const existing = hints.get(key) ?? { frameId, reason, priority: 0, relatedBlockIds: [] };
  existing.priority = Math.max(existing.priority, priority);
  hints.set(key, existing);
}

/**
 * Deterministically compare two document snapshots. Exact identity-based change
 * sets are kept separate from derived relocation/content-update guesses. Refresh
 * hints describe where a future extractor refresh would be useful; they perform
 * no browser interaction themselves.
 */
export function diffDocumentContent(
  previous: DocumentContentSnapshot,
  current: DocumentContentSnapshot,
  options: DocumentDiffOptions = {},
): DocumentContentDiff {
  const maxAddedBlocks = positiveInteger('maxAddedBlocks', options.maxAddedBlocks ?? 256);
  const maxRemovedBlocks = positiveInteger('maxRemovedBlocks', options.maxRemovedBlocks ?? 256);
  const maxChangedBlocks = positiveInteger('maxChangedBlocks', options.maxChangedBlocks ?? 256);
  const maxRelocatedBlocks = positiveInteger('maxRelocatedBlocks', options.maxRelocatedBlocks ?? 128);
  const maxLikelyContentUpdates = positiveInteger('maxLikelyContentUpdates', options.maxLikelyContentUpdates ?? 128);
  const maxFrameChanges = positiveInteger('maxFrameChanges', options.maxFrameChanges ?? 64);
  const maxRefreshHints = positiveInteger('maxRefreshHints', options.maxRefreshHints ?? 32);
  const maxHintBlockIds = positiveInteger('maxHintBlockIds', options.maxHintBlockIds ?? 24);

  const previousById = new Map(previous.blocks.map((block) => [block.id, block]));
  const currentById = new Map(current.blocks.map((block) => [block.id, block]));
  const addedAll = current.blocks.filter((block) => !previousById.has(block.id));
  const removedAll = previous.blocks.filter((block) => !currentById.has(block.id));

  const changedAll: DocumentBlockChange[] = [];
  let unchangedBlockCount = 0;
  for (const block of current.blocks) {
    const before = previousById.get(block.id);
    if (!before) continue;
    const fields = changedFields(before, block);
    if (!fields.length) {
      unchangedBlockCount += 1;
      continue;
    }
    changedAll.push({
      blockId: block.id,
      changedFields: fields,
      contentChanged: fields.some((field) => CONTENT_FIELDS.has(field)),
      presentationChanged: fields.some((field) => PRESENTATION_FIELDS.has(field)),
    });
  }

  const relocation = pairRelocations(removedAll, addedAll, maxRelocatedBlocks);
  const previousAssessments = assessmentMap(previous);
  const currentAssessments = assessmentMap(current);
  const likelyContentUpdates: DocumentLikelyContentUpdate[] = [];
  let likelyUpdatesTruncated = false;
  const retainUpdate = (update: DocumentLikelyContentUpdate): void => {
    if (likelyContentUpdates.length >= maxLikelyContentUpdates) {
      likelyUpdatesTruncated = true;
      return;
    }
    likelyContentUpdates.push(update);
  };

  for (const change of changedAll) {
    if (!change.contentChanged) continue;
    const before = previousAssessments.get(change.blockId);
    const after = currentAssessments.get(change.blockId);
    if (!isContentLike(before) && !isContentLike(after)) continue;
    retainUpdate({
      kind: 'modified',
      previousBlockId: change.blockId,
      currentBlockId: change.blockId,
      confidence: updateConfidence(before, after),
      reasons: ['same source identity with semantic fields changed'],
    });
  }
  for (const block of addedAll) {
    if (relocation.pairedAdded.has(block.id)) continue;
    const assessment = currentAssessments.get(block.id);
    if (!isContentLike(assessment)) continue;
    retainUpdate({
      kind: 'added',
      currentBlockId: block.id,
      confidence: updateConfidence(assessment),
      reasons: ['new content-like source block'],
    });
  }
  for (const block of removedAll) {
    if (relocation.pairedRemoved.has(block.id)) continue;
    const assessment = previousAssessments.get(block.id);
    if (!isContentLike(assessment)) continue;
    retainUpdate({
      kind: 'removed',
      previousBlockId: block.id,
      confidence: updateConfidence(assessment),
      reasons: ['removed content-like source block'],
    });
  }

  const hintMap = new Map<string, HintAccumulator>();
  for (const update of likelyContentUpdates) {
    const id = update.currentBlockId ?? update.previousBlockId;
    const block = (id && currentById.get(id)) ?? (id && previousById.get(id));
    if (block) addHint(hintMap, block, 'content-update', update.confidence, maxHintBlockIds);
  }
  for (const pair of relocation.pairs) {
    const currentBlock = currentById.get(pair.currentBlockId);
    if (currentBlock) addHint(hintMap, currentBlock, 'structural-change', 0.45, maxHintBlockIds);
  }
  for (const error of current.frameErrors) addFrameHint(hintMap, error.frameId, 'frame-error', 1);
  for (const frame of current.frames) {
    if (frame.browserExtractionTruncated) addFrameHint(hintMap, frame.frameId, 'truncated-extraction', 0.95);
  }
  if (current.truncated && !current.frames.some((frame) => frame.browserExtractionTruncated)) {
    const affected = new Set(current.blocks.filter((block) => block.truncated).map((block) => block.frameId));
    if (!affected.size && current.frames[0]) affected.add(current.frames[0].frameId);
    for (const frameId of affected) addFrameHint(hintMap, frameId, 'truncated-extraction', 0.9);
  }

  const refreshHints = [...hintMap.values()]
    .map((hint): DocumentRefreshHint => ({
      frameId: hint.frameId,
      scope: hint.rect ? 'region' : 'frame',
      priority: rounded(hint.priority),
      reason: hint.reason,
      ...(hint.rect ? { rect: { ...hint.rect } } : {}),
      relatedBlockIds: [...hint.relatedBlockIds],
    }))
    .sort((a, b) => b.priority - a.priority || a.frameId.localeCompare(b.frameId) || a.reason.localeCompare(b.reason))
    .slice(0, maxRefreshHints);

  const previousFrames = new Set(previous.frames.map((frame) => frame.frameId));
  const currentFrames = new Set(current.frames.map((frame) => frame.frameId));
  const addedFrameIdsAll = current.frames.filter((frame) => !previousFrames.has(frame.frameId)).map((frame) => frame.frameId);
  const removedFrameIdsAll = previous.frames.filter((frame) => !currentFrames.has(frame.frameId)).map((frame) => frame.frameId);
  const addedFrameIds = addedFrameIdsAll.slice(0, maxFrameChanges);
  const removedFrameIds = removedFrameIdsAll.slice(0, maxFrameChanges);

  const truncated = previous.truncated || current.truncated ||
    addedAll.length > maxAddedBlocks || removedAll.length > maxRemovedBlocks ||
    changedAll.length > maxChangedBlocks || relocation.truncated || likelyUpdatesTruncated ||
    addedFrameIdsAll.length > maxFrameChanges || removedFrameIdsAll.length > maxFrameChanges ||
    hintMap.size > maxRefreshHints;

  return {
    addedBlockIds: addedAll.slice(0, maxAddedBlocks).map((block) => block.id),
    removedBlockIds: removedAll.slice(0, maxRemovedBlocks).map((block) => block.id),
    changedBlocks: changedAll.slice(0, maxChangedBlocks),
    relocatedBlocks: relocation.pairs,
    addedFrameIds,
    removedFrameIds,
    likelyContentUpdates,
    refreshHints,
    unchangedBlockCount,
    truncated,
  };
}
