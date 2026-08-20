import {
  checkDocumentFreshness,
  classifyIntentEffect,
  validateIntent,
  verifyPostEdit,
  type DocumentIdentityState,
  type DocumentKind,
  type DocumentRef,
  type ModelObservation,
  type PostEditVerification,
  type SaveDocumentIntent,
  type SemanticEditIntent,
  type SemanticEffectClass,
  type VerificationExpectation,
} from '../computer/documentModels.js';

export interface LocalSaveDispatchResult {
  dispatch: 'dispatched' | 'uncertain';
  revision: number;
}

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

function cloneDocument(ref: DocumentRef): DocumentRef {
  return { documentId: ref.documentId, generation: ref.generation, kind: ref.kind };
}

function snapshotSave(intent: SaveDocumentIntent): SaveDocumentIntent {
  return { ...intent, document: cloneDocument(intent.document) };
}

/**
 * Local persistence controller. Its dispatch surface contains save only: export and publication remain separate effects.
 */
export class LocalDocumentPersistenceController {
  constructor(private readonly backend: LocalDocumentPersistenceBackend) {}

  classify(intent: SemanticEditIntent): SemanticEffectClass {
    return classifyIntentEffect(intent);
  }

  executeSave(intent: SaveDocumentIntent): Promise<LocalSaveExecution> {
    const snapshot = snapshotSave(intent);
    return this.executeSnapshot(snapshot);
  }

  private async executeSnapshot(intent: SaveDocumentIntent): Promise<LocalSaveExecution> {
    const errors = validateIntent(intent);
    if (errors.length > 0) return { status: 'rejected', dispatch: 'not-dispatched', reason: errors.join('; ') };

    const effect = classifyIntentEffect(intent);
    if (effect !== 'local-persistence') {
      return { status: 'rejected', dispatch: 'not-dispatched', reason: 'local save must be classified as local-persistence' };
    }

    const beforeRevision = await this.backend.readRevision();

    // The final awaited authority read before dispatch freshly validates document generation.
    const identity = await this.backend.readIdentity();
    const freshness = checkDocumentFreshness(intent.document, identity.document);
    if (!freshness.fresh) {
      return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: freshness.reason };
    }

    const backendResult = await this.backend.dispatchLocalSave(intent);
    const dispatch = backendResult.dispatch === 'dispatched' ? 'dispatched' : 'uncertain';

    const expectation: VerificationExpectation = {
      kind: 'saved-revision-at-least',
      target: intent.document,
      minimumRevision: beforeRevision,
    };
    const observation = await this.backend.observeSavedState(intent.document);
    const verificationIdentity = await this.backend.readIdentity();
    const verification = verifyPostEdit({ identity: verificationIdentity, beforeRevision, expectation, observation });

    if (dispatch === 'uncertain') return { status: 'uncertain', effect: 'local-persistence', dispatch, verification };
    if (verification.status === 'verified') return { status: 'verified', effect: 'local-persistence', dispatch, verification };
    return { status: 'verification-failed', effect: 'local-persistence', dispatch, verification };
  }
}

/** Deterministic local save backend. It has no export or publication operation. */
export class DeterministicLocalDocumentPersistenceBackend implements LocalDocumentPersistenceBackend {
  private document: DocumentRef;
  private revision = 1;
  private savedRevision = 0;
  private dispatchCountValue = 0;
  private uncertainDispatch = false;

  constructor(documentId = 'local-persistence-document', kind: DocumentKind = 'structured-project') {
    this.document = { documentId, generation: 1, kind };
  }

  get dispatchCount(): number {
    return this.dispatchCountValue;
  }

  currentDocument(): DocumentRef {
    return cloneDocument(this.document);
  }

  markNextDispatchUncertain(): void {
    this.uncertainDispatch = true;
  }

  replaceDocument(): DocumentRef {
    this.document = { ...this.document, generation: this.document.generation + 1 };
    this.revision += 1;
    return this.currentDocument();
  }

  async readIdentity(): Promise<DocumentIdentityState> {
    return { document: cloneDocument(this.document), entities: [] };
  }

  async readRevision(): Promise<number> {
    return this.revision;
  }

  async observeSavedState(target: DocumentRef): Promise<ModelObservation> {
    return {
      kind: 'saved-state',
      target: cloneDocument(target),
      revision: this.revision,
      savedRevision: this.savedRevision,
    };
  }

  async dispatchLocalSave(intent: SaveDocumentIntent): Promise<LocalSaveDispatchResult> {
    const save = snapshotSave(intent);
    const freshness = checkDocumentFreshness(save.document, this.document);
    if (!freshness.fresh) throw new Error(freshness.reason);

    this.dispatchCountValue += 1;
    this.revision += 1;
    this.savedRevision = this.revision;

    const result: LocalSaveDispatchResult = {
      dispatch: this.uncertainDispatch ? 'uncertain' : 'dispatched',
      revision: this.revision,
    };
    this.uncertainDispatch = false;
    return { ...result };
  }
}
