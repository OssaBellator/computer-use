import {
  checkDocumentFreshness, checkEntityFreshness, classifyIntentEffect, observeBoundedItems, sameStructuredEntityRef,
  validateIntent, verifyPostEdit,
  type DocumentIdentityState, type DocumentRef, type ModelObservation, type ObservationBounds,
  type PostEditVerification, type RemoveStructuredObjectIntent, type ReorderStructuredObjectIntent,
  type SemanticEffectClass, type StructuredEntityRef, type VerificationExpectation,
} from '../computer/documentModels.js';

export type PresentationNativeEdit = RemoveStructuredObjectIntent | ReorderStructuredObjectIntent;
export interface PresentationDispatchResult { dispatch: 'dispatched' | 'uncertain'; revision: number }
export interface ResolvedPresentationContainer { container: StructuredEntityRef; revision: number }
export interface PresentationNativeBackend {
  readIdentity(): Promise<DocumentIdentityState>;
  readRevision(): Promise<number>;
  resolveContainer(target: StructuredEntityRef): Promise<ResolvedPresentationContainer>;
  observeObjectOrder(container: StructuredEntityRef, bounds: ObservationBounds): Promise<ModelObservation>;
  dispatchSemanticEdit(intent: PresentationNativeEdit): Promise<PresentationDispatchResult>;
}
export type PresentationExecution =
  | { status: 'verified'; effect: SemanticEffectClass; dispatch: 'dispatched'; verification: PostEditVerification }
  | { status: 'uncertain'; effect: SemanticEffectClass; dispatch: 'uncertain'; verification: PostEditVerification }
  | { status: 'rejected'; effect?: SemanticEffectClass; dispatch: 'not-dispatched'; reason: string }
  | { status: 'verification-failed'; effect: SemanticEffectClass; dispatch: 'dispatched'; verification: PostEditVerification };

const cloneDocument = (ref: DocumentRef): DocumentRef => ({ ...ref });
const cloneEntity = (ref: StructuredEntityRef): StructuredEntityRef => ({ ...ref, document: cloneDocument(ref.document) });
function snapshotIntent(intent: PresentationNativeEdit): PresentationNativeEdit {
  return { ...intent, document: cloneDocument(intent.document), target: cloneEntity(intent.target), ...(intent.kind === 'reorder-structured-object' && intent.beforeEntityId !== undefined ? { beforeEntityId: `${intent.beforeEntityId}` } : {}) };
}
function expectedOrder(intent: PresentationNativeEdit, before: readonly string[]): readonly string[] {
  const withoutTarget = before.filter(id => id !== intent.target.entityId);
  if (intent.kind === 'remove-structured-object') return withoutTarget;
  if (intent.beforeEntityId === undefined) return [...withoutTarget, intent.target.entityId];
  const index = withoutTarget.indexOf(intent.beforeEntityId);
  if (index < 0) throw new Error('reorder beforeEntityId is not present in container');
  return [...withoutTarget.slice(0, index), intent.target.entityId, ...withoutTarget.slice(index)];
}

export class PresentationSemanticController {
  constructor(private readonly backend: PresentationNativeBackend) {}
  classify(intent: PresentationNativeEdit): SemanticEffectClass { return classifyIntentEffect(intent); }
  execute(intent: PresentationNativeEdit, bounds: ObservationBounds): Promise<PresentationExecution> { return this.executeSnapshot(snapshotIntent(intent), { ...bounds }); }
  private async executeSnapshot(intent: PresentationNativeEdit, bounds: ObservationBounds): Promise<PresentationExecution> {
    const errors = [...validateIntent(intent)];
    if (intent.target.kind !== 'presentation-object') errors.push('presentation edit target must be a presentation object');
    if (errors.length) return { status: 'rejected', dispatch: 'not-dispatched', reason: errors.join('; ') };
    const effect = classifyIntentEffect(intent);
    const beforeRevision = await this.backend.readRevision();
    let resolved: ResolvedPresentationContainer;
    try { resolved = await this.backend.resolveContainer(intent.target); }
    catch (error) { return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: error instanceof Error ? error.message : 'presentation container could not be resolved' }; }
    if (resolved.revision !== beforeRevision) return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: 'presentation-revision-changed-before-dispatch' };
    const beforeObservation = await this.backend.observeObjectOrder(resolved.container, bounds);
    if (beforeObservation.kind !== 'entity-order' || beforeObservation.truncated) return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: 'complete presentation object order is required before dispatch' };
    if (beforeObservation.revision !== beforeRevision) return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: 'presentation-revision-changed-before-dispatch' };
    let expectedEntityIds: readonly string[];
    try { expectedEntityIds = expectedOrder(intent, beforeObservation.entityIds); }
    catch (error) { return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: error instanceof Error ? error.message : 'presentation order could not be planned' }; }
    const identity = await this.backend.readIdentity();
    const documentFreshness = checkDocumentFreshness(intent.document, identity.document);
    if (!documentFreshness.fresh) return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: documentFreshness.reason };
    const targetFreshness = checkEntityFreshness(intent.target, identity);
    if (!targetFreshness.fresh) return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: targetFreshness.reason };
    const containerFreshness = checkEntityFreshness(resolved.container, identity);
    if (!containerFreshness.fresh) return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: containerFreshness.reason };

    let dispatch: 'dispatched' | 'uncertain' = 'uncertain';
    try {
      const result = await this.backend.dispatchSemanticEdit(intent);
      dispatch = result.dispatch === 'dispatched' ? 'dispatched' : 'uncertain';
    } catch {
      dispatch = 'uncertain';
    }

    const expectation: VerificationExpectation = { kind: 'entity-order-equals', target: resolved.container, expectedEntityIds };
    const observation = await this.backend.observeObjectOrder(resolved.container, bounds);
    const verification = verifyPostEdit({ identity: await this.backend.readIdentity(), beforeRevision, expectation, observation });
    if (dispatch === 'uncertain') return { status: 'uncertain', effect, dispatch, verification };
    return verification.status === 'verified' ? { status: 'verified', effect, dispatch, verification } : { status: 'verification-failed', effect, dispatch, verification };
  }
}

