export const COMPUTER_ENVIRONMENT_KINDS = [
  'browser',
  'desktop-ui',
  'filesystem',
  'terminal',
  'process',
  'remote-session',
  'device',
] as const;

export type ComputerEnvironmentKind = typeof COMPUTER_ENVIRONMENT_KINDS[number];

export const COMPUTER_OBSERVATION_CHANNELS = [
  'semantic-ui',
  'document',
  'visual',
  'selection',
  'filesystem',
  'terminal',
  'process',
  'network',
  'media',
  'device',
  'system',
] as const;

export type ComputerObservationChannel = typeof COMPUTER_OBSERVATION_CHANNELS[number];

export const COMPUTER_ENTITY_KINDS = [
  'surface',
  'ui-control',
  'document',
  'selection',
  'file',
  'directory',
  'terminal-session',
  'process',
  'remote-host',
  'media',
  'device',
  'visual-region',
] as const;

export type ComputerEntityKind = typeof COMPUTER_ENTITY_KINDS[number];

export const COMPUTER_EFFECT_CLASSES = [
  'observe-only',
  'local-reversible',
  'local-destructive',
  'system-configuration',
  'external-communication',
  'external-transaction',
  'security-sensitive',
  'process-trigger',
  'remote-execution',
  'hardware-affecting',
] as const;

export type ComputerEffectClass = typeof COMPUTER_EFFECT_CLASSES[number];

export const COMPUTER_ACTION_IDEMPOTENCY = [
  'read-only',
  'idempotent',
  'non-idempotent',
  'unknown',
] as const;

export type ComputerActionIdempotency = typeof COMPUTER_ACTION_IDEMPOTENCY[number];

export type ComputerDispatchState = 'not-dispatched' | 'dispatched-once' | 'unknown';

export type ComputerVerificationState =
  | 'not-applicable'
  | 'verified'
  | 'pending'
  | 'rejected'
  | 'mismatch'
  | 'unverified';

export type ComputerActionStatus =
  | 'completed'
  | 'rejected'
  | 'unsupported'
  | 'failed'
  | 'unknown';

export interface ComputerSurfaceRef {
  /** Stable ID of the adapter instance, not a hostname, page title, or user-visible label. */
  adapterId: string;
  environment: ComputerEnvironmentKind;
  /** Adapter-defined opaque surface ID: browser target, desktop window, terminal tab, remote session, etc. */
  surfaceId: string;
  /** Increments when an adapter knows the surface identity was replaced/recreated. */
  generation?: number;
  /** Opaque parent identity for nested surfaces; never a page/window title. */
  parentSurfaceId?: string;
}

export interface ComputerEntityRef {
  adapterId: string;
  environment: ComputerEnvironmentKind;
  kind: ComputerEntityKind;
  /** Adapter-defined opaque stable identity within the adapter. */
  entityId: string;
  surfaceId?: string;
  generation?: number;
}

export interface ComputerObservationLimits {
  maxItems?: number;
  maxTextBytes?: number;
  maxDepth?: number;
}

export interface ComputerObservationRequest {
  /** Explicit even for global adapter observations such as process/filesystem roots. */
  adapterId: string;
  channel: ComputerObservationChannel;
  surface?: ComputerSurfaceRef;
  target?: ComputerEntityRef;
  limits?: ComputerObservationLimits;
}

/**
 * Environment-neutral observation envelope. `data` is intentionally opaque at
 * this lowest layer: typed channel controllers own its schema and privacy bounds.
 * Core task traces should retain channel/completeness metadata, not arbitrary data.
 */
export interface ComputerObservationEnvelope {
  adapterId: string;
  environment: ComputerEnvironmentKind;
  channel: ComputerObservationChannel;
  sequence: number;
  complete: boolean;
  truncated: boolean;
  surface?: ComputerSurfaceRef;
  target?: ComputerEntityRef;
  data: unknown;
}

/**
 * Lowest-layer action envelope. Higher-level controllers should expose typed
 * operations instead of asking task authors to manufacture opaque payloads.
 */
