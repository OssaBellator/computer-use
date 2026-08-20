import {
  checkDocumentFreshness, checkEntityFreshness, classifyIntentEffect, sameStructuredEntityRef, utf8Bytes,
  validateCellRange, validateIntent, validateObservationBounds, verifyPostEdit,
  type CellAddress, type CellRange, type DocumentIdentityState, type DocumentRef, type ModelObservation,
  type ObservationBounds, type PostEditVerification, type SemanticEffectClass, type SetCellFormulaIntent,
  type SetCellValueIntent, type SpreadsheetCellInput, type SpreadsheetCellState, type StructuredEntityRef,
  type VerificationExpectation,
} from '../computer/documentModels.js';

export type SpreadsheetNativeEdit = SetCellValueIntent | SetCellFormulaIntent;
export interface SpreadsheetDispatchResult { dispatch: 'dispatched' | 'uncertain'; revision: number }
export interface SpreadsheetNativeBackend {
  readIdentity(): Promise<DocumentIdentityState>;
  readRevision(): Promise<number>;
  observeCells(target: CellRange, bounds: ObservationBounds): Promise<ModelObservation>;
  dispatchSemanticEdit(intent: SpreadsheetNativeEdit): Promise<SpreadsheetDispatchResult>;
}
export type SpreadsheetExecution =
  | { status: 'verified'; effect: SemanticEffectClass; dispatch: 'dispatched'; verification: PostEditVerification }
  | { status: 'uncertain'; effect: SemanticEffectClass; dispatch: 'uncertain'; verification: PostEditVerification }
  | { status: 'rejected'; effect?: SemanticEffectClass; dispatch: 'not-dispatched'; reason: string }
  | { status: 'verification-failed'; effect: SemanticEffectClass; dispatch: 'dispatched'; verification: PostEditVerification };
interface CellState { address: CellAddress; input: SpreadsheetCellInput; displayedValue?: string }
const cloneDocument = (ref: DocumentRef): DocumentRef => ({ ...ref });
const cloneEntity = (ref: StructuredEntityRef): StructuredEntityRef => ({ ...ref, document: cloneDocument(ref.document) });
const cloneAddress = (address: CellAddress): CellAddress => ({ ...address });
const cloneRange = (range: CellRange): CellRange => ({ sheet: cloneEntity(range.sheet), start: cloneAddress(range.start), end: cloneAddress(range.end) });
function cloneInput(input: SpreadsheetCellInput): SpreadsheetCellInput {
  if (input.kind === 'blank') return { kind: 'blank' };
  if (input.kind === 'formula') return { kind: 'formula', formula: `${input.formula}` };
  return { kind: 'value', value: typeof input.value === 'string' ? `${input.value}` : input.value };
}
function snapshotIntent(intent: SpreadsheetNativeEdit): SpreadsheetNativeEdit {
  return intent.kind === 'set-cell-formula'
    ? { ...intent, document: cloneDocument(intent.document), target: cloneRange(intent.target), formula: `${intent.formula}` }
    : { ...intent, document: cloneDocument(intent.document), target: cloneRange(intent.target), value: typeof intent.value === 'string' ? `${intent.value}` : intent.value };
}
const expectedInput = (intent: SpreadsheetNativeEdit): SpreadsheetCellInput => intent.kind === 'set-cell-formula' ? { kind: 'formula', formula: intent.formula } : { kind: 'value', value: intent.value };
const cellKey = (address: CellAddress): string => `${address.row}:${address.column}`;
function renderedInput(input: SpreadsheetCellInput): string { if (input.kind === 'blank') return ''; if (input.kind === 'formula') return `=${input.formula}`; return input.value === null ? 'null' : String(input.value); }
function totalCellCount(range: CellRange): number {
  const total = (range.end.row - range.start.row + 1) * (range.end.column - range.start.column + 1);
  if (!Number.isSafeInteger(total) || total < 1) throw new Error('cell range is too large');
  return total;
}
function addresses(range: CellRange): CellAddress[] {
  const out: CellAddress[] = [];
  for (let row = range.start.row; row <= range.end.row; row += 1) {
    for (let column = range.start.column; column <= range.end.column; column += 1) out.push({ row, column });
  }
  return out;
}
function verificationCapacityError(intent: SpreadsheetNativeEdit, bounds: ObservationBounds): string | undefined {
  const boundErrors = validateObservationBounds(bounds);
  if (boundErrors.length) return boundErrors.join('; ');
  const total = totalCellCount(intent.target);
  const perCellBytes = utf8Bytes(renderedInput(expectedInput(intent)));
  const requiredBytes = perCellBytes * total;
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes > bounds.maxTextBytes || total > bounds.maxItems) {
    return 'verification bounds cannot fully observe target cell range';
  }
  return undefined;
}
function verifyRange(identity: DocumentIdentityState, beforeRevision: number, intent: SpreadsheetNativeEdit, observation: ModelObservation): PostEditVerification {
  const expected = expectedInput(intent);
  let firstVerified: PostEditVerification | undefined;
  const targetAddresses = addresses(intent.target);
  for (const address of targetAddresses) {
    const expectation: VerificationExpectation = { kind: 'cell-input-equals', target: intent.target.sheet, address, expected };
    const result = verifyPostEdit({ identity, beforeRevision, expectation, observation });
    if (result.status !== 'verified') return result;
    firstVerified ??= result;
  }
  return targetAddresses.length === 1
    ? firstVerified ?? { status: 'insufficient-observation', evidence: ['target-cell-not-observed'] }
    : { status: 'verified', evidence: ['cell-range-model-matches'] };
}
const failedVerification = (): PostEditVerification => ({ status: 'insufficient-observation', evidence: ['post-dispatch-observation-failed'] });

