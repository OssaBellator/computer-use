import {
  checkDocumentFreshness, classifyIntentEffect, validateIntent, verifyPostEdit,
  type DocumentIdentityState, type DocumentKind, type DocumentRef, type ModelObservation,
  type PostEditVerification, type SaveDocumentIntent, type SemanticEditIntent,
  type SemanticEffectClass, type VerificationExpectation,
} from '../computer/documentModels.js';

export interface LocalSaveDispatchResult { dispatch: 'dispatched' | 'uncertain'; revision: number }
export interface LocalDocumentPersistenceBackend {
  readIdentity(): Promise<DocumentIdentityState>;
  readRevision(): Promise<number>;
  observeSavedState(target: DocumentRef): Promise<ModelObservation>;
  dispatchLocalSave(intent: SaveDocumentIntent): Promise<LocalSaveDispatchResult>;
}
export type LocalSaveExecution =
  | { status: 'verified'; effect: 'local-persistence'; dispatch: 'dispatched'; verification: PostEditVerification }
  | { status: 'uncertain'; effect: 'local-persistence'; dispatch: 'uncertain'; verification: PostEditVerification }
  | { status: 'rejected'; effect?: 'local-persistence'; dispatch: 'not-dispatched'; reason: string }
  | { status: 'verification-failed'; effect: 'local-persistence'; dispatch: 'dispatched'; verification: PostEditVerification };
const cloneDocument = (ref: DocumentRef): DocumentRef => ({ ...ref });
const snapshotSave = (intent: SaveDocumentIntent): SaveDocumentIntent => ({ ...intent, document: cloneDocument(intent.document) });

export class LocalDocumentPersistenceController {
  constructor(private readonly backend: LocalDocumentPersistenceBackend) {}
  classify(intent: SemanticEditIntent): SemanticEffectClass { return classifyIntentEffect(intent); }
  executeSave(intent: SaveDocumentIntent): Promise<LocalSaveExecution> { return this.executeSnapshot(snapshotSave(intent)); }
  private async executeSnapshot(intent: SaveDocumentIntent): Promise<LocalSaveExecution> {
    const errors = validateIntent(intent);
    if (errors.length) return { status: 'rejected', dispatch: 'not-dispatched', reason: errors.join('; ') };
    const effect = classifyIntentEffect(intent);
    if (effect !== 'local-persistence') return { status: 'rejected', dispatch: 'not-dispatched', reason: 'local save must be classified as local-persistence' };
    const beforeRevision = await this.backend.readRevision();
    const identity = await this.backend.readIdentity();
    const freshness = checkDocumentFreshness(intent.document, identity.document);
    if (!freshness.fresh) return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: freshness.reason };

    let dispatch: 'dispatched' | 'uncertain' = 'uncertain';
    try {
      const result = await this.backend.dispatchLocalSave(intent);
      dispatch = result.dispatch === 'dispatched' ? 'dispatched' : 'uncertain';
    } catch {
      dispatch = 'uncertain';
    }

    const expectation: VerificationExpectation = { kind: 'saved-revision-at-least', target: intent.document, minimumRevision: beforeRevision };
    const observation = await this.backend.observeSavedState(intent.document);
    const verification = verifyPostEdit({ identity: await this.backend.readIdentity(), beforeRevision, expectation, observation });
    if (dispatch === 'uncertain') return { status: 'uncertain', effect: 'local-persistence', dispatch, verification };
    return verification.status === 'verified'
      ? { status: 'verified', effect: 'local-persistence', dispatch, verification }
      : { status: 'verification-failed', effect: 'local-persistence', dispatch, verification };
  }
}

export class DeterministicLocalDocumentPersistenceBackend implements LocalDocumentPersistenceBackend {
  private document: DocumentRef;
  private revision = 1;
  private savedRevision = 0;
  private dispatchCountValue = 0;
  private uncertainDispatch = false;
  constructor(documentId = 'local-persistence-document', kind: DocumentKind = 'structured-project') { this.document = { documentId, generation: 1, kind }; }
  get dispatchCount(): number { return this.dispatchCountValue; }
  currentDocument(): DocumentRef { return cloneDocument(this.document); }
  markNextDispatchUncertain(): void { this.uncertainDispatch = true; }
  replaceDocument(): DocumentRef { this.document = { ...this.document, generation: this.document.generation + 1 }; this.revision += 1; return this.currentDocument(); }
  async readIdentity(): Promise<DocumentIdentityState> { return { document: cloneDocument(this.document), entities: [] }; }
  async readRevision(): Promise<number> { return this.revision; }
  async observeSavedState(target: DocumentRef): Promise<ModelObservation> { return { kind: 'saved-state', target: cloneDocument(target), revision: this.revision, savedRevision: this.savedRevision }; }
  async dispatchLocalSave(intent: SaveDocumentIntent): Promise<LocalSaveDispatchResult> {
    const save = snapshotSave(intent); const freshness = checkDocumentFreshness(save.document, this.document); if (!freshness.fresh) throw new Error(freshness.reason);
    this.dispatchCountValue += 1; this.revision += 1; this.savedRevision = this.revision;
    const result: LocalSaveDispatchResult = { dispatch: this.uncertainDispatch ? 'uncertain' : 'dispatched', revision: this.revision }; this.uncertainDispatch = false; return { ...result };
  }
}
