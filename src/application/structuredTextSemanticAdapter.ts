import {
  checkDocumentFreshness,
  checkEntityFreshness,
  classifyIntentEffect,
  observeBoundedItems,
  observeTextRange,
  sameStructuredEntityRef,
  validateIntent,
  validateObservationBounds,
  verifyPostEdit,
  type DocumentIdentityState,
  type DocumentRef,
  type InsertTextIntent,
  type ModelObservation,
  type ObservationBounds,
  type PostEditVerification,
  type ReplaceTextIntent,
  type SaveDocumentIntent,
  type SemanticEditIntent,
  type SemanticEffectClass,
  type StructuredEntityRef,
  type TextFormattingPatch,
  type TextRange,
  type VerificationExpectation,
} from '../computer/documentModels.js';

export interface StructuredTextObservationBounds extends ObservationBounds { maxDepth: number }
export interface StructuredTextFormattingRun { range: TextRange; formatting: TextFormattingPatch }
export interface StructuredTextSectionObservation {
  ref: StructuredEntityRef;
  text?: string;
  formattingRuns?: readonly StructuredTextFormattingRun[];
  truncated: boolean;
}
export interface StructuredTextDocumentObservation {
  document: DocumentRef;
  revision: number;
  sections: readonly StructuredTextSectionObservation[];
  totalSections: number;
  truncated: boolean;
  omittedSections: number;
}
export type StructuredTextNativeEdit = InsertTextIntent | ReplaceTextIntent | SaveDocumentIntent;
export interface StructuredTextDispatchResult { dispatch: 'dispatched' | 'uncertain'; revision: number }
export interface StructuredTextNativeBackend {
  readIdentity(): Promise<DocumentIdentityState>;
  readRevision(): Promise<number>;
  observeDocument(bounds: StructuredTextObservationBounds): Promise<StructuredTextDocumentObservation>;
  observeText(target: StructuredEntityRef, range: TextRange, bounds: ObservationBounds): Promise<ModelObservation>;
  observeSavedState(target: DocumentRef): Promise<ModelObservation>;
  dispatchSemanticEdit(intent: StructuredTextNativeEdit): Promise<StructuredTextDispatchResult>;
}
export type StructuredTextExecution =
  | { status: 'verified'; effect: SemanticEffectClass; dispatch: 'dispatched'; verification: PostEditVerification }
  | { status: 'uncertain'; effect: SemanticEffectClass; dispatch: 'uncertain'; verification: PostEditVerification }
  | { status: 'rejected'; effect?: SemanticEffectClass; dispatch: 'not-dispatched'; reason: string }
  | { status: 'verification-failed'; effect: SemanticEffectClass; dispatch: 'dispatched'; verification: PostEditVerification };

interface SectionState { ref: StructuredEntityRef; text: string; formattingRuns: StructuredTextFormattingRun[] }
const cloneDocument = (ref: DocumentRef): DocumentRef => ({ ...ref });
const cloneEntity = (ref: StructuredEntityRef): StructuredEntityRef => ({ ...ref, document: cloneDocument(ref.document) });
const cloneRun = (run: StructuredTextFormattingRun): StructuredTextFormattingRun => ({ range: { ...run.range }, formatting: { ...run.formatting } });
function snapshotIntent(intent: StructuredTextNativeEdit): StructuredTextNativeEdit {
  if (intent.kind === 'save-document') return { ...intent, document: cloneDocument(intent.document) };
  if (intent.kind === 'insert-text') return { ...intent, document: cloneDocument(intent.document), target: cloneEntity(intent.target), text: `${intent.text}` };
  return { ...intent, document: cloneDocument(intent.document), target: cloneEntity(intent.target), range: { ...intent.range }, text: `${intent.text}` };
}
function validateDepth(maxDepth: number): void {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 64) throw new Error('maxDepth must be a bounded non-negative safe integer');
}
function replacementRange(intent: InsertTextIntent | ReplaceTextIntent): TextRange {
  return intent.kind === 'insert-text' ? { start: intent.at, end: intent.at + intent.text.length } : { start: intent.range.start, end: intent.range.start + intent.text.length };
}
function expectationFor(intent: StructuredTextNativeEdit, beforeRevision: number): VerificationExpectation {
  return intent.kind === 'save-document'
    ? { kind: 'saved-revision-at-least', target: intent.document, minimumRevision: beforeRevision }
    : { kind: 'text-equals', target: intent.target, range: replacementRange(intent), expected: intent.text };
}
const failedVerification = (): PostEditVerification => ({ status: 'insufficient-observation', evidence: ['post-dispatch-observation-failed'] });