export interface ComputerActionRequest {
  /** Required because actions like process launch do not have a target entity yet. */
  adapterId: string;
  actionId: string;
  /** Namespaced machine capability, for example `filesystem.read` or `browser.activate`. */
  capability: string;
  effect: ComputerEffectClass;
  idempotency: ComputerActionIdempotency;
  target?: ComputerEntityRef;
  payload?: unknown;
}

export interface ComputerActionResult {
  status: ComputerActionStatus;
  dispatch: ComputerDispatchState;
  verification: ComputerVerificationState;
  /** Non-sensitive bounded machine-readable evidence codes only. */
  evidence?: readonly string[];
  /** Detailed adapter result for the direct caller; do not put this into ordinary traces. */
  details?: unknown;
}

export interface ComputerEnvironmentAdapterDescriptor {
  id: string;
  kind: ComputerEnvironmentKind;
  version: string;
  /** Namespaced capability identifiers implemented by this adapter. */
  capabilities: readonly string[];
}

export interface ComputerEnvironmentAdapter {
  readonly descriptor: ComputerEnvironmentAdapterDescriptor;
  observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope>;
  act(request: ComputerActionRequest): Promise<ComputerActionResult>;
}

const MAX_OPAQUE_ID_BYTES = 256;
const MAX_LIMIT = 1_000_000_000;
const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validOpaqueId(value: string): boolean {
  return value.length > 0 && utf8Bytes(value) <= MAX_OPAQUE_ID_BYTES && !/[\r\n\0]/.test(value);
}

export function validComputerCapabilityId(value: string): boolean {
  return CAPABILITY_PATTERN.test(value);
}

function validGeneration(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function validLimit(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= MAX_LIMIT);
}

export function validateComputerSurfaceRef(surface: ComputerSurfaceRef): string[] {
  const errors: string[] = [];
  if (!validOpaqueId(surface.adapterId)) errors.push('adapterId must be a bounded opaque identifier');
  if (!COMPUTER_ENVIRONMENT_KINDS.includes(surface.environment)) errors.push('environment is unsupported');
  if (!validOpaqueId(surface.surfaceId)) errors.push('surfaceId must be a bounded opaque identifier');
  if (surface.parentSurfaceId !== undefined && !validOpaqueId(surface.parentSurfaceId)) {
    errors.push('parentSurfaceId must be a bounded opaque identifier');
  }
  if (!validGeneration(surface.generation)) errors.push('generation must be a non-negative safe integer');
  return errors;
}

export function validateComputerEntityRef(entity: ComputerEntityRef): string[] {
  const errors: string[] = [];
  if (!validOpaqueId(entity.adapterId)) errors.push('adapterId must be a bounded opaque identifier');
  if (!COMPUTER_ENVIRONMENT_KINDS.includes(entity.environment)) errors.push('environment is unsupported');
  if (!COMPUTER_ENTITY_KINDS.includes(entity.kind)) errors.push('entity kind is unsupported');
  if (!validOpaqueId(entity.entityId)) errors.push('entityId must be a bounded opaque identifier');
  if (entity.surfaceId !== undefined && !validOpaqueId(entity.surfaceId)) {
    errors.push('surfaceId must be a bounded opaque identifier');
  }
  if (!validGeneration(entity.generation)) errors.push('generation must be a non-negative safe integer');
  return errors;
}

