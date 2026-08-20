import {
  COMPUTER_ENVIRONMENT_KINDS,
  sameComputerEntity,
  sameComputerSurface,
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEntityRef,
  type ComputerEnvironmentAdapter,
  type ComputerEnvironmentAdapterDescriptor,
  type ComputerObservationEnvelope,
  type ComputerObservationLimits,
  type ComputerObservationRequest,
  type ComputerSurfaceRef,
  validComputerCapabilityId,
  validateComputerActionRequest,
  validateComputerEntityRef,
  validateComputerObservationRequest,
  validateComputerSurfaceRef,
} from './environmentAdapter.js';

export type ComputerAdapterRoutingErrorCode =
  | 'adapter-not-found'
  | 'adapter-already-registered'
  | 'invalid-descriptor'
  | 'invalid-observation-request'
  | 'invalid-observation-response';

export class ComputerAdapterRoutingError extends Error {
  constructor(readonly code: ComputerAdapterRoutingErrorCode, message: string) {
    super(message);
    this.name = 'ComputerAdapterRoutingError';
  }
}

interface RegisteredAdapter {
  adapter: ComputerEnvironmentAdapter;
  descriptor: ComputerEnvironmentAdapterDescriptor;
}

function boundedIdentifier(value: string, max = 256): boolean {
  return value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);
}

function validateDescriptor(descriptor: ComputerEnvironmentAdapterDescriptor): string[] {
  const errors: string[] = [];
  if (!boundedIdentifier(descriptor.id)) errors.push('adapter id must be bounded and non-empty');
  if (!COMPUTER_ENVIRONMENT_KINDS.includes(descriptor.kind)) errors.push('adapter kind is unsupported');
  if (!boundedIdentifier(descriptor.version, 128)) errors.push('adapter version must be bounded and non-empty');
  if (!Array.isArray(descriptor.capabilities) || descriptor.capabilities.length > 512) {
    errors.push('adapter capabilities must contain at most 512 entries');
    return errors;
  }
  const seen = new Set<string>();
  for (const capability of descriptor.capabilities) {
    if (!validComputerCapabilityId(capability)) errors.push('adapter capability must be a bounded machine identifier');
    if (seen.has(capability)) errors.push(`duplicate adapter capability: ${capability}`);
    seen.add(capability);
  }
  return errors;
}

function cloneDescriptor(descriptor: ComputerEnvironmentAdapterDescriptor): ComputerEnvironmentAdapterDescriptor {
  return Object.freeze({
    id: descriptor.id,
    kind: descriptor.kind,
    version: descriptor.version,
    capabilities: Object.freeze([...descriptor.capabilities]),
  });
}

function snapshotSurface(surface: ComputerSurfaceRef): ComputerSurfaceRef {
  return Object.freeze({
    adapterId: surface.adapterId,
    environment: surface.environment,
    surfaceId: surface.surfaceId,
    ...(surface.generation === undefined ? {} : { generation: surface.generation }),
    ...(surface.parentSurfaceId === undefined ? {} : { parentSurfaceId: surface.parentSurfaceId }),
  });
}

function snapshotEntity(entity: ComputerEntityRef): ComputerEntityRef {
  return Object.freeze({
    adapterId: entity.adapterId,
    environment: entity.environment,
    kind: entity.kind,
    entityId: entity.entityId,
    ...(entity.surfaceId === undefined ? {} : { surfaceId: entity.surfaceId }),
    ...(entity.generation === undefined ? {} : { generation: entity.generation }),
  });
}

function snapshotLimits(limits: ComputerObservationLimits): ComputerObservationLimits {
  return Object.freeze({
    ...(limits.maxItems === undefined ? {} : { maxItems: limits.maxItems }),
    ...(limits.maxTextBytes === undefined ? {} : { maxTextBytes: limits.maxTextBytes }),
    ...(limits.maxDepth === undefined ? {} : { maxDepth: limits.maxDepth }),
  });
}

function snapshotObservationRequest(request: ComputerObservationRequest): ComputerObservationRequest {
  const surface = request.surface;
  const target = request.target;
  const limits = request.limits;
  return Object.freeze({
    adapterId: request.adapterId,
    channel: request.channel,
    ...(surface === undefined ? {} : { surface: snapshotSurface(surface) }),
    ...(target === undefined ? {} : { target: snapshotEntity(target) }),
    ...(limits === undefined ? {} : { limits: snapshotLimits(limits) }),
  });
}

