import {
  checkDocumentFreshness,
  checkEntityFreshness,
  classifyIntentEffect,
  observeBoundedItems,
  observeTextRange,
  sameStructuredEntityRef,
  validateIntent,
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

export interface StructuredTextObservationBounds extends ObservationBounds {
  /** Root is depth 0; section metadata/text is depth 1. */
  maxDepth: number;
}

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

export interface StructuredTextFormattingRun {
  range: TextRange;
  formatting: TextFormattingPatch;
}

export type StructuredTextNativeEdit = InsertTextIntent | ReplaceTextIntent | SaveDocumentIntent;

export interface StructuredTextDispatchResult {
  dispatch: 'dispatched' | 'uncertain';
  revision: number;
}

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

interface SectionState {
  ref: StructuredEntityRef;
  text: string;
  formattingRuns: StructuredTextFormattingRun[];
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

function cloneFormatting(formatting: TextFormattingPatch): TextFormattingPatch {
  return { ...formatting };
}

function cloneRun(run: StructuredTextFormattingRun): StructuredTextFormattingRun {
  return { range: { ...run.range }, formatting: cloneFormatting(run.formatting) };
}

function snapshotIntent(intent: StructuredTextNativeEdit): StructuredTextNativeEdit {
  if (intent.kind === 'save-document') {
    return { ...intent, document: cloneDocument(intent.document) };
  }
  if (intent.kind === 'insert-text') {
    return {
      ...intent,
      document: cloneDocument(intent.document),
      target: cloneEntity(intent.target),
      text: `${intent.text}`,
    };
  }
  return {
    ...intent,
    document: cloneDocument(intent.document),
    target: cloneEntity(intent.target),
    range: { ...intent.range },
    text: `${intent.text}`,
  };
}

function validateDepth(maxDepth: number): void {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 64) {
    throw new Error('maxDepth must be a bounded non-negative safe integer');
  }
}

function replacementRange(intent: InsertTextIntent | ReplaceTextIntent): TextRange {
  return intent.kind === 'insert-text'
    ? { start: intent.at, end: intent.at + intent.text.length }
    : { start: intent.range.start, end: intent.range.start + intent.text.length };
}

function expectationFor(intent: StructuredTextNativeEdit, beforeRevision: number): VerificationExpectation {
  if (intent.kind === 'save-document') {
    return { kind: 'saved-revision-at-least', target: intent.document, minimumRevision: beforeRevision };
  }
  return {
    kind: 'text-equals',
    target: intent.target,
    range: replacementRange(intent),
    expected: intent.text,
  };
}

/**
 * Concrete deterministic application-semantic controller for a native structured-text model.
 * Native structure is the semantic source of truth; UI/accessibility/visual mechanisms remain peers.
 */
export class StructuredTextSemanticController {
  constructor(private readonly backend: StructuredTextNativeBackend) {}

  classify(intent: SemanticEditIntent): SemanticEffectClass {
    return classifyIntentEffect(intent);
  }

  observe(bounds: StructuredTextObservationBounds): Promise<StructuredTextDocumentObservation> {
    return this.backend.observeDocument({ ...bounds });
  }

  execute(intent: StructuredTextNativeEdit, verificationBounds: ObservationBounds): Promise<StructuredTextExecution> {
    // Snapshot all caller-owned edit material synchronously before the first await.
    const snapshot = snapshotIntent(intent);
    const bounds = { ...verificationBounds };
    return this.executeSnapshot(snapshot, bounds);
  }

  private async executeSnapshot(
    intent: StructuredTextNativeEdit,
    verificationBounds: ObservationBounds,
  ): Promise<StructuredTextExecution> {
    const errors = validateIntent(intent);
    if (errors.length > 0) {
      return { status: 'rejected', dispatch: 'not-dispatched', reason: errors.join('; ') };
    }

    const effect = classifyIntentEffect(intent);
    const beforeRevision = await this.backend.readRevision();

    // Final await before dispatch: generation authority is freshly revalidated immediately before the edit.
    const identity = await this.backend.readIdentity();
    const documentFreshness = checkDocumentFreshness(intent.document, identity.document);
    if (!documentFreshness.fresh) {
      return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: documentFreshness.reason };
    }
    if (intent.kind !== 'save-document') {
      const entityFreshness = checkEntityFreshness(intent.target, identity);
      if (!entityFreshness.fresh) {
        return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: entityFreshness.reason };
      }
    }

    // Exactly one semantic side-effect dispatch. Snapshot the backend-owned outcome before any later await.
    const dispatchResult = await this.backend.dispatchSemanticEdit(intent);
    const dispatch = dispatchResult.dispatch === 'dispatched' ? 'dispatched' : 'uncertain';

    const expectation = expectationFor(intent, beforeRevision);
    const observation = intent.kind === 'save-document'
      ? await this.backend.observeSavedState(intent.document)
      : await this.backend.observeText(intent.target, expectation.kind === 'text-equals' ? expectation.range : { start: 0, end: 0 }, verificationBounds);
    const verificationIdentity = await this.backend.readIdentity();
    const verification = verifyPostEdit({ identity: verificationIdentity, beforeRevision, expectation, observation });

    // An uncertain side-effect outcome is never replayed automatically, even if model verification succeeds.
    if (dispatch === 'uncertain') {
      return { status: 'uncertain', effect, dispatch: 'uncertain', verification };
    }
    if (verification.status === 'verified') {
      return { status: 'verified', effect, dispatch: 'dispatched', verification };
    }
    return { status: 'verification-failed', effect, dispatch: 'dispatched', verification };
  }
}