export class StructuredTextSemanticController {
  constructor(private readonly backend: StructuredTextNativeBackend) {}
  classify(intent: SemanticEditIntent): SemanticEffectClass { return classifyIntentEffect(intent); }
  observe(bounds: StructuredTextObservationBounds): Promise<StructuredTextDocumentObservation> { return this.backend.observeDocument({ ...bounds }); }
  execute(intent: StructuredTextNativeEdit, verificationBounds: ObservationBounds): Promise<StructuredTextExecution> {
    return this.executeSnapshot(snapshotIntent(intent), { ...verificationBounds });
  }
  private async executeSnapshot(intent: StructuredTextNativeEdit, verificationBounds: ObservationBounds): Promise<StructuredTextExecution> {
    const errors = [...validateIntent(intent), ...validateObservationBounds(verificationBounds)];
    if (errors.length) return { status: 'rejected', dispatch: 'not-dispatched', reason: errors.join('; ') };
    const effect = classifyIntentEffect(intent);
    const beforeRevision = await this.backend.readRevision();
    const identity = await this.backend.readIdentity();
    const documentFreshness = checkDocumentFreshness(intent.document, identity.document);
    if (!documentFreshness.fresh) return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: documentFreshness.reason };
    if (intent.kind !== 'save-document') {
      const entityFreshness = checkEntityFreshness(intent.target, identity);
      if (!entityFreshness.fresh) return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: entityFreshness.reason };
    }

    let dispatch: 'dispatched' | 'uncertain' = 'uncertain';
    try {
      const result = await this.backend.dispatchSemanticEdit(intent);
      dispatch = result.dispatch === 'dispatched' ? 'dispatched' : 'uncertain';
    } catch {
      dispatch = 'uncertain';
    }

    const expectation = expectationFor(intent, beforeRevision);
    let verification: PostEditVerification;
    try {
      const observation = intent.kind === 'save-document'
        ? await this.backend.observeSavedState(intent.document)
        : await this.backend.observeText(intent.target, expectation.kind === 'text-equals' ? expectation.range : { start: 0, end: 0 }, verificationBounds);
      verification = verifyPostEdit({ identity: await this.backend.readIdentity(), beforeRevision, expectation, observation });
    } catch {
      verification = failedVerification();
    }

    if (dispatch === 'uncertain') return { status: 'uncertain', effect, dispatch, verification };
    return verification.status === 'verified'
      ? { status: 'verified', effect, dispatch, verification }
      : { status: 'verification-failed', effect, dispatch, verification };
  }
}