export class SpreadsheetSemanticController {
  constructor(private readonly backend: SpreadsheetNativeBackend) {}
  classify(intent: SpreadsheetNativeEdit): SemanticEffectClass { return classifyIntentEffect(intent); }
  execute(intent: SpreadsheetNativeEdit, verificationBounds: ObservationBounds): Promise<SpreadsheetExecution> { return this.executeSnapshot(snapshotIntent(intent), { ...verificationBounds }); }
  private async executeSnapshot(intent: SpreadsheetNativeEdit, verificationBounds: ObservationBounds): Promise<SpreadsheetExecution> {
    const errors = [...validateIntent(intent), ...validateCellRange(intent.target)];
    let capacityError: string | undefined;
    if (!errors.length) {
      try { capacityError = verificationCapacityError(intent, verificationBounds); }
      catch (error) { capacityError = error instanceof Error ? error.message : 'verification capacity could not be established'; }
    }
    if (capacityError) errors.push(capacityError);
    if (errors.length) return { status: 'rejected', dispatch: 'not-dispatched', reason: errors.join('; ') };

    const effect = classifyIntentEffect(intent);
    const beforeRevision = await this.backend.readRevision();
    const identity = await this.backend.readIdentity();
    const documentFreshness = checkDocumentFreshness(intent.document, identity.document);
    if (!documentFreshness.fresh) return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: documentFreshness.reason };
    const sheetFreshness = checkEntityFreshness(intent.target.sheet, identity);
    if (!sheetFreshness.fresh) return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: sheetFreshness.reason };

    let dispatch: 'dispatched' | 'uncertain' = 'uncertain';
    try {
      const result = await this.backend.dispatchSemanticEdit(intent);
      dispatch = result.dispatch === 'dispatched' ? 'dispatched' : 'uncertain';
    } catch {
      dispatch = 'uncertain';
    }

    let verification: PostEditVerification;
    try {
      const observation = await this.backend.observeCells(intent.target, verificationBounds);
      verification = verifyRange(await this.backend.readIdentity(), beforeRevision, intent, observation);
    } catch {
      verification = failedVerification();
    }
    if (dispatch === 'uncertain') return { status: 'uncertain', effect, dispatch, verification };
    return verification.status === 'verified' ? { status: 'verified', effect, dispatch, verification } : { status: 'verification-failed', effect, dispatch, verification };
  }
}

