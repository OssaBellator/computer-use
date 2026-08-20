import {
  checkDocumentFreshness,
  checkEntityFreshness,
  classifyIntentEffect,
  sameStructuredEntityRef,
  utf8Bytes,
  validateCellRange,
  validateIntent,
  validateObservationBounds,
  verifyPostEdit,
  type CellAddress,
  type CellRange,
  type DocumentIdentityState,
  type DocumentRef,
  type ModelObservation,
  type ObservationBounds,
  type PostEditVerification,
  type SemanticEffectClass,
  type SetCellFormulaIntent,
  type SetCellValueIntent,
  type SpreadsheetCellInput,
  type SpreadsheetCellState,
  type StructuredEntityRef,
  type VerificationExpectation,
} from '../computer/documentModels.js';

export type SpreadsheetNativeEdit = SetCellValueIntent | SetCellFormulaIntent;

export interface SpreadsheetDispatchResult {
  dispatch: 'dispatched' | 'uncertain';
  revision: number;
}

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

interface CellState {
  address: CellAddress;
  input: SpreadsheetCellInput;
  displayedValue?: string;
}

function cloneDocument(ref: DocumentRef): DocumentRef {
  return { documentId: ref.documentId, generation: ref.generation, kind: ref.kind };
}

function cloneEntity(ref: StructuredEntityRef): StructuredEntityRef {
  return {
    document: cloneDocument(ref.document),
    kind: ref.kind,
    entityId: ref.entityId,
    generation: ref.generation,
    ...(ref.parentEntityId === undefined ? {} : { parentEntityId: ref.parentEntityId }),
  };
}

function cloneAddress(address: CellAddress): CellAddress {
  return { row: address.row, column: address.column };
}

function cloneRange(range: CellRange): CellRange {
  return { sheet: cloneEntity(range.sheet), start: cloneAddress(range.start), end: cloneAddress(range.end) };
}

function cloneInput(input: SpreadsheetCellInput): SpreadsheetCellInput {
  if (input.kind === 'blank') return { kind: 'blank' };
  if (input.kind === 'formula') return { kind: 'formula', formula: `${input.formula}` };
  return { kind: 'value', value: typeof input.value === 'string' ? `${input.value}` : input.value };
}

function snapshotIntent(intent: SpreadsheetNativeEdit): SpreadsheetNativeEdit {
  if (intent.kind === 'set-cell-formula') {
    return {
      ...intent,
      document: cloneDocument(intent.document),
      target: cloneRange(intent.target),
      formula: `${intent.formula}`,
    };
  }
  return {
    ...intent,
    document: cloneDocument(intent.document),
    target: cloneRange(intent.target),
    value: typeof intent.value === 'string' ? `${intent.value}` : intent.value,
  };
}

function isSingleCell(range: CellRange): boolean {
  return range.start.row === range.end.row && range.start.column === range.end.column;
}

function expectedInput(intent: SpreadsheetNativeEdit): SpreadsheetCellInput {
  return intent.kind === 'set-cell-formula'
    ? { kind: 'formula', formula: intent.formula }
    : { kind: 'value', value: intent.value };
}

function expectationFor(intent: SpreadsheetNativeEdit): VerificationExpectation {
  return {
    kind: 'cell-input-equals',
    target: intent.target.sheet,
    address: cloneAddress(intent.target.start),
    expected: expectedInput(intent),
  };
}

function cellKey(address: CellAddress): string {
  return `${address.row}:${address.column}`;
}

function renderedInput(input: SpreadsheetCellInput): string {
  if (input.kind === 'blank') return '';
  if (input.kind === 'formula') return `=${input.formula}`;
  return input.value === null ? 'null' : String(input.value);
}

function totalCellCount(range: CellRange): number {
  const rows = range.end.row - range.start.row + 1;
  const columns = range.end.column - range.start.column + 1;
  const total = rows * columns;
  if (!Number.isSafeInteger(total) || total < 1) throw new Error('cell observation range is too large');
  return total;
}

/** Native spreadsheet controller: model cells, not UI pixels, are the semantic source of truth. */
export class SpreadsheetSemanticController {
  constructor(private readonly backend: SpreadsheetNativeBackend) {}

  classify(intent: SpreadsheetNativeEdit): SemanticEffectClass {
    return classifyIntentEffect(intent);
  }

  execute(intent: SpreadsheetNativeEdit, verificationBounds: ObservationBounds): Promise<SpreadsheetExecution> {
    const snapshot = snapshotIntent(intent);
    const bounds = { ...verificationBounds };
    return this.executeSnapshot(snapshot, bounds);
  }

