import {
  sameComputerEntity,
  type ComputerActionRequest,
  type ComputerEnvironmentKind,
  type ComputerObservationRequest,
  type ComputerSurfaceRef,
  type ComputerEntityRef,
} from './environmentAdapter.js';

export const COMPUTER_TASK_MAX_RETRIES = 3;
export const COMPUTER_TASK_MAX_OBSERVATION_ITEMS = 10_000;
export const COMPUTER_TASK_MAX_OBSERVATION_TEXT_BYTES = 1024 * 1024;
export const COMPUTER_TASK_MAX_OBSERVATION_DEPTH = 64;
export const COMPUTER_TASK_MAX_SNAPSHOT_DEPTH = 48;
export const COMPUTER_TASK_MAX_SNAPSHOT_ITEMS = 20_000;
export const COMPUTER_TASK_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export const COMPUTER_TASK_DEFAULT_OBSERVATION_LIMITS = Object.freeze({
  maxItems: 256,
  maxTextBytes: 32 * 1024,
  maxDepth: 8,
});

export interface ComputerTaskRequirements {
  adapterId: string;
  environment?: ComputerEnvironmentKind;
  capabilities?: readonly string[];
}

export interface ComputerTaskTargetRef {
  surface?: ComputerSurfaceRef;
  entity?: ComputerEntityRef;
}

export interface ComputerTaskObservationStep {
  kind: 'observe';
  id: string;
  request: ComputerObservationRequest;
  requirements?: ComputerTaskRequirements;
  next?: string;
}

export interface ComputerTaskActionStep {
  kind: 'action';
  id: string;
  request: ComputerActionRequest;
  requirements?: ComputerTaskRequirements;
  target?: ComputerTaskTargetRef;
  /** Domain/adapter verifier key. Omit to use the verification reported by the adapter result. */
  verification?: string;
  /**
   * Non-secret trusted-input revision/digest used to bind checkpoint compatibility.
   * Required whenever an action carries a payload because raw payload content is never checkpointed.
   */
  checkpointBinding?: string;
  onSuccess?: string;
  onFailure?: string;
  maxRetries?: number;
}

export type ComputerTaskStep = ComputerTaskObservationStep | ComputerTaskActionStep;

export interface ComputerTaskProgram {
  id: string;
  entry: string;
  steps: readonly ComputerTaskStep[];
}

function boundedIdentifier(value: string, max = 256): boolean {
  return value.length > 0 && new TextEncoder().encode(value).byteLength <= max && !/[\r\n\0]/.test(value);
}

function validCheckpointBinding(value: string): boolean {
  return value.length >= 16 && boundedIdentifier(value, 256);
}

function validateRequirements(
  requirements: ComputerTaskRequirements | undefined,
  requestAdapterId: string,
): string[] {
  if (!requirements) return [];
  const errors: string[] = [];
  if (!boundedIdentifier(requirements.adapterId)) errors.push('requirements adapterId must be bounded');
  if (requirements.adapterId !== requestAdapterId) errors.push('requirements adapterId must match request adapterId');
  if (requirements.capabilities) {
    if (requirements.capabilities.length > 64) errors.push('requirements capabilities exceed 64 entries');
    if (new Set(requirements.capabilities).size !== requirements.capabilities.length) {
      errors.push('requirements capabilities must be unique');
    }
  }
  return errors;
}

function validateObservationLimits(step: ComputerTaskObservationStep): string[] {
  const errors: string[] = [];
  const limits = step.request.limits;
  if (!limits) return errors;
  if (limits.maxItems !== undefined && limits.maxItems > COMPUTER_TASK_MAX_OBSERVATION_ITEMS) {
    errors.push(`observation maxItems exceeds ${COMPUTER_TASK_MAX_OBSERVATION_ITEMS}`);
  }
  if (limits.maxTextBytes !== undefined && limits.maxTextBytes > COMPUTER_TASK_MAX_OBSERVATION_TEXT_BYTES) {
    errors.push(`observation maxTextBytes exceeds ${COMPUTER_TASK_MAX_OBSERVATION_TEXT_BYTES}`);
  }
  if (limits.maxDepth !== undefined && limits.maxDepth > COMPUTER_TASK_MAX_OBSERVATION_DEPTH) {
    errors.push(`observation maxDepth exceeds ${COMPUTER_TASK_MAX_OBSERVATION_DEPTH}`);
  }
  return errors;
}

