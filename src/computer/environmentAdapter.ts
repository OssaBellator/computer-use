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

export type ComputerEffectClass =
  | 'observe-only'
  | 'local-reversible'
  | 'local-destructive'
  | 'system-configuration'
  | 'external-communication'
  | 'external-transaction'
  | 'security-sensitive'
  | 'process-trigger'
  | 'remote-execution'
  | 'hardware-affecting';

export type ComputerActionIdempotency =
  | 'read-only'
  | 'idempotent'
  | 'non-idempotent'
  | 'unknown';

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
  actionId: string;
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

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validOpaqueId(value: string): boolean {
  return value.length > 0 && utf8Bytes(value) <= MAX_OPAQUE_ID_BYTES && !/[\r\n\0]/.test(value);
}

function validGeneration(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
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
