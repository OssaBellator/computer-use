import {
  checkDocumentFreshness, checkEntityFreshness, classifyIntentEffect, observeBoundedItems, sameStructuredEntityRef,
  validateIntent, verifyPostEdit,
  type AddStructuredObjectIntent, type DocumentIdentityState, type DocumentRef, type ModelObservation,
  type ObservationBounds, type PostEditVerification, type RemoveStructuredObjectIntent,
  type ReorderStructuredObjectIntent, type SemanticEffectClass, type StructuredEntityRef,
  type VerificationExpectation,
} from '../computer/documentModels.js';

export type PresentationNativeEdit = AddStructuredObjectIntent | RemoveStructuredObjectIntent | ReorderStructuredObjectIntent;
export interface PresentationDispatchResult { dispatch: 'dispatched' | 'uncertain'; revision: number }
export interface ResolvedPresentationContainer { container: StructuredEntityRef; revision: number }
export interface PlannedPresentationAdd { object: StructuredEntityRef; container: StructuredEntityRef; revision: number }
export interface PresentationNativeBackend {
  readIdentity(): Promise<DocumentIdentityState>;
  readRevision(): Promise<number>;
  resolveContainer(target: StructuredEntityRef): Promise<ResolvedPresentationContainer>;
  planAddObject(intent: AddStructuredObjectIntent): Promise<PlannedPresentationAdd>;
  observeObjectOrder(container: StructuredEntityRef, bounds: ObservationBounds): Promise<ModelObservation>;
  dispatchSemanticEdit(intent: PresentationNativeEdit, addPlan?: PlannedPresentationAdd): Promise<PresentationDispatchResult>;
}
export type PresentationExecution =
  | { status: 'verified'; effect: SemanticEffectClass; dispatch: 'dispatched'; verification: PostEditVerification }
  | { status: 'uncertain'; effect: SemanticEffectClass; dispatch: 'uncertain'; verification: PostEditVerification }
  | { status: 'rejected'; effect?: SemanticEffectClass; dispatch: 'not-dispatched'; reason: string }
  | { status: 'verification-failed'; effect: SemanticEffectClass; dispatch: 'dispatched'; verification: PostEditVerification };

const cloneDocument = (ref: DocumentRef): DocumentRef => ({ ...ref });
const cloneEntity = (ref: StructuredEntityRef): StructuredEntityRef => ({ ...ref, document: cloneDocument(ref.document) });
function snapshotIntent(intent: PresentationNativeEdit): PresentationNativeEdit {
  if (intent.kind === 'add-structured-object') {
    return {
      ...intent,
      document: cloneDocument(intent.document),
      container: cloneEntity(intent.container),
      objectKind: `${intent.objectKind}`,
      ...(intent.beforeEntityId === undefined ? {} : { beforeEntityId: `${intent.beforeEntityId}` }),
      ...(intent.properties === undefined ? {} : { properties: { ...intent.properties } }),
    };
  }
  return {
    ...intent,
    document: cloneDocument(intent.document),
    target: cloneEntity(intent.target),
    ...(intent.kind === 'reorder-structured-object' && intent.beforeEntityId !== undefined ? { beforeEntityId: `${intent.beforeEntityId}` } : {}),
  };
}
function clonePlan(plan: PlannedPresentationAdd): PlannedPresentationAdd {
  return { object: cloneEntity(plan.object), container: cloneEntity(plan.container), revision: plan.revision };
}
function expectedExistingOrder(intent: RemoveStructuredObjectIntent | ReorderStructuredObjectIntent, before: readonly string[]): readonly string[] {
  const withoutTarget = before.filter(id => id !== intent.target.entityId);
  if (intent.kind === 'remove-structured-object') return withoutTarget;
  if (intent.beforeEntityId === undefined) return [...withoutTarget, intent.target.entityId];
  const index = withoutTarget.indexOf(intent.beforeEntityId);
  if (index < 0) throw new Error('reorder beforeEntityId is not present in container');
  return [...withoutTarget.slice(0, index), intent.target.entityId, ...withoutTarget.slice(index)];
}
function expectedAddedOrder(intent: AddStructuredObjectIntent, planned: StructuredEntityRef, before: readonly string[]): readonly string[] {
  if (before.includes(planned.entityId)) throw new Error('planned presentation object identity already exists');
  if (intent.beforeEntityId === undefined) return [...before, planned.entityId];
  const index = before.indexOf(intent.beforeEntityId);
  if (index < 0) throw new Error('add beforeEntityId is not present in container');
  return [...before.slice(0, index), planned.entityId, ...before.slice(index)];
}