function validateTarget(step: ComputerTaskActionStep): string[] {
  const errors: string[] = [];
  const target = step.target;
  if (!target) {
    if (step.request.target) errors.push('request target requires an identical action target entity for freshness checks');
    return errors;
  }
  for (const ref of [target.surface, target.entity]) {
    if (!ref) continue;
    if (ref.adapterId !== step.request.adapterId) errors.push('target authority must match request adapterId');
    if (ref.generation === undefined) errors.push('action target references must include generation');
  }
  if (target.surface && target.entity) {
    if (target.surface.environment !== target.entity.environment) errors.push('target surface/entity environments must match');
    if (target.entity.surfaceId !== undefined && target.surface.surfaceId !== target.entity.surfaceId) {
      errors.push('target entity surfaceId must match target surface');
    }
  }
  if (step.request.target && (!target.entity || !sameComputerEntity(step.request.target, target.entity))) {
    errors.push('request target must match action target entity');
  }
  return errors;
}

export function normalizeComputerTaskObservationRequest(
  request: ComputerObservationRequest,
): ComputerObservationRequest {
  return {
    ...request,
    limits: {
      maxItems: request.limits?.maxItems ?? COMPUTER_TASK_DEFAULT_OBSERVATION_LIMITS.maxItems,
      maxTextBytes: request.limits?.maxTextBytes ?? COMPUTER_TASK_DEFAULT_OBSERVATION_LIMITS.maxTextBytes,
      maxDepth: request.limits?.maxDepth ?? COMPUTER_TASK_DEFAULT_OBSERVATION_LIMITS.maxDepth,
    },
  };
}

export function validateComputerTaskProgram(program: ComputerTaskProgram): string[] {
  const errors: string[] = [];
  if (!boundedIdentifier(program.id, 128)) errors.push('program id must be a bounded identifier');
  if (!boundedIdentifier(program.entry, 128)) errors.push('program entry must be a bounded identifier');
  if (!Array.isArray(program.steps) || program.steps.length === 0 || program.steps.length > 512) {
    errors.push('program steps must contain 1 to 512 entries');
    return errors;
  }

  const ids = new Set<string>();
  for (const step of program.steps) {
    if (!boundedIdentifier(step.id, 128)) errors.push('step id must be a bounded identifier');
    if (ids.has(step.id)) errors.push(`duplicate step id: ${step.id}`);
    ids.add(step.id);

    errors.push(...validateRequirements(step.requirements, step.request.adapterId).map((error) => `${step.id}: ${error}`));
    if (step.kind === 'observe') {
      errors.push(...validateObservationLimits(step).map((error) => `${step.id}: ${error}`));
    } else {
      if (step.request.actionId !== step.id) errors.push(`${step.id}: request actionId must match step id`);
      if (step.maxRetries !== undefined && (
        !Number.isSafeInteger(step.maxRetries) || step.maxRetries < 0 || step.maxRetries > COMPUTER_TASK_MAX_RETRIES
      )) {
        errors.push(`${step.id}: maxRetries must be 0 to ${COMPUTER_TASK_MAX_RETRIES}`);
      }
      if (step.verification !== undefined && !boundedIdentifier(step.verification, 128)) {
        errors.push(`${step.id}: verification key must be bounded`);
      }
      if (step.checkpointBinding !== undefined && !validCheckpointBinding(step.checkpointBinding)) {
        errors.push(`${step.id}: checkpointBinding must be a non-secret trusted binding of 16 to 256 UTF-8 bytes`);
      }
      if (step.request.payload !== undefined && step.checkpointBinding === undefined) {
        errors.push(`${step.id}: payload-bearing actions require checkpointBinding`);
      }
      errors.push(...validateTarget(step).map((error) => `${step.id}: ${error}`));
    }
  }

  if (!ids.has(program.entry)) errors.push('program entry does not name a step');
  for (const step of program.steps) {
    const edges = step.kind === 'observe' ? [step.next] : [step.onSuccess, step.onFailure];
    for (const edge of edges) {
      if (edge !== undefined && !ids.has(edge)) errors.push(`${step.id}: transition references missing step ${edge}`);
    }
  }
  return errors;
}