export class DeterministicSpreadsheetBackend implements SpreadsheetNativeBackend {
  private document: DocumentRef;
  private sheet: StructuredEntityRef;
  private cells = new Map<string, CellState>();
  private revision = 1;
  private dispatchCountValue = 0;
  private uncertainDispatch = false;
  constructor(documentId = 'local-spreadsheet') {
    this.document = { documentId, generation: 1, kind: 'spreadsheet' };
    this.sheet = { document: cloneDocument(this.document), kind: 'sheet', entityId: 'sheet-1', generation: 1 };
  }
  get dispatchCount(): number { return this.dispatchCountValue; }
  currentDocument(): DocumentRef { return cloneDocument(this.document); }
  sheetRef(): StructuredEntityRef { return cloneEntity(this.sheet); }
  cellRange(row: number, column: number): CellRange { return { sheet: this.sheetRef(), start: { row, column }, end: { row, column } }; }
  markNextDispatchUncertain(): void { this.uncertainDispatch = true; }
  replaceDocument(): DocumentRef { this.document = { ...this.document, generation: this.document.generation + 1 }; this.sheet = { ...cloneEntity(this.sheet), document: cloneDocument(this.document), generation: this.sheet.generation + 1 }; this.revision += 1; return this.currentDocument(); }
  replaceSheet(): StructuredEntityRef { this.sheet = { ...cloneEntity(this.sheet), generation: this.sheet.generation + 1 }; this.revision += 1; return this.sheetRef(); }
  seedCell(address: CellAddress, input: SpreadsheetCellInput, displayedValue?: string): void { this.cells.set(cellKey(address), { address: cloneAddress(address), input: cloneInput(input), ...(displayedValue === undefined ? {} : { displayedValue: `${displayedValue}` }) }); }
  async readIdentity(): Promise<DocumentIdentityState> { return { document: cloneDocument(this.document), entities: [{ kind: this.sheet.kind, entityId: this.sheet.entityId, generation: this.sheet.generation }] }; }
  async readRevision(): Promise<number> { return this.revision; }
  async observeCells(target: CellRange, bounds: ObservationBounds): Promise<ModelObservation> {
    const errors = [...validateObservationBounds(bounds), ...validateCellRange(target)]; if (errors.length) throw new Error(errors.join('; '));
    if (!sameStructuredEntityRef(target.sheet, this.sheet)) throw new Error('spreadsheet sheet is stale or missing');
    const total = totalCellCount(target); const cells: SpreadsheetCellState[] = []; let exposedBytes = 0; let exhausted = false;
    outer: for (let row = target.start.row; row <= target.end.row; row += 1) for (let column = target.start.column; column <= target.end.column; column += 1) {
      if (cells.length >= bounds.maxItems) break outer;
      const address = { row, column }; const state = this.cells.get(cellKey(address)) ?? { address, input: { kind: 'blank' } as const };
      const bytes = utf8Bytes(renderedInput(state.input)); if (bytes > bounds.maxTextBytes - exposedBytes) { exhausted = true; break outer; }
      exposedBytes += bytes; cells.push({ address: cloneAddress(state.address), input: cloneInput(state.input), ...(state.displayedValue === undefined ? {} : { displayedValue: `${state.displayedValue}` }) });
    }
    return { kind: 'cells', target: cloneEntity(this.sheet), revision: this.revision, cells, truncated: exhausted || cells.length < total };
  }
  async dispatchSemanticEdit(intent: SpreadsheetNativeEdit): Promise<SpreadsheetDispatchResult> {
    const edit = snapshotIntent(intent);
    const errors = validateCellRange(edit.target);
    if (errors.length) throw new Error(errors.join('; '));
    if (!sameStructuredEntityRef(edit.target.sheet, this.sheet)) throw new Error('spreadsheet sheet is stale or missing');
    const input = expectedInput(edit);
    const targets = addresses(edit.target);
    this.dispatchCountValue += 1;
    for (const address of targets) this.cells.set(cellKey(address), { address: cloneAddress(address), input: cloneInput(input) });
    this.revision += 1;
    const result: SpreadsheetDispatchResult = { dispatch: this.uncertainDispatch ? 'uncertain' : 'dispatched', revision: this.revision };
    this.uncertainDispatch = false;
    return { ...result };
  }
}