export class PresentationSemanticController {
  constructor(private readonly backend: PresentationNativeBackend) {}
  classify(intent: PresentationNativeEdit): SemanticEffectClass { return classifyIntentEffect(intent); }
  execute(intent: PresentationNativeEdit, bounds: ObservationBounds): Promise<PresentationExecution> {
    return this.executeSnapshot(snapshotIntent(intent), { ...bounds });
  }
  private async executeSnapshot(intent: PresentationNativeEdit, bounds: ObservationBounds): Promise<PresentationExecution> {
    const errors = [...validateIntent(intent)];
    if (intent.kind === 'add-structured-object') {
      if (intent.container.kind !== 'slide') errors.push('presentation add container must be a slide');
    } else if (intent.target.kind !== 'presentation-object') {
      errors.push('presentation edit target must be a presentation object');
    }
    if (errors.length) return { status: 'rejected', dispatch: 'not-dispatched', reason: errors.join('; ') };

    const effect = classifyIntentEffect(intent);
    const beforeRevision = await this.backend.readRevision();
    let container: StructuredEntityRef;
    let addPlan: PlannedPresentationAdd | undefined;
    try {
      if (intent.kind === 'add-structured-object') {
        addPlan = clonePlan(await this.backend.planAddObject(intent));
        container = addPlan.container;
        if (addPlan.revision !== beforeRevision) throw new Error('presentation-revision-changed-before-dispatch');
        if (!sameStructuredEntityRef(container, intent.container)) throw new Error('planned presentation container identity mismatch');
        if (addPlan.object.kind !== 'presentation-object' || addPlan.object.parentEntityId !== container.entityId) {
          throw new Error('planned presentation object identity is invalid');
        }
      } else {
        const resolved = await this.backend.resolveContainer(intent.target);
        container = cloneEntity(resolved.container);
        if (resolved.revision !== beforeRevision) throw new Error('presentation-revision-changed-before-dispatch');
      }
    } catch (error) {
      return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: error instanceof Error ? error.message : 'presentation container could not be resolved' };
    }