/** In-memory native structured-document backend for deterministic local semantic workflows/tests. */
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
      ref: {
        document: cloneDocument(this.document),
        kind: 'section',
        entityId: `section-${index + 1}`,
        generation: 1,
      },
      text: `${text}`,
      formattingRuns: [],
    }));
  }

  get dispatchCount(): number {
    return this.dispatchCountValue;
  }

  currentDocument(): DocumentRef {
    return cloneDocument(this.document);
  }

  sectionRef(index = 0): StructuredEntityRef {
    const section = this.sections[index];
    if (!section) throw new Error('section index out of range');
    return cloneEntity(section.ref);
  }

  markNextDispatchUncertain(): void {
    this.uncertainDispatch = true;
  }

  replaceDocument(): DocumentRef {
    this.document = { ...this.document, generation: this.document.generation + 1 };
    this.revision += 1;
    this.sections = this.sections.map(section => ({
      ...section,
      ref: {
        ...cloneEntity(section.ref),
        document: cloneDocument(this.document),
        generation: section.ref.generation + 1,
      },
      formattingRuns: section.formattingRuns.map(cloneRun),
    }));
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
    return {
      document: cloneDocument(this.document),
      entities: this.sections.map(section => ({
        kind: section.ref.kind,
        entityId: section.ref.entityId,
        generation: section.ref.generation,
      })),
    };
  }

  async readRevision(): Promise<number> {
    return this.revision;
  }

  async observeDocument(bounds: StructuredTextObservationBounds): Promise<StructuredTextDocumentObservation> {
    validateDepth(bounds.maxDepth);
    const projected = observeBoundedItems(
      this.sections,
      bounds,
      section => bounds.maxDepth === 0 ? section.ref.entityId : `${section.ref.entityId}\n${section.text}`,
    );
    const visibleIds = new Set(projected.items.map(item => item.split('\n', 1)[0]));
    const sections = this.sections
      .filter(section => visibleIds.has(section.ref.entityId))
      .map(section => ({
        ref: cloneEntity(section.ref),
        ...(bounds.maxDepth >= 1
          ? { text: section.text, formattingRuns: section.formattingRuns.map(cloneRun) }
          : {}),
        truncated: bounds.maxDepth < 1,
      }));
    return {
      document: cloneDocument(this.document),
      revision: this.revision,
      sections,
      totalSections: this.sections.length,
      truncated: projected.truncated || bounds.maxDepth < 1,
      omittedSections: projected.omittedItems,
    };
  }

  async observeText(target: StructuredEntityRef, range: TextRange, bounds: ObservationBounds): Promise<ModelObservation> {
    const section = this.findSection(target);
    return {
      kind: 'text',
      target: cloneEntity(section.ref),
      revision: this.revision,
      observation: observeTextRange(section.text, { ...range }, { ...bounds }),
    };
  }

  async observeSavedState(target: DocumentRef): Promise<ModelObservation> {
    return {
      kind: 'saved-state',
      target: cloneDocument(target),
      revision: this.revision,
      savedRevision: this.savedRevision,
    };
  }

  async dispatchSemanticEdit(intent: StructuredTextNativeEdit): Promise<StructuredTextDispatchResult> {
    // Snapshot again at the native boundary so later caller/result mutation cannot alter the applied edit.
    const edit = snapshotIntent(intent);
    this.dispatchCountValue += 1;

    if (edit.kind === 'save-document') {
      this.revision += 1;
      this.savedRevision = this.revision;
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

    const result: StructuredTextDispatchResult = {
      dispatch: this.uncertainDispatch ? 'uncertain' : 'dispatched',
      revision: this.revision,
    };
    this.uncertainDispatch = false;
    return { ...result };
  }

  private findSection(target: StructuredEntityRef): SectionState {
    const section = this.sections.find(candidate => sameStructuredEntityRef(candidate.ref, target));
    if (!section) throw new Error('structured text section is stale or missing');
    return section;
  }
}