  private async executeSnapshot(intent: SpreadsheetNativeEdit, verificationBounds: ObservationBounds): Promise<SpreadsheetExecution> {
    const errors = [...validateIntent(intent), ...validateCellRange(intent.target)];
    if (!isSingleCell(intent.target)) errors.push('spreadsheet semantic edits currently require a single-cell target');
    if (errors.length > 0) {
      return { status: 'rejected', dispatch: 'not-dispatched', reason: errors.join('; ') };
    }

    const effect = classifyIntentEffect(intent);
    const beforeRevision = await this.backend.readRevision();

    // Fresh generation authority is the final awaited read before the one semantic edit dispatch.
    const identity = await this.backend.readIdentity();
    const documentFreshness = checkDocumentFreshness(intent.document, identity.document);
    if (!documentFreshness.fresh) {
      return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: documentFreshness.reason };
    }
    const sheetFreshness = checkEntityFreshness(intent.target.sheet, identity);
    if (!sheetFreshness.fresh) {
      return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: sheetFreshness.reason };
    }

    const backendResult = await this.backend.dispatchSemanticEdit(intent);
    const dispatch = backendResult.dispatch === 'dispatched' ? 'dispatched' : 'uncertain';

    const expectation = expectationFor(intent);
    const observation = await this.backend.observeCells(intent.target, verificationBounds);
    const verificationIdentity = await this.backend.readIdentity();
    const verification = verifyPostEdit({ identity: verificationIdentity, beforeRevision, expectation, observation });

    if (dispatch === 'uncertain') return { status: 'uncertain', effect, dispatch, verification };
    if (verification.status === 'verified') return { status: 'verified', effect, dispatch, verification };
    return { status: 'verification-failed', effect, dispatch, verification };
  }
}

/** Deterministic in-memory spreadsheet backend for local semantic workflows and tests. */
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

  get dispatchCount(): number {
    return this.dispatchCountValue;
  }

  currentDocument(): DocumentRef {
    return cloneDocument(this.document);
  }

  sheetRef(): StructuredEntityRef {
    return cloneEntity(this.sheet);
  }

  cellRange(row: number, column: number): CellRange {
    return { sheet: this.sheetRef(), start: { row, column }, end: { row, column } };
  }

  markNextDispatchUncertain(): void {
    this.uncertainDispatch = true;
  }

  replaceDocument(): DocumentRef {
    this.document = { ...this.document, generation: this.document.generation + 1 };
    this.sheet = { ...cloneEntity(this.sheet), document: cloneDocument(this.document), generation: this.sheet.generation + 1 };
    this.revision += 1;
    return this.currentDocument();
  }

  replaceSheet(): StructuredEntityRef {
    this.sheet = { ...cloneEntity(this.sheet), generation: this.sheet.generation + 1 };
    this.revision += 1;
    return this.sheetRef();
  }

  seedCell(address: CellAddress, input: SpreadsheetCellInput, displayedValue?: string): void {
    this.cells.set(cellKey(address), {
      address: cloneAddress(address),
      input: cloneInput(input),
      ...(displayedValue === undefined ? {} : { displayedValue: `${displayedValue}` }),
    });
  }

  async readIdentity(): Promise<DocumentIdentityState> {
    return {
      document: cloneDocument(this.document),
      entities: [{ kind: this.sheet.kind, entityId: this.sheet.entityId, generation: this.sheet.generation }],
    };
  }

  async readRevision(): Promise<number> {
    return this.revision;
  }

  async observeCells(target: CellRange, bounds: ObservationBounds): Promise<ModelObservation> {
    const errors = [...validateObservationBounds(bounds), ...validateCellRange(target)];
    if (errors.length > 0) throw new Error(errors.join('; '));
    if (!sameStructuredEntityRef(target.sheet, this.sheet)) throw new Error('spreadsheet sheet is stale or missing');

    const total = totalCellCount(target);
    const cells: SpreadsheetCellState[] = [];
    let exposedBytes = 0;
    let exhaustedBudget = false;

    outer: for (let row = target.start.row; row <= target.end.row; row += 1) {
      for (let column = target.start.column; column <= target.end.column; column += 1) {
        if (cells.length >= bounds.maxItems) break outer;
        const address = { row, column };
        const state = this.cells.get(cellKey(address)) ?? { address, input: { kind: 'blank' } as const };
        const projectedBytes = utf8Bytes(renderedInput(state.input));
        if (projectedBytes > bounds.maxTextBytes - exposedBytes) {
          exhaustedBudget = true;
          break outer;
        }
        exposedBytes += projectedBytes;
        cells.push({
          address: cloneAddress(state.address),
          input: cloneInput(state.input),
          ...(state.displayedValue === undefined ? {} : { displayedValue: `${state.displayedValue}` }),
        });
      }
    }

    return {
      kind: 'cells',
      target: cloneEntity(this.sheet),
      revision: this.revision,
      cells,
      truncated: exhaustedBudget || cells.length < total,
    };
  }

  async dispatchSemanticEdit(intent: SpreadsheetNativeEdit): Promise<SpreadsheetDispatchResult> {
    const edit = snapshotIntent(intent);
    if (!isSingleCell(edit.target)) throw new Error('spreadsheet backend requires a single-cell edit');
    if (!sameStructuredEntityRef(edit.target.sheet, this.sheet)) throw new Error('spreadsheet sheet is stale or missing');

    this.dispatchCountValue += 1;
    const address = cloneAddress(edit.target.start);
    const input = expectedInput(edit);
    this.cells.set(cellKey(address), { address, input: cloneInput(input) });
    this.revision += 1;

    const result: SpreadsheetDispatchResult = {
      dispatch: this.uncertainDispatch ? 'uncertain' : 'dispatched',
      revision: this.revision,
    };
    this.uncertainDispatch = false;
    return { ...result };
  }
}