export class DeterministicStructuredTextBackend implements StructuredTextNativeBackend {
  private document: DocumentRef;
  private sections: SectionState[];
  private revision = 1;
  private savedRevision = 0;
  private dispatchCountValue = 0;
  private uncertainDispatch = false;
  constructor(documentId = 'local-document', sectionTexts: readonly string[] = ['']) {
    this.document = { documentId, generation: 1, kind: 'word-processing' };
    this.sections = sectionTexts.map((text, index) => ({
      ref: { document: cloneDocument(this.document), kind: 'section', entityId: `section-${index + 1}`, generation: 1 },
      text: `${text}`,
      formattingRuns: [],
    }));
  }
  get dispatchCount(): number { return this.dispatchCountValue; }
  currentDocument(): DocumentRef { return cloneDocument(this.document); }
  sectionRef(index = 0): StructuredEntityRef {
    const section = this.sections[index];
    if (!section) throw new Error('section index out of range');
    return cloneEntity(section.ref);
  }
  markNextDispatchUncertain(): void { this.uncertainDispatch = true; }
  replaceDocument(): DocumentRef {
    this.document = { ...this.document, generation: this.document.generation + 1 };
    this.revision += 1;
    this.sections = this.sections.map(section => ({ ...section, ref: { ...cloneEntity(section.ref), document: cloneDocument(this.document), generation: section.ref.generation + 1 }, formattingRuns: section.formattingRuns.map(cloneRun) }));
    return this.currentDocument();
  }
  replaceSection(index = 0): StructuredEntityRef {
    const section = this.sections[index];
    if (!section) throw new Error('section index out of range');
    section.ref = { ...cloneEntity(section.ref), generation: section.ref.generation + 1 };
    this.revision += 1;
    return cloneEntity(section.ref);
  }
  async readIdentity(): Promise<DocumentIdentityState> {
    return { document: cloneDocument(this.document), entities: this.sections.map(({ ref }) => ({ kind: ref.kind, entityId: ref.entityId, generation: ref.generation })) };
  }
  async readRevision(): Promise<number> { return this.revision; }
  async observeDocument(bounds: StructuredTextObservationBounds): Promise<StructuredTextDocumentObservation> {
    validateDepth(bounds.maxDepth);
    const projected = observeBoundedItems(this.sections, bounds, section => bounds.maxDepth === 0 ? section.ref.entityId : `${section.ref.entityId}\n${section.text}`);
    const visibleIds = new Set(projected.items.map(item => item.split('\n', 1)[0]));
    return {
      document: cloneDocument(this.document), revision: this.revision,
      sections: this.sections.filter(section => visibleIds.has(section.ref.entityId)).map(section => ({ ref: cloneEntity(section.ref), ...(bounds.maxDepth >= 1 ? { text: section.text, formattingRuns: section.formattingRuns.map(cloneRun) } : {}), truncated: bounds.maxDepth < 1 })),
      totalSections: this.sections.length, truncated: projected.truncated || bounds.maxDepth < 1, omittedSections: projected.omittedItems,
    };
  }
  async observeText(target: StructuredEntityRef, range: TextRange, bounds: ObservationBounds): Promise<ModelObservation> {
    const section = this.findSection(target);
    return { kind: 'text', target: cloneEntity(section.ref), revision: this.revision, observation: observeTextRange(section.text, { ...range }, { ...bounds }) };
  }
  async observeSavedState(target: DocumentRef): Promise<ModelObservation> {
    return { kind: 'saved-state', target: cloneDocument(target), revision: this.revision, savedRevision: this.savedRevision };
  }
  async dispatchSemanticEdit(intent: StructuredTextNativeEdit): Promise<StructuredTextDispatchResult> {
    const edit = snapshotIntent(intent);
    this.dispatchCountValue += 1;
    if (edit.kind === 'save-document') {
      this.revision += 1; this.savedRevision = this.revision;
    } else {
      const section = this.findSection(edit.target);
      if (edit.kind === 'insert-text') {
        if (edit.at > section.text.length) throw new Error('insert offset exceeds section text length');
        section.text = section.text.slice(0, edit.at) + edit.text + section.text.slice(edit.at);
      } else {
        if (edit.range.end > section.text.length) throw new Error('replace range exceeds section text length');
        section.text = section.text.slice(0, edit.range.start) + edit.text + section.text.slice(edit.range.end);
      }
      this.revision += 1;
    }
    const result = { dispatch: this.uncertainDispatch ? 'uncertain' as const : 'dispatched' as const, revision: this.revision };
    this.uncertainDispatch = false;
    return { ...result };
  }
  private findSection(target: StructuredEntityRef): SectionState {
    const section = this.sections.find(candidate => sameStructuredEntityRef(candidate.ref, target));
    if (!section) throw new Error('structured text section is stale or missing');
    return section;
  }
}