export class DeterministicPresentationBackend implements PresentationNativeBackend {
  private document: DocumentRef;
  private slide: StructuredEntityRef;
  private objects: StructuredEntityRef[];
  private revision = 1;
  private dispatchCountValue = 0;
  private uncertainDispatch = false;
  constructor(documentId = 'local-presentation', objectIds: readonly string[] = ['object-1', 'object-2', 'object-3']) {
    this.document = { documentId, generation: 1, kind: 'presentation' };
    this.slide = { document: cloneDocument(this.document), kind: 'slide', entityId: 'slide-1', generation: 1 };
    this.objects = objectIds.map(entityId => ({ document: cloneDocument(this.document), kind: 'presentation-object', entityId: `${entityId}`, generation: 1, parentEntityId: this.slide.entityId }));
  }
  get dispatchCount(): number { return this.dispatchCountValue; }
  currentDocument(): DocumentRef { return cloneDocument(this.document); }
  slideRef(): StructuredEntityRef { return cloneEntity(this.slide); }
  objectRef(index = 0): StructuredEntityRef { const object = this.objects[index]; if (!object) throw new Error('presentation object index out of range'); return cloneEntity(object); }
  objectIds(): readonly string[] { return this.objects.map(object => object.entityId); }
  markNextDispatchUncertain(): void { this.uncertainDispatch = true; }
  replaceDocument(): DocumentRef { this.document = { ...this.document, generation: this.document.generation + 1 }; this.slide = { ...cloneEntity(this.slide), document: cloneDocument(this.document), generation: this.slide.generation + 1 }; this.objects = this.objects.map(object => ({ ...cloneEntity(object), document: cloneDocument(this.document), generation: object.generation + 1, parentEntityId: this.slide.entityId })); this.revision += 1; return this.currentDocument(); }
  replaceSlide(): StructuredEntityRef { this.slide = { ...cloneEntity(this.slide), generation: this.slide.generation + 1 }; this.revision += 1; return this.slideRef(); }
  replaceObject(index = 0): StructuredEntityRef { const object = this.objects[index]; if (!object) throw new Error('presentation object index out of range'); this.objects[index] = { ...cloneEntity(object), generation: object.generation + 1 }; this.revision += 1; return this.objectRef(index); }
  async readIdentity(): Promise<DocumentIdentityState> { return { document: cloneDocument(this.document), entities: [this.slide, ...this.objects].map(entity => ({ kind: entity.kind, entityId: entity.entityId, generation: entity.generation })) }; }
  async readRevision(): Promise<number> { return this.revision; }
  async resolveContainer(target: StructuredEntityRef): Promise<ResolvedPresentationContainer> { const object = this.objects.find(candidate => sameStructuredEntityRef(candidate, target)); if (!object) throw new Error('presentation object is stale or missing'); if (object.parentEntityId !== this.slide.entityId) throw new Error('presentation object container is missing'); return { container: this.slideRef(), revision: this.revision }; }
  async observeObjectOrder(container: StructuredEntityRef, bounds: ObservationBounds): Promise<ModelObservation> { if (!sameStructuredEntityRef(container, this.slide)) throw new Error('presentation slide is stale or missing'); const observed = observeBoundedItems(this.objects.map(object => object.entityId), { ...bounds }); return { kind: 'entity-order', target: this.slideRef(), revision: this.revision, entityIds: observed.items, truncated: observed.truncated }; }
  async dispatchSemanticEdit(intent: PresentationNativeEdit): Promise<PresentationDispatchResult> {
    const edit = snapshotIntent(intent);
    const targetIndex = this.objects.findIndex(object => sameStructuredEntityRef(object, edit.target));
    if (targetIndex < 0) throw new Error('presentation object is stale or missing');
    let beforeIndex: number | undefined;
    if (edit.kind === 'reorder-structured-object' && edit.beforeEntityId !== undefined) {
      beforeIndex = this.objects.findIndex(object => object.entityId === edit.beforeEntityId);
      if (beforeIndex < 0) throw new Error('reorder beforeEntityId is not present in container');
    }
    this.dispatchCountValue += 1;
    const [target] = this.objects.splice(targetIndex, 1);
    if (!target) throw new Error('presentation object disappeared during dispatch');
    if (edit.kind === 'reorder-structured-object') {
      if (edit.beforeEntityId === undefined) this.objects.push(target);
      else {
        const adjusted = beforeIndex! > targetIndex ? beforeIndex! - 1 : beforeIndex!;
        this.objects.splice(adjusted, 0, target);
      }
    }
    this.revision += 1;
    const result: PresentationDispatchResult = { dispatch: this.uncertainDispatch ? 'uncertain' : 'dispatched', revision: this.revision };
    this.uncertainDispatch = false;
    return { ...result };
  }
}