function snapshotActionRequest(request: ComputerActionRequest): ComputerActionRequest {
  const target = request.target;
  const payload = request.payload;
  return Object.freeze({
    adapterId: request.adapterId,
    actionId: request.actionId,
    capability: request.capability,
    effect: request.effect,
    idempotency: request.idempotency,
    ...(target === undefined ? {} : { target: snapshotEntity(target) }),
    ...(payload === undefined ? {} : { payload }),
  });
}

function snapshotObservationResponse(response: ComputerObservationEnvelope): ComputerObservationEnvelope {
  const surface = response.surface;
  const target = response.target;
  const data = response.data;
  return Object.freeze({
    adapterId: response.adapterId,
    environment: response.environment,
    channel: response.channel,
    sequence: response.sequence,
    complete: response.complete,
    truncated: response.truncated,
    ...(surface === undefined ? {} : { surface: snapshotSurface(surface) }),
    ...(target === undefined ? {} : { target: snapshotEntity(target) }),
    data,
  });
}

function snapshotActionResult(result: ComputerActionResult): ComputerActionResult {
  const evidence = (result as { evidence?: unknown }).evidence;
  const details = result.details;
  return Object.freeze({
    status: result.status,
    dispatch: result.dispatch,
    verification: result.verification,
    ...(evidence === undefined ? {} : {
      evidence: Array.isArray(evidence) && evidence.length <= 32
        ? Object.freeze([...evidence])
        : evidence,
    }),
    ...(details === undefined ? {} : { details }),
  }) as ComputerActionResult;
}

function invalidObservationResponse(
  request: ComputerObservationRequest,
  descriptor: ComputerEnvironmentAdapterDescriptor,
  response: ComputerObservationEnvelope,
): string[] {
  const errors: string[] = [];
  if (response.adapterId !== descriptor.id || response.adapterId !== request.adapterId) {
    errors.push('response adapterId does not match routed adapter');
  }
  if (response.environment !== descriptor.kind) errors.push('response environment does not match adapter kind');
  if (response.channel !== request.channel) errors.push('response channel does not match request');
  if (!Number.isSafeInteger(response.sequence) || response.sequence < 0) errors.push('response sequence is invalid');
  if (typeof response.complete !== 'boolean' || typeof response.truncated !== 'boolean') {
    errors.push('response completeness flags are invalid');
  }
  if (response.surface) {
    errors.push(...validateComputerSurfaceRef(response.surface).map((error) => `surface: ${error}`));
    if (response.surface.adapterId !== descriptor.id || response.surface.environment !== descriptor.kind) {
      errors.push('response surface does not belong to routed adapter');
    }
  }
  if (response.target) {
    errors.push(...validateComputerEntityRef(response.target).map((error) => `target: ${error}`));
    if (response.target.adapterId !== descriptor.id || response.target.environment !== descriptor.kind) {
      errors.push('response target does not belong to routed adapter');
    }
  }
  if (request.surface && (!response.surface || !sameComputerSurface(request.surface, response.surface))) {
    errors.push('response surface identity does not match requested surface');
  }
  if (request.target && (!response.target || !sameComputerEntity(request.target, response.target))) {
    errors.push('response target identity does not match requested target');
  }
  if (response.surface && response.target?.surfaceId !== undefined && response.surface.surfaceId !== response.target.surfaceId) {
    errors.push('response target surfaceId does not match response surface');
  }
  return errors;
}

function nondispatched(
  status: Extract<ComputerActionResult['status'], 'rejected' | 'unsupported'>,
  evidence: string,
): ComputerActionResult {
  return Object.freeze({
    status,
    dispatch: 'not-dispatched',
    verification: 'unverified',
    evidence: Object.freeze([evidence]),
  });
}

function validEvidence(evidence: readonly string[] | undefined): boolean {
  if (evidence === undefined) return true;
  if (!Array.isArray(evidence) || evidence.length > 32) return false;
  return evidence.every((code) => /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(code));
}

function coherentActionResult(result: ComputerActionResult): boolean {
  if (result.status === 'completed') {
    if (result.dispatch === 'unknown') return false;
    if (result.verification !== 'verified' && result.verification !== 'not-applicable') return false;
  }
  if (result.verification === 'verified' && result.status !== 'completed') return false;
  if (result.verification === 'pending') {
    if (result.dispatch === 'not-dispatched') return false;
    if (result.status === 'completed') return false;
  }
  return true;
}

