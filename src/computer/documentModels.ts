/**
 * Application-neutral semantic models for document/editor work.
 *
 * This layer deliberately models application state and user intent, not the
 * mechanism used to observe or manipulate that state. Native APIs,
 * accessibility, desktop input, structured file adapters, and visual fallback
 * may all implement these contracts without becoming part of the contracts.
 */

export const DOCUMENT_KINDS = [
  'word-processing',
  'spreadsheet',
  'presentation',
  'code-workspace',
  'media-project',
  'structured-project',
] as const;

export type DocumentKind = typeof DOCUMENT_KINDS[number];

export interface DocumentRef {
  /** Opaque application/model identity; never infer identity from a title or path. */
  documentId: string;
  /** Increments whenever the represented document instance is replaced or reopened. */
  generation: number;
  kind: DocumentKind;
}

export const DOCUMENT_REPLACEMENT_REASONS = [
  'reload',
  'reopen',
  'replace',
  'import',
  'recover',
] as const;

export type DocumentReplacementReason = typeof DOCUMENT_REPLACEMENT_REASONS[number];

export interface DocumentReplacement {
  previous: DocumentRef;
  current: DocumentRef;
  reason: DocumentReplacementReason;
}

export const STRUCTURED_ENTITY_KINDS = [
  'section',
  'page',
  'slide',
  'sheet',
  'table',
  'presentation-object',
  'code-buffer',
  'media-timeline',
  'media-track',
  'media-clip',
  'structured-object',
] as const;

export type StructuredEntityKind = typeof STRUCTURED_ENTITY_KINDS[number];

export interface StructuredEntityRef {
  document: DocumentRef;
  kind: StructuredEntityKind;
  /** Opaque stable identity inside one document generation. */
  entityId: string;
  /** Increments when this entity is replaced while the document remains open. */
  generation: number;
  /** Optional opaque parent identity; not a display label or index. */
  parentEntityId?: string;
}

export interface DocumentIdentityState {
  document: DocumentRef;
  entities: readonly {
    kind: StructuredEntityKind;
    entityId: string;
    generation: number;
  }[];
}

export type FreshnessFailure =
  | 'document-identity-mismatch'
  | 'document-generation-stale'
  | 'document-kind-mismatch'
  | 'entity-missing'
  | 'entity-kind-mismatch'
  | 'entity-generation-stale';

export type FreshnessResult =
  | { fresh: true }
  | { fresh: false; reason: FreshnessFailure };

const MAX_OPAQUE_ID_BYTES = 256;
const MAX_OBSERVATION_LIMIT = 1_000_000;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validOpaqueId(value: string): boolean {
  return value.length > 0 && utf8Bytes(value) <= MAX_OPAQUE_ID_BYTES && !/[\r\n\0]/.test(value);
}

function validGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateDocumentRef(ref: DocumentRef): readonly string[] {
  const errors: string[] = [];
  if (!validOpaqueId(ref.documentId)) errors.push('documentId must be a bounded opaque identifier');
  if (!validGeneration(ref.generation)) errors.push('document generation must be a non-negative safe integer');
  if (!DOCUMENT_KINDS.includes(ref.kind)) errors.push('document kind is unsupported');
  return errors;
}

export function validateStructuredEntityRef(ref: StructuredEntityRef): readonly string[] {
  const errors = [...validateDocumentRef(ref.document)];
  if (!STRUCTURED_ENTITY_KINDS.includes(ref.kind)) errors.push('entity kind is unsupported');
  if (!validOpaqueId(ref.entityId)) errors.push('entityId must be a bounded opaque identifier');
  if (!validGeneration(ref.generation)) errors.push('entity generation must be a non-negative safe integer');
  if (ref.parentEntityId !== undefined && !validOpaqueId(ref.parentEntityId)) {
    errors.push('parentEntityId must be a bounded opaque identifier');
  }
  return errors;
}