    const beforeObservation = await this.backend.observeObjectOrder(container, bounds);
    if (beforeObservation.kind !== 'entity-order' || beforeObservation.truncated) {
      return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: 'complete presentation object order is required before dispatch' };
    }
    if (beforeObservation.revision !== beforeRevision) {
      return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: 'presentation-revision-changed-before-dispatch' };
    }

    let expectedEntityIds: readonly string[];
    try {
      expectedEntityIds = intent.kind === 'add-structured-object'
        ? expectedAddedOrder(intent, addPlan!.object, beforeObservation.entityIds)
        : expectedExistingOrder(intent, beforeObservation.entityIds);
    } catch (error) {
      return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: error instanceof Error ? error.message : 'presentation order could not be planned' };
    }

    const identity = await this.backend.readIdentity();
    const documentFreshness = checkDocumentFreshness(intent.document, identity.document);
    if (!documentFreshness.fresh) return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: documentFreshness.reason };
    const containerFreshness = checkEntityFreshness(container, identity);
    if (!containerFreshness.fresh) return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: containerFreshness.reason };
    if (intent.kind === 'add-structured-object') {
      if (identity.entities.some(entity => entity.entityId === addPlan!.object.entityId)) {
        return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: 'planned-presentation-object-already-exists' };
      }
      if (beforeRevision !== addPlan!.revision) {
        return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: 'presentation-revision-changed-before-dispatch' };
      }
    } else {
      const targetFreshness = checkEntityFreshness(intent.target, identity);
      if (!targetFreshness.fresh) return { status: 'rejected', effect, dispatch: 'not-dispatched', reason: targetFreshness.reason };
    }

    let dispatch: 'dispatched' | 'uncertain' = 'uncertain';
    try {
      const result = await this.backend.dispatchSemanticEdit(intent, addPlan);
      dispatch = result.dispatch === 'dispatched' ? 'dispatched' : 'uncertain';
    } catch {
      dispatch = 'uncertain';
    }

    const expectation: VerificationExpectation = { kind: 'entity-order-equals', target: container, expectedEntityIds };
    const observation = await this.backend.observeObjectOrder(container, bounds);
    const verificationIdentity = await this.backend.readIdentity();
    let verification = verifyPostEdit({ identity: verificationIdentity, beforeRevision, expectation, observation });
    if (intent.kind === 'add-structured-object' && verification.status === 'verified') {
      const plannedFreshness = checkEntityFreshness(addPlan!.object, verificationIdentity);
      if (!plannedFreshness.fresh) verification = { status: 'mismatch', evidence: ['planned-presentation-object-identity-mismatch'] };
    }
    if (dispatch === 'uncertain') return { status: 'uncertain', effect, dispatch, verification };
    return verification.status === 'verified'
      ? { status: 'verified', effect, dispatch, verification }
      : { status: 'verification-failed', effect, dispatch, verification };
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
  async planAddObject(intent: AddStructuredObjectIntent): Promise<PlannedPresentationAdd> {
    if (!sameStructuredEntityRef(intent.container, this.slide)) throw new Error('presentation slide is stale or missing');
    let ordinal = 1;
    while (this.objects.some(object => object.entityId === `added-object-${ordinal}`)) ordinal += 1;
    return {
      object: { document: cloneDocument(this.document), kind: 'presentation-object', entityId: `added-object-${ordinal}`, generation: 1, parentEntityId: this.slide.entityId },
      container: this.slideRef(),
      revision: this.revision,
    };
  }
  async observeObjectOrder(container: StructuredEntityRef, bounds: ObservationBounds): Promise<ModelObservation> { if (!sameStructuredEntityRef(container, this.slide)) throw new Error('presentation slide is stale or missing'); const observed = observeBoundedItems(this.objects.map(object => object.entityId), { ...bounds }); return { kind: 'entity-order', target: this.slideRef(), revision: this.revision, entityIds: observed.items, truncated: observed.truncated }; }
  async dispatchSemanticEdit(intent: PresentationNativeEdit, addPlan?: PlannedPresentationAdd): Promise<PresentationDispatchResult> {
    const edit = snapshotIntent(intent);
    if (edit.kind === 'add-structured-object') {
      if (!addPlan) throw new Error('presentation add requires a pre-dispatch identity plan');
      const plan = clonePlan(addPlan);
      if (plan.revision !== this.revision) throw new Error('presentation add plan revision is stale');
      if (!sameStructuredEntityRef(plan.container, this.slide) || !sameStructuredEntityRef(edit.container, this.slide)) throw new Error('presentation slide is stale or missing');
      if (plan.object.kind !== 'presentation-object' || plan.object.parentEntityId !== this.slide.entityId || !sameDocument(plan.object.document, this.document)) throw new Error('presentation add plan identity is invalid');
      if (this.objects.some(object => object.entityId === plan.object.entityId)) throw new Error('planned presentation object already exists');
      let beforeIndex: number | undefined;
      if (edit.beforeEntityId !== undefined) {
        beforeIndex = this.objects.findIndex(object => object.entityId === edit.beforeEntityId);
        if (beforeIndex < 0) throw new Error('add beforeEntityId is not present in container');
      }
      this.dispatchCountValue += 1;
      if (beforeIndex === undefined) this.objects.push(cloneEntity(plan.object)); else this.objects.splice(beforeIndex, 0, cloneEntity(plan.object));
    } else {
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
        else this.objects.splice(beforeIndex! > targetIndex ? beforeIndex! - 1 : beforeIndex!, 0, target);
      }
    }
    this.revision += 1;
    const result: PresentationDispatchResult = { dispatch: this.uncertainDispatch ? 'uncertain' : 'dispatched', revision: this.revision };
    this.uncertainDispatch = false;
    return { ...result };
  }
}
function sameDocument(a: DocumentRef, b: DocumentRef): boolean {
  return a.documentId === b.documentId && a.generation === b.generation && a.kind === b.kind;
}