export function validateComputerObservationRequest(
  request: ComputerObservationRequest,
  descriptor?: ComputerEnvironmentAdapterDescriptor,
): string[] {
  const errors: string[] = [];
  if (!validOpaqueId(request.adapterId)) errors.push('request adapterId must be a bounded opaque identifier');
  if (!COMPUTER_OBSERVATION_CHANNELS.includes(request.channel)) errors.push('observation channel is unsupported');
  if (request.surface) errors.push(...validateComputerSurfaceRef(request.surface).map((error) => `surface: ${error}`));
  if (request.target) errors.push(...validateComputerEntityRef(request.target).map((error) => `target: ${error}`));
  if (request.surface?.adapterId !== undefined && request.surface.adapterId !== request.adapterId) {
    errors.push('surface adapterId does not match request adapterId');
  }
  if (request.target?.adapterId !== undefined && request.target.adapterId !== request.adapterId) {
    errors.push('target adapterId does not match request adapterId');
  }
  if (request.surface && request.target && request.surface.environment !== request.target.environment) {
    errors.push('surface and target environments do not match');
  }
  if (request.surface && request.target?.surfaceId !== undefined && request.surface.surfaceId !== request.target.surfaceId) {
    errors.push('target surfaceId does not match request surface');
  }
  if (!validLimit(request.limits?.maxItems)) errors.push('maxItems must be a positive bounded safe integer');
  if (!validLimit(request.limits?.maxTextBytes)) errors.push('maxTextBytes must be a positive bounded safe integer');
  if (!validLimit(request.limits?.maxDepth)) errors.push('maxDepth must be a positive bounded safe integer');
  if (descriptor) {
    if (descriptor.id !== request.adapterId) errors.push('descriptor id does not match request adapterId');
    if (request.surface && request.surface.environment !== descriptor.kind) errors.push('surface environment does not match adapter kind');
    if (request.target && request.target.environment !== descriptor.kind) errors.push('target environment does not match adapter kind');
  }
  return errors;
}

export function validateComputerActionRequest(
  request: ComputerActionRequest,
  descriptor?: ComputerEnvironmentAdapterDescriptor,
): string[] {
  const errors: string[] = [];
  if (!validOpaqueId(request.adapterId)) errors.push('request adapterId must be a bounded opaque identifier');
  if (!validOpaqueId(request.actionId)) errors.push('actionId must be a bounded opaque identifier');
  if (!validComputerCapabilityId(request.capability)) errors.push('capability must be a bounded machine identifier');
  if (!COMPUTER_EFFECT_CLASSES.includes(request.effect)) errors.push('effect class is unsupported');
  if (!COMPUTER_ACTION_IDEMPOTENCY.includes(request.idempotency)) errors.push('idempotency is unsupported');
  if (request.idempotency === 'read-only' && request.effect !== 'observe-only') {
    errors.push('read-only idempotency requires observe-only effect');
  }
  if (request.target) errors.push(...validateComputerEntityRef(request.target).map((error) => `target: ${error}`));
  if (request.target?.adapterId !== undefined && request.target.adapterId !== request.adapterId) {
    errors.push('target adapterId does not match request adapterId');
  }
  if (descriptor) {
    if (descriptor.id !== request.adapterId) errors.push('descriptor id does not match request adapterId');
    if (request.target && request.target.environment !== descriptor.kind) errors.push('target environment does not match adapter kind');
  }
  return errors;
}

export function sameComputerSurface(left: ComputerSurfaceRef, right: ComputerSurfaceRef): boolean {
  return left.adapterId === right.adapterId &&
    left.environment === right.environment &&
    left.surfaceId === right.surfaceId &&
    left.generation === right.generation;
}

export function sameComputerEntity(left: ComputerEntityRef, right: ComputerEntityRef): boolean {
  return left.adapterId === right.adapterId &&
    left.environment === right.environment &&
    left.kind === right.kind &&
    left.entityId === right.entityId &&
    left.surfaceId === right.surfaceId &&
    left.generation === right.generation;
}

export function computerEffectRequiresApproval(effect: ComputerEffectClass): boolean {
  return effect !== 'observe-only' && effect !== 'local-reversible';
}

/**
 * Conservative retry rule shared across future browser/desktop/filesystem/etc.
 * A side-effecting action is never retried after any possible dispatch. Read-only
 * observations may be repeated even when the transport cannot prove dispatch.
 */
export function computerActionMayAutoRetry(
  request: Pick<ComputerActionRequest, 'effect' | 'idempotency'>,
  result: Pick<ComputerActionResult, 'dispatch'>,
): boolean {
  if (request.effect === 'observe-only' && request.idempotency === 'read-only') return true;
  return result.dispatch === 'not-dispatched';
}