export function checkDocumentFreshness(reference: DocumentRef, current: DocumentRef): FreshnessResult {
  if (reference.documentId !== current.documentId) return { fresh: false, reason: 'document-identity-mismatch' };
  if (reference.kind !== current.kind) return { fresh: false, reason: 'document-kind-mismatch' };
  if (reference.generation !== current.generation) return { fresh: false, reason: 'document-generation-stale' };
  return { fresh: true };
}

export function checkEntityFreshness(
  reference: StructuredEntityRef,
  current: DocumentIdentityState,
): FreshnessResult {
  const documentFreshness = checkDocumentFreshness(reference.document, current.document);
  if (!documentFreshness.fresh) return documentFreshness;

  const sameId = current.entities.find((entity) => entity.entityId === reference.entityId);
  if (!sameId) return { fresh: false, reason: 'entity-missing' };
  if (sameId.kind !== reference.kind) return { fresh: false, reason: 'entity-kind-mismatch' };
  if (sameId.generation !== reference.generation) return { fresh: false, reason: 'entity-generation-stale' };
  return { fresh: true };
}

export function describeReplacement(previous: DocumentRef, current: DocumentRef, reason: DocumentReplacementReason): DocumentReplacement {
  if (previous.documentId !== current.documentId) {
    throw new Error('replacement must preserve documentId; use a distinct DocumentRef for a different document');
  }
  if (previous.kind !== current.kind) throw new Error('replacement cannot change document kind');
  if (current.generation <= previous.generation) throw new Error('replacement must advance document generation');
  return { previous, current, reason };
}

export interface TextRange {
  /** Zero-based UTF-16 code-unit offset, matching common text-model APIs. */
  start: number;
  /** Exclusive zero-based UTF-16 code-unit offset. */
  end: number;
}

export interface TextSelection {
  /** Stable semantic selection identity if the application exposes one. */
  selectionId: string;
  range: TextRange;
  direction: 'forward' | 'backward' | 'none';
}

export interface TextFormattingPatch {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fontFamily?: string;
  fontSizePoints?: number;
  paragraphStyle?: string;
}

