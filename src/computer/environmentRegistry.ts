import {
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEnvironmentAdapter,
  type ComputerEnvironmentAdapterDescriptor,
  type ComputerObservationEnvelope,
  type ComputerObservationRequest,
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

function boundedIdentifier(value: string, max = 256): boolean {
  return value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);
}

function validateDescriptor(descriptor: ComputerEnvironmentAdapterDescriptor): string[] {
  const errors: string[] = [];
  if (!boundedIdentifier(descriptor.id)) errors.push('adapter id must be bounded and non-empty');
  if (!boundedIdentifier(descriptor.version, 128)) errors.push('adapter version must be bounded and non-empty');
  const seen = new Set<string>();
  for (const capability of descriptor.capabilities) {
    if (!boundedIdentifier(capability)) errors.push('adapter capability must be bounded and non-empty');
    if (seen.has(capability)) errors.push(`duplicate adapter capability: ${capability}`);
    seen.add(capability);
  }
  return errors;
}

function cloneDescriptor(descriptor: ComputerEnvironmentAdapterDescriptor): ComputerEnvironmentAdapterDescriptor {
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    version: descriptor.version,
    capabilities: Object.freeze([...descriptor.capabilities]),
  };
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
  return errors;
}

function nondispatched(
  status: Extract<ComputerActionResult['status'], 'rejected' | 'unsupported'>,
  evidence: string,
): ComputerActionResult {
  return {
    status,
    dispatch: 'not-dispatched',
    verification: 'unverified',
    evidence: [evidence],
  };
}

function validEvidence(evidence: readonly string[] | undefined): boolean {
  if (evidence === undefined) return true;
  if (!Array.isArray(evidence) || evidence.length > 32) return false;
  return evidence.every((code) => /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(code));
}

/**
 * Adapter registry/router for the environment-neutral core.
 *
 * Observation contract violations throw because observations are read-only.
 * Action adapter failures after invocation never throw through this boundary:
 * once dispatch might have occurred, the registry returns dispatch=unknown so a
 * caller cannot accidentally interpret an exception as a safe-to-retry action.
 */
export class ComputerEnvironmentRegistry {
  private readonly adapters = new Map<string, ComputerEnvironmentAdapter>();

  register(adapter: ComputerEnvironmentAdapter): void {
    const errors = validateDescriptor(adapter.descriptor);
    if (errors.length > 0) {
      throw new ComputerAdapterRoutingError('invalid-descriptor', errors.join('; '));
    }
    if (this.adapters.has(adapter.descriptor.id)) {
      throw new ComputerAdapterRoutingError('adapter-already-registered', `adapter already registered: ${adapter.descriptor.id}`);
    }
    this.adapters.set(adapter.descriptor.id, adapter);
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
      .map((adapter) => cloneDescriptor(adapter.descriptor))
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    const adapter = this.adapters.get(request.adapterId);
    if (!adapter) {
      throw new ComputerAdapterRoutingError('adapter-not-found', `adapter not found: ${request.adapterId}`);
    }
    const requestErrors = validateComputerObservationRequest(request, adapter.descriptor);
    if (requestErrors.length > 0) {
      throw new ComputerAdapterRoutingError('invalid-observation-request', requestErrors.join('; '));
    }
    const response = await adapter.observe(request);
    const responseErrors = invalidObservationResponse(request, adapter.descriptor, response);
    if (responseErrors.length > 0) {
      throw new ComputerAdapterRoutingError('invalid-observation-response', responseErrors.join('; '));
    }
    return response;
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    const adapter = this.adapters.get(request.adapterId);
    if (!adapter) return nondispatched('unsupported', 'adapter-not-found');

    const requestErrors = validateComputerActionRequest(request, adapter.descriptor);
    if (requestErrors.length > 0) return nondispatched('rejected', 'invalid-action-request');
    if (!adapter.descriptor.capabilities.includes(request.capability)) {
      return nondispatched('unsupported', 'capability-not-advertised');
    }

    try {
      const result = await adapter.act(request);
      if (
        !['completed', 'rejected', 'unsupported', 'failed', 'unknown'].includes(result.status) ||
        !['not-dispatched', 'dispatched-once', 'unknown'].includes(result.dispatch) ||
        !['not-applicable', 'verified', 'pending', 'rejected', 'mismatch', 'unverified'].includes(result.verification)
      ) {
        return {
          status: 'unknown',
          dispatch: 'unknown',
          verification: 'unverified',
          evidence: ['adapter-response-invalid'],
        };
      }
      if (!validEvidence(result.evidence)) {
        return {
          ...result,
          evidence: ['adapter-evidence-invalid'],
        };
      }
      return result;
    } catch {
      return {
        status: 'unknown',
        dispatch: 'unknown',
        verification: 'unverified',
        evidence: ['adapter-threw-after-invocation'],
      };
    }
  }
}
