import {
  checkDocumentFreshness,
  checkEntityFreshness,
  classifyIntentEffect,
  observeTextRange,
  sameStructuredEntityRef,
  validateCodeRange,
  validateIntent,
  verifyPostEdit,
  type CodeBufferRef,
  type CodeRange,
  type DocumentIdentityState,
  type DocumentRef,
  type EditCodeBufferIntent,
  type ModelObservation,
  type ObservationBounds,
  type PostEditVerification,
  type SemanticEffectClass,
  type TextRange,
  type VerificationExpectation,
} from '../computer/documentModels.js';

export interface ResolvedCodeRange {
  range: TextRange;
  revision: number;
}

export interface CodeBufferDispatchResult {
  dispatch: 'dispatched' | 'uncertain';
  revision: number;
}

export interface CodeBufferNativeBackend {
  readIdentity(): Promise<DocumentIdentityState>;
  readRevision(): Promise<number>;
  resolveCodeRange(range: CodeRange): Promise<ResolvedCodeRange>;
  observeText(target: CodeBufferRef, range: TextRange, bounds: ObservationBounds): Promise<ModelObservation>;
  dispatchSemanticEdit(intent: EditCodeBufferIntent): Promise<CodeBufferDispatchResult>;
}

export type CodeBufferExecution =
  | { status: 'verified'; effect: SemanticEffectClass; dispatch: 'dispatched'; verification: PostEditVerification }
  | { status: 'uncertain'; effect: SemanticEffectClass; dispatch: 'uncertain'; verification: PostEditVerification }
  | { status: 'rejected'; effect?: SemanticEffectClass; dispatch: 'not-dispatched'; reason: string }
  | { status: 'verification-failed'; effect: SemanticEffectClass; dispatch: 'dispatched'; verification: PostEditVerification };

function cloneDocument(ref: DocumentRef): DocumentRef {
  return { documentId: ref.documentId, generation: ref.generation, kind: ref.kind };
}

function cloneBuffer(ref: CodeBufferRef): CodeBufferRef {
  return {
    document: cloneDocument(ref.document),
    kind: 'code-buffer',
    entityId: ref.entityId,
    generation: ref.generation,
    ...(ref.parentEntityId === undefined ? {} : { parentEntityId: ref.parentEntityId }),
    ...(ref.languageId === undefined ? {} : { languageId: `${ref.languageId}` }),
  };
}

function cloneCodeRange(range: CodeRange): CodeRange {
  return {
    buffer: cloneBuffer(range.buffer),
    start: { line: range.start.line, column: range.start.column },
    end: { line: range.end.line, column: range.end.column },
  };
}

function snapshotIntent(intent: EditCodeBufferIntent): EditCodeBufferIntent {
  return {
    ...intent,
    document: cloneDocument(intent.document),
    target: cloneBuffer(intent.target),
    range: cloneCodeRange(intent.range),
    text: `${intent.text}`,
  };
}

function expectationFor(intent: EditCodeBufferIntent, resolved: TextRange): VerificationExpectation {
  return {
    kind: 'text-equals',
    target: intent.target,
    range: { start: resolved.start, end: resolved.start + intent.text.length },
    expected: intent.text,
  };
}

/** Native code-buffer controller. Editor model content is authoritative; UI selection/caret state is not. */
export class CodeBufferSemanticController {
  constructor(private readonly backend: CodeBufferNativeBackend) {}

  classify(intent: EditCodeBufferIntent): SemanticEffectClass {
    return classifyIntentEffect(intent);
  }

  execute(intent: EditCodeBufferIntent, verificationBounds: ObservationBounds): Promise<CodeBufferExecution> {
    const snapshot = snapshotIntent(intent);
    const bounds = { ...verificationBounds };
    return this.executeSnapshot(snapshot, bounds);
  }

  private async executeSnapshot(intent: EditCodeBufferIntent, verificationBounds: ObservationBounds): Promise<CodeBufferExecution> {
    const errors = [...validateIntent(intent), ...validateCodeRange(intent.range)];
    if (errors.length > 0) {
      return { status: 'rejected', dispatch: 'not-dispatched', reason: errors.join('; ') };
    }

    const effect = classifyIntentEffect(intent);
    const beforeRevision = await this.backend.readRevision();

    let resolved: ResolvedCodeRange;
    try {
      resolved = await this.backend.resolveCodeRange(intent.range);
    } catch (error) {
      return {
        status: 'rejected',
        effect,
        dispatch: 'not-dispatched',
        reason: error instanceof Error ? error.message : 'code range could not be resolved',
      };
    }
    if (resolved.revision !== beforeRevision) {
      return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: 'code-buffer-revision-changed-before-dispatch' };
    }