/**
 * Adapter registry/router for the environment-neutral core.
 *
 * Descriptors are snapshotted at registration so an adapter cannot mutate its
 * validated identity/kind/capability authority after registration. Neutral
 * request routing/safety fields are snapshotted before validation and any adapter
 * await. Neutral adapter response metadata is likewise snapshotted immediately
 * after the await, so validation never rereads mutable adapter-owned envelopes.
 * Opaque request payloads and response data/details remain adapter-owned.
 *
 * Observation contract violations throw because observations are read-only.
 * Action adapter failures after invocation never throw through this boundary:
 * once dispatch might have occurred, the registry returns dispatch=unknown so a
 * caller cannot accidentally interpret an exception as a safe-to-retry action.
 */
export class ComputerEnvironmentRegistry {
  private readonly adapters = new Map<string, RegisteredAdapter>();

  register(adapter: ComputerEnvironmentAdapter): void {
    const errors = validateDescriptor(adapter.descriptor);
    if (errors.length > 0) {
      throw new ComputerAdapterRoutingError('invalid-descriptor', errors.join('; '));
    }
    const descriptor = cloneDescriptor(adapter.descriptor);
    if (this.adapters.has(descriptor.id)) {
      throw new ComputerAdapterRoutingError('adapter-already-registered', `adapter already registered: ${descriptor.id}`);
    }
    this.adapters.set(descriptor.id, { adapter, descriptor });
  }

  unregister(adapterId: string): boolean {
    return this.adapters.delete(adapterId);
  }

  descriptor(adapterId: string): ComputerEnvironmentAdapterDescriptor | undefined {
    const descriptor = this.adapters.get(adapterId)?.descriptor;
    return descriptor ? cloneDescriptor(descriptor) : undefined;
  }

  descriptors(): ComputerEnvironmentAdapterDescriptor[] {
    return [...this.adapters.values()]
      .map(({ descriptor }) => cloneDescriptor(descriptor))
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    const snapshot = snapshotObservationRequest(request);
    const registered = this.adapters.get(snapshot.adapterId);
    if (!registered) {
      throw new ComputerAdapterRoutingError('adapter-not-found', `adapter not found: ${snapshot.adapterId}`);
    }
    const requestErrors = validateComputerObservationRequest(snapshot, registered.descriptor);
    if (requestErrors.length > 0) {
      throw new ComputerAdapterRoutingError('invalid-observation-request', requestErrors.join('; '));
    }
    const response = snapshotObservationResponse(await registered.adapter.observe(snapshot));
    const responseErrors = invalidObservationResponse(snapshot, registered.descriptor, response);
    if (responseErrors.length > 0) {
      throw new ComputerAdapterRoutingError('invalid-observation-response', responseErrors.join('; '));
    }
    return response;
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    const snapshot = snapshotActionRequest(request);
    const registered = this.adapters.get(snapshot.adapterId);
    if (!registered) return nondispatched('unsupported', 'adapter-not-found');

    const requestErrors = validateComputerActionRequest(snapshot, registered.descriptor);
    if (requestErrors.length > 0) return nondispatched('rejected', 'invalid-action-request');
    if (!registered.descriptor.capabilities.includes(snapshot.capability)) {
      return nondispatched('unsupported', 'capability-not-advertised');
    }

    try {
      const result = snapshotActionResult(await registered.adapter.act(snapshot));
      if (
        !['completed', 'rejected', 'unsupported', 'failed', 'unknown'].includes(result.status) ||
        !['not-dispatched', 'dispatched-once', 'unknown'].includes(result.dispatch) ||
        !['not-applicable', 'verified', 'pending', 'rejected', 'mismatch', 'unverified'].includes(result.verification) ||
        !coherentActionResult(result)
      ) {
        return Object.freeze({
          status: 'unknown',
          dispatch: 'unknown',
          verification: 'unverified',
          evidence: Object.freeze(['adapter-response-invalid']),
        });
      }
      if (!validEvidence(result.evidence)) {
        return Object.freeze({
          ...result,
          evidence: Object.freeze(['adapter-evidence-invalid']),
        });
      }
      return result;
    } catch {
      return Object.freeze({
        status: 'unknown',
        dispatch: 'unknown',
        verification: 'unverified',
        evidence: Object.freeze(['adapter-threw-after-invocation']),
      });
    }
  }
}