export interface TableRegion {
  table: StructuredEntityRef;
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

export interface CellAddress {
  /** Zero-based row index. */
  row: number;
  /** Zero-based column index. */
  column: number;
}

export interface CellRange {
  sheet: StructuredEntityRef;
  start: CellAddress;
  end: CellAddress;
}

export type SpreadsheetScalar = string | number | boolean | null;

export type SpreadsheetCellInput =
  | { kind: 'blank' }
  | { kind: 'value'; value: SpreadsheetScalar }
  | { kind: 'formula'; formula: string };

export interface SpreadsheetCellState {
  address: CellAddress;
  /** What the model stores/edits. A formula is never collapsed into its displayed value. */
  input: SpreadsheetCellInput;
  /** Calculated/formatted display text if available. */
  displayedValue?: string;
}

export const PRESENTATION_OBJECT_KINDS = [
  'text-box',
  'shape',
  'image',
  'chart',
  'table',
  'media',
  'group',
  'other',
] as const;

export type PresentationObjectKind = typeof PRESENTATION_OBJECT_KINDS[number];

export interface PresentationObjectRef extends StructuredEntityRef {
  kind: 'presentation-object';
  objectKind: PresentationObjectKind;
  slideId: string;
}

export interface CodeBufferRef extends StructuredEntityRef {
  kind: 'code-buffer';
  /** Logical language identifier if known; never required for identity. */
  languageId?: string;
}

export interface CodeRange {
  buffer: CodeBufferRef;
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export type MediaEntityKind = 'media-timeline' | 'media-track' | 'media-clip';

export interface MediaEntityRef extends StructuredEntityRef {
  kind: MediaEntityKind;
}

export interface TimelineRange {
  timeline: MediaEntityRef;
  startSeconds: number;
  endSeconds: number;
}

export interface StructuredObjectRef extends StructuredEntityRef {
  kind: 'structured-object';
  /** Application-neutral schema category such as component, layer, body, node, or feature. */
  schemaKind?: string;
}

export interface ObservationBounds {
  /** Required positive limit: observations never imply "all items". */
  maxItems: number;
  /** Required positive UTF-8 byte limit for exposed text. */
  maxTextBytes: number;
}

export type TextExposure = 'content' | 'metadata-only';

export interface TextObservation {
  range: TextRange;
  exposure: TextExposure;
  /** Omitted in metadata-only mode. */
  text?: string;
  totalUtf8Bytes: number;
  exposedUtf8Bytes: number;
  truncated: boolean;
  omittedUtf8Bytes: number;
}

export interface BoundedItemsObservation<T> {
  items: readonly T[];
  totalItems: number;
  truncated: boolean;
  omittedItems: number;
}

export function validateObservationBounds(bounds: ObservationBounds): readonly string[] {
  const errors: string[] = [];
  if (!Number.isSafeInteger(bounds.maxItems) || bounds.maxItems < 1 || bounds.maxItems > MAX_OBSERVATION_LIMIT) {
    errors.push('maxItems must be a positive bounded safe integer');
  }
  if (!Number.isSafeInteger(bounds.maxTextBytes) || bounds.maxTextBytes < 1 || bounds.maxTextBytes > MAX_OBSERVATION_LIMIT) {
    errors.push('maxTextBytes must be a positive bounded safe integer');
  }
  return errors;
}

export function validateTextRange(range: TextRange, textLength?: number): readonly string[] {
  const errors: string[] = [];
  if (!Number.isSafeInteger(range.start) || range.start < 0) errors.push('range start must be a non-negative safe integer');
  if (!Number.isSafeInteger(range.end) || range.end < range.start) errors.push('range end must be a safe integer at or after start');
  if (textLength !== undefined && range.end > textLength) errors.push('range exceeds observed text length');
  return errors;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, mid);
    if (utf8Bytes(candidate) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  // Avoid returning a dangling high surrogate if the byte boundary fell between a pair.
  let end = low;
  if (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return value.slice(0, end);
}

/**
 * Produce a bounded, targeted observation of one text range.
 * Metadata-only mode intentionally exposes no text while retaining useful size/truncation metadata.
 */
export function observeTextRange(
  source: string,
  range: TextRange,
  bounds: ObservationBounds,
  exposure: TextExposure = 'content',
): TextObservation {
  const boundErrors = validateObservationBounds(bounds);
  if (boundErrors.length > 0) throw new Error(boundErrors.join('; '));
  const rangeErrors = validateTextRange(range, source.length);
  if (rangeErrors.length > 0) throw new Error(rangeErrors.join('; '));

  const selected = source.slice(range.start, range.end);
  const totalUtf8Bytes = utf8Bytes(selected);
  if (exposure === 'metadata-only') {
    return {
      range,
      exposure,
      totalUtf8Bytes,
      exposedUtf8Bytes: 0,
      truncated: totalUtf8Bytes > 0,
      omittedUtf8Bytes: totalUtf8Bytes,
    };
  }

  const text = truncateUtf8(selected, bounds.maxTextBytes);
  const exposedUtf8Bytes = utf8Bytes(text);
  return {
    range,
    exposure,
    text,
    totalUtf8Bytes,
    exposedUtf8Bytes,
    truncated: exposedUtf8Bytes < totalUtf8Bytes,
    omittedUtf8Bytes: totalUtf8Bytes - exposedUtf8Bytes,
  };
}

export function observeBoundedItems<T>(items: readonly T[], bounds: ObservationBounds): BoundedItemsObservation<T> {
  const errors = validateObservationBounds(bounds);
  if (errors.length > 0) throw new Error(errors.join('; '));
  const visible = items.slice(0, bounds.maxItems);
  return {
    items: visible,
    totalItems: items.length,
    truncated: visible.length < items.length,
    omittedItems: items.length - visible.length,
  };
}

export const SEMANTIC_EFFECT_CLASSES = [
  'local-reversible-edit',
  'local-destructive-edit',
  'local-persistence',
  'external-publication',
] as const;

export type SemanticEffectClass = typeof SEMANTIC_EFFECT_CLASSES[number];

interface IntentBase {
  intentId: string;
  document: DocumentRef;
  effect: SemanticEffectClass;
}

export interface InsertTextIntent extends IntentBase {
  kind: 'insert-text';
  effect: 'local-reversible-edit';
  target: StructuredEntityRef;
  at: number;
  text: string;
}

export interface ReplaceTextIntent extends IntentBase {
  kind: 'replace-text';
  effect: 'local-reversible-edit' | 'local-destructive-edit';
  target: StructuredEntityRef;
  range: TextRange;
  text: string;
}

export interface ApplyTextFormattingIntent extends IntentBase {
  kind: 'apply-text-formatting';
  effect: 'local-reversible-edit';
  target: StructuredEntityRef;
  range: TextRange;
  formatting: TextFormattingPatch;
}

export interface SetCellValueIntent extends IntentBase {
  kind: 'set-cell-value';
  effect: 'local-reversible-edit' | 'local-destructive-edit';
  target: CellRange;
  value: SpreadsheetScalar;
}

export interface SetCellFormulaIntent extends IntentBase {
  kind: 'set-cell-formula';
  effect: 'local-reversible-edit' | 'local-destructive-edit';
  target: CellRange;
  formula: string;
}

export interface AddStructuredObjectIntent extends IntentBase {
  kind: 'add-structured-object';
  effect: 'local-reversible-edit';
  container: StructuredEntityRef;
  objectKind: StructuredEntityKind | PresentationObjectKind | string;
  beforeEntityId?: string;
  properties?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RemoveStructuredObjectIntent extends IntentBase {
  kind: 'remove-structured-object';
  effect: 'local-reversible-edit' | 'local-destructive-edit';
  target: StructuredEntityRef;
}

export interface ReorderStructuredObjectIntent extends IntentBase {
  kind: 'reorder-structured-object';
  effect: 'local-reversible-edit';
  target: StructuredEntityRef;
  beforeEntityId?: string;
}

export interface EditCodeBufferIntent extends IntentBase {
  kind: 'edit-code-buffer';
  effect: 'local-reversible-edit' | 'local-destructive-edit';
  target: CodeBufferRef;
  range: CodeRange;
  text: string;
}

export interface SaveDocumentIntent extends IntentBase {
  kind: 'save-document';
  effect: 'local-persistence';
}

export interface ExportDocumentIntent extends IntentBase {
  kind: 'export-document';
  /** Local export stays local persistence; remote publish/upload is explicitly external. */
  effect: 'local-persistence' | 'external-publication';
  format: string;
  destination:
    | { kind: 'local-artifact'; artifactId: string }
    | { kind: 'external-target'; targetId: string };
}

export interface PublishDocumentIntent extends IntentBase {
  kind: 'publish-document';
  effect: 'external-publication';
  destinationId: string;
}

export type SemanticEditIntent =
  | InsertTextIntent
  | ReplaceTextIntent
  | ApplyTextFormattingIntent
  | SetCellValueIntent
  | SetCellFormulaIntent
  | AddStructuredObjectIntent
  | RemoveStructuredObjectIntent
  | ReorderStructuredObjectIntent
  | EditCodeBufferIntent
  | SaveDocumentIntent
  | ExportDocumentIntent
  | PublishDocumentIntent;

export function classifyIntentEffect(intent: SemanticEditIntent): SemanticEffectClass {
  return intent.effect;
}

export function validateIntent(intent: SemanticEditIntent): readonly string[] {
  const errors = [...validateDocumentRef(intent.document)];
  if (!validOpaqueId(intent.intentId)) errors.push('intentId must be a bounded opaque identifier');

  const ensureTargetDocument = (target: StructuredEntityRef): void => {
    errors.push(...validateStructuredEntityRef(target));
    if (target.document.documentId !== intent.document.documentId || target.document.generation !== intent.document.generation) {
      errors.push('target document does not match intent document generation');
    }
  };

  switch (intent.kind) {
    case 'insert-text':
      ensureTargetDocument(intent.target);
      if (!Number.isSafeInteger(intent.at) || intent.at < 0) errors.push('insert offset must be a non-negative safe integer');
      break;
    case 'replace-text':
    case 'apply-text-formatting':
      ensureTargetDocument(intent.target);
      errors.push(...validateTextRange(intent.range));
      break;
    case 'set-cell-value':
    case 'set-cell-formula':
      ensureTargetDocument(intent.target.sheet);
      if (intent.target.sheet.kind !== 'sheet') errors.push('cell range target must be a sheet');
      if (intent.kind === 'set-cell-formula' && intent.formula.length === 0) errors.push('formula must not be empty');
      break;
    case 'add-structured-object':
      ensureTargetDocument(intent.container);
      break;
    case 'remove-structured-object':
    case 'reorder-structured-object':
      ensureTargetDocument(intent.target);
      break;
    case 'edit-code-buffer':
      ensureTargetDocument(intent.target);
      if (intent.range.buffer.entityId !== intent.target.entityId || intent.range.buffer.generation !== intent.target.generation) {
        errors.push('code range buffer does not match edit target');
      }
      break;
    case 'save-document':
      break;
    case 'export-document':
      if (intent.destination.kind === 'local-artifact' && intent.effect !== 'local-persistence') {
        errors.push('local export must be classified as local-persistence');
      }
      if (intent.destination.kind === 'external-target' && intent.effect !== 'external-publication') {
        errors.push('external export must be classified as external-publication');
      }
      break;
    case 'publish-document':
      break;
  }
  return errors;
}

export type VerificationTarget =
  | { kind: 'document'; document: DocumentRef }
  | { kind: 'entity'; entity: StructuredEntityRef };

export type ModelObservation =
  | {
      kind: 'text';
      target: StructuredEntityRef;
      revision: number;
      observation: TextObservation;
    }
  | {
      kind: 'cells';
      target: StructuredEntityRef;
      revision: number;
      cells: readonly SpreadsheetCellState[];
      truncated: boolean;
    }
  | {
      kind: 'entity-order';
      target: StructuredEntityRef;
      revision: number;
      entityIds: readonly string[];
      truncated: boolean;
    }
  | {
      kind: 'saved-state';
      target: DocumentRef;
      revision: number;
      savedRevision: number;
    };

export type VerificationExpectation =
  | { kind: 'text-equals'; target: StructuredEntityRef; range: TextRange; expected: string }
  | { kind: 'cell-input-equals'; target: StructuredEntityRef; address: CellAddress; expected: SpreadsheetCellInput }
  | { kind: 'entity-order-equals'; target: StructuredEntityRef; expectedEntityIds: readonly string[] }
  | { kind: 'saved-revision-at-least'; target: DocumentRef; minimumRevision: number };

export interface PostEditVerificationRequest {
  identity: DocumentIdentityState;
  /** Revision observed before dispatch. A verified edit must advance model state. */
  beforeRevision: number;
  expectation: VerificationExpectation;
  observation: ModelObservation;
}

export type PostEditVerification =
  | { status: 'verified'; evidence: readonly string[] }
  | { status: 'stale-target'; reason: FreshnessFailure; evidence: readonly string[] }
  | { status: 'insufficient-observation'; evidence: readonly string[] }
  | { status: 'mismatch'; evidence: readonly string[] };

function sameCellInput(left: SpreadsheetCellInput, right: SpreadsheetCellInput): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'blank' && right.kind === 'blank') return true;
  if (left.kind === 'value' && right.kind === 'value') return Object.is(left.value, right.value);
  if (left.kind === 'formula' && right.kind === 'formula') return left.formula === right.formula;
  return false;
}

function sameCellAddress(left: CellAddress, right: CellAddress): boolean {
  return left.row === right.row && left.column === right.column;
}

function sameTextRange(left: TextRange, right: TextRange): boolean {
  return left.start === right.start && left.end === right.end;
}

function targetFreshness(target: VerificationTarget, identity: DocumentIdentityState): FreshnessResult {
  return target.kind === 'document'
    ? checkDocumentFreshness(target.document, identity.document)
    : checkEntityFreshness(target.entity, identity);
}

function expectationTarget(expectation: VerificationExpectation): VerificationTarget {
  if (expectation.kind === 'saved-revision-at-least') return { kind: 'document', document: expectation.target };
  return { kind: 'entity', entity: expectation.target };
}

/**
 * Verify semantic/model state after an attempted edit. Dispatch success is not
 * an input to this function and therefore can never prove an edit by itself.
 */
export function verifyPostEdit(request: PostEditVerificationRequest): PostEditVerification {
  const freshness = targetFreshness(expectationTarget(request.expectation), request.identity);
  if (!freshness.fresh) {
    return { status: 'stale-target', reason: freshness.reason, evidence: ['semantic-target-stale'] };
  }

  if (request.observation.revision <= request.beforeRevision) {
    return { status: 'mismatch', evidence: ['model-revision-did-not-advance'] };
  }

  const expectation = request.expectation;
  const observation = request.observation;

  if (expectation.kind === 'text-equals') {
    if (observation.kind !== 'text' || observation.target.entityId !== expectation.target.entityId) {
      return { status: 'insufficient-observation', evidence: ['text-observation-missing'] };
    }
    if (observation.observation.exposure !== 'content' || observation.observation.text === undefined || observation.observation.truncated) {
      return { status: 'insufficient-observation', evidence: ['text-observation-not-complete'] };
    }
    if (!sameTextRange(observation.observation.range, expectation.range)) {
      return { status: 'insufficient-observation', evidence: ['text-range-not-targeted'] };
    }
    return observation.observation.text === expectation.expected
      ? { status: 'verified', evidence: ['text-model-matches'] }
      : { status: 'mismatch', evidence: ['text-model-mismatch'] };
  }

  if (expectation.kind === 'cell-input-equals') {
    if (observation.kind !== 'cells' || observation.target.entityId !== expectation.target.entityId) {
      return { status: 'insufficient-observation', evidence: ['cell-observation-missing'] };
    }
    const cell = observation.cells.find((candidate) => sameCellAddress(candidate.address, expectation.address));
    if (!cell) return { status: 'insufficient-observation', evidence: ['target-cell-not-observed'] };
    return sameCellInput(cell.input, expectation.expected)
      ? { status: 'verified', evidence: ['cell-input-model-matches'] }
      : { status: 'mismatch', evidence: ['cell-input-model-mismatch'] };
  }

  if (expectation.kind === 'entity-order-equals') {
    if (observation.kind !== 'entity-order' || observation.target.entityId !== expectation.target.entityId) {
      return { status: 'insufficient-observation', evidence: ['entity-order-observation-missing'] };
    }
    if (observation.truncated) return { status: 'insufficient-observation', evidence: ['entity-order-observation-truncated'] };
    const matches = observation.entityIds.length === expectation.expectedEntityIds.length
      && observation.entityIds.every((id, index) => id === expectation.expectedEntityIds[index]);
    return matches
      ? { status: 'verified', evidence: ['entity-order-model-matches'] }
      : { status: 'mismatch', evidence: ['entity-order-model-mismatch'] };
  }

  if (observation.kind !== 'saved-state' || observation.target.documentId !== expectation.target.documentId) {
    return { status: 'insufficient-observation', evidence: ['saved-state-observation-missing'] };
  }
  return observation.savedRevision >= expectation.minimumRevision
    ? { status: 'verified', evidence: ['saved-model-revision-confirmed'] }
    : { status: 'mismatch', evidence: ['saved-model-revision-too-old'] };
}