    // Fresh generation authority is the final awaited read before the exactly-one edit dispatch.
    const identity = await this.backend.readIdentity();
    const documentFreshness = checkDocumentFreshness(intent.document, identity.document);
    if (!documentFreshness.fresh) {
      return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: documentFreshness.reason };
    }
    const bufferFreshness = checkEntityFreshness(intent.target, identity);
    if (!bufferFreshness.fresh) {
      return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: bufferFreshness.reason };
    }

    const backendResult = await this.backend.dispatchSemanticEdit(intent);
    const dispatch = backendResult.dispatch === 'dispatched' ? 'dispatched' : 'uncertain';

    const expectation = expectationFor(intent, resolved.range);
    const observation = await this.backend.observeText(intent.target, expectation.range, verificationBounds);
    const verificationIdentity = await this.backend.readIdentity();
    const verification = verifyPostEdit({ identity: verificationIdentity, beforeRevision, expectation, observation });

    if (dispatch === 'uncertain') return { status: 'uncertain', effect, dispatch, verification };
    if (verification.status === 'verified') return { status: 'verified', effect, dispatch, verification };
    return { status: 'verification-failed', effect, dispatch, verification };
  }
}

/** Deterministic local code/editor backend using native line/column semantics. */
export class DeterministicCodeBufferBackend implements CodeBufferNativeBackend {
  private document: DocumentRef;
  private buffer: CodeBufferRef;
  private text: string;
  private revision = 1;
  private dispatchCountValue = 0;
  private uncertainDispatch = false;

  constructor(documentId = 'local-code-workspace', text = '', languageId = 'plaintext') {
    this.document = { documentId, generation: 1, kind: 'code-workspace' };
    this.buffer = {
      document: cloneDocument(this.document),
      kind: 'code-buffer',
      entityId: 'buffer-1',
      generation: 1,
      languageId,
    };
    this.text = `${text}`;
  }

  get dispatchCount(): number {
    return this.dispatchCountValue;
  }

  currentDocument(): DocumentRef {
    return cloneDocument(this.document);
  }

  bufferRef(): CodeBufferRef {
    return cloneBuffer(this.buffer);
  }

  currentText(): string {
    return `${this.text}`;
  }

  markNextDispatchUncertain(): void {
    this.uncertainDispatch = true;
  }

  replaceDocument(): DocumentRef {
    this.document = { ...this.document, generation: this.document.generation + 1 };
    this.buffer = { ...cloneBuffer(this.buffer), document: cloneDocument(this.document), generation: this.buffer.generation + 1 };
    this.revision += 1;
    return this.currentDocument();
  }

  replaceBuffer(): CodeBufferRef {
    this.buffer = { ...cloneBuffer(this.buffer), generation: this.buffer.generation + 1 };
    this.revision += 1;
    return this.bufferRef();
  }

  mutateTextBeforeDispatch(text: string): void {
    this.text = `${text}`;
    this.revision += 1;
  }

  async readIdentity(): Promise<DocumentIdentityState> {
    return {
      document: cloneDocument(this.document),
      entities: [{ kind: this.buffer.kind, entityId: this.buffer.entityId, generation: this.buffer.generation }],
    };
  }

  async readRevision(): Promise<number> {
    return this.revision;
  }

  async resolveCodeRange(range: CodeRange): Promise<ResolvedCodeRange> {
    if (!sameStructuredEntityRef(range.buffer, this.buffer)) throw new Error('code buffer is stale or missing');
    const errors = validateCodeRange(range);
    if (errors.length > 0) throw new Error(errors.join('; '));
    return { range: this.offsetRange(range), revision: this.revision };
  }

  async observeText(target: CodeBufferRef, range: TextRange, bounds: ObservationBounds): Promise<ModelObservation> {
    if (!sameStructuredEntityRef(target, this.buffer)) throw new Error('code buffer is stale or missing');
    return {
      kind: 'text',
      target: cloneBuffer(this.buffer),
      revision: this.revision,
      observation: observeTextRange(this.text, { ...range }, { ...bounds }),
    };
  }

  async dispatchSemanticEdit(intent: EditCodeBufferIntent): Promise<CodeBufferDispatchResult> {
    const edit = snapshotIntent(intent);
    if (!sameStructuredEntityRef(edit.target, this.buffer)) throw new Error('code buffer is stale or missing');
    const resolved = this.offsetRange(edit.range);

    this.dispatchCountValue += 1;
    this.text = this.text.slice(0, resolved.start) + edit.text + this.text.slice(resolved.end);
    this.revision += 1;

    const result: CodeBufferDispatchResult = {
      dispatch: this.uncertainDispatch ? 'uncertain' : 'dispatched',
      revision: this.revision,
    };
    this.uncertainDispatch = false;
    return { ...result };
  }

  private offsetRange(range: CodeRange): TextRange {
    return { start: this.offsetFor(range.start.line, range.start.column), end: this.offsetFor(range.end.line, range.end.column) };
  }

  private offsetFor(line: number, column: number): number {
    const lines = this.text.split('\n');
    if (line >= lines.length) throw new Error('code range line exceeds buffer');
    const lineText = lines[line] ?? '';
    if (column > lineText.length) throw new Error('code range column exceeds line');
    let offset = 0;
    for (let index = 0; index < line; index += 1) offset += (lines[index]?.length ?? 0) + 1;
    return offset + column;
  }
}