interface SnapshotBudget {
  items: number;
  bytes: number;
  active: WeakSet<object>;
}

function accountSnapshot(budget: SnapshotBudget, bytes: number, path: string): void {
  budget.items += 1;
  budget.bytes += bytes;
  if (budget.items > COMPUTER_TASK_MAX_SNAPSHOT_ITEMS) throw new Error(`${path} exceeds executable snapshot item budget`);
  if (budget.bytes > COMPUTER_TASK_MAX_SNAPSHOT_BYTES) throw new Error(`${path} exceeds executable snapshot byte budget`);
}

function snapshotExecutableValue<T>(value: T, path: string, depth: number, budget: SnapshotBudget): T {
  if (depth > COMPUTER_TASK_MAX_SNAPSHOT_DEPTH) throw new Error(`${path} exceeds executable snapshot depth budget`);
  if (value === null || value === undefined || typeof value === 'boolean') {
    accountSnapshot(budget, 1, path);
    return value;
  }
  if (typeof value === 'string') {
    accountSnapshot(budget, new TextEncoder().encode(value).byteLength, path);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    accountSnapshot(budget, 8, path);
    return value;
  }
  if (typeof value !== 'object') throw new Error(`${path} contains a non-snapshotable executable value`);

  const object = value as object;
  if (budget.active.has(object)) throw new Error(`${path} contains a cyclic executable value`);
  budget.active.add(object);
  try {
    if (Array.isArray(value)) {
      accountSnapshot(budget, value.length, path);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      for (const key of keys) {
        if (typeof key !== 'string') throw new Error(`${path} contains a symbol property`);
        const descriptor = descriptors[key]!;
        if ('get' in descriptor || 'set' in descriptor) throw new Error(`${path}.${key} contains an accessor property`);
        if (key === 'length') continue;
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
          throw new Error(`${path} contains a non-index array property`);
        }
      }
      const clone = new Array(value.length) as unknown[];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) continue;
        clone[index] = snapshotExecutableValue(descriptor.value, `${path}[${index}]`, depth + 1, budget);
      }
      return Object.freeze(clone) as T;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain snapshotable objects and arrays`);
    }
    accountSnapshot(budget, 1, path);
    const descriptors = Object.getOwnPropertyDescriptors(value as object);
    const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new Error(`${path} contains a symbol property`);
      const descriptor = descriptors[key]!;
      if ('get' in descriptor || 'set' in descriptor) throw new Error(`${path}.${key} contains an accessor property`);
      if (!descriptor.enumerable) throw new Error(`${path}.${key} contains a non-enumerable executable property`);
      accountSnapshot(budget, new TextEncoder().encode(key).byteLength, `${path}.${key}`);
      clone[key] = snapshotExecutableValue(descriptor.value, `${path}.${key}`, depth + 1, budget);
    }
    return Object.freeze(clone) as T;
  } finally {
    budget.active.delete(object);
  }
}

/**
 * Creates the immutable executable representation used by the runtime across all awaited gates.
 * Snapshotting happens before semantic validation so accessors cannot drift between the two phases.
 */
export function snapshotComputerTaskProgram(program: ComputerTaskProgram): ComputerTaskProgram {
  const snapshot = snapshotExecutableValue(program, 'program', 0, {
    items: 0,
    bytes: 0,
    active: new WeakSet<object>(),
  });
  const errors = validateComputerTaskProgram(snapshot);
  if (errors.length > 0) throw new Error(`invalid computer task program: ${errors.join('; ')}`);
  return snapshot;
}
