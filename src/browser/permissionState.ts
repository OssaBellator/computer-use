import type { CdpSessionLike } from './cdpIdentity.js';

export type PermissionDecision = 'granted' | 'denied' | 'prompt' | 'unknown';
export type PermissionPolicyDecision = 'allowed' | 'blocked' | 'not-applicable' | 'unknown';

export type StandardPermissionName =
  | 'camera'
  | 'microphone'
  | 'notifications'
  | 'geolocation'
  | 'clipboard-read'
  | 'clipboard-write';

export type PermissionName = StandardPermissionName | (string & {});

export const DEFAULT_PERMISSION_NAMES: readonly StandardPermissionName[] = [
  'camera',
  'microphone',
  'notifications',
  'geolocation',
  'clipboard-read',
  'clipboard-write',
] as const;

export interface PermissionPolicyState {
  state: PermissionPolicyDecision;
  feature?: string;
  blockReason?: string;
  blockerFrameId?: string;
}

export interface PermissionObservation {
  name: PermissionName;
  /** Effective state reported to this frame, adjusted for an explicit Permissions Policy block. */
  state: PermissionDecision;
  /** navigator.permissions state in the observed frame, when the browser exposes it. */
  pageState: PermissionDecision;
  /** Underlying browser/profile decision remains unknown because CDP exposes mutation but no general readback. */
  browserState: 'unknown';
  policy: PermissionPolicyState;
  pageStateSource: 'permissions-api' | 'unavailable';
  browserStateSource: 'cdp-readback-unavailable';
  errorText?: string;
}

export interface PermissionFrameState {
  frameId: string;
  origin?: string;
  secureContext?: boolean;
  permissions: PermissionObservation[];
}

export interface PermissionObservationError {
  scope: 'frames' | 'frame' | 'permissions-api' | 'permissions-policy';
  operation: string;
  frameId?: string;
  message: string;
}

export interface PermissionStateSnapshot {
  frames: PermissionFrameState[];
  truncated: boolean;
  errors: PermissionObservationError[];
}

export interface ObservePermissionStateOptions {
  permissions?: readonly PermissionName[];
  maxFrames?: number;
  maxPermissions?: number;
  maxErrors?: number;
  maxTextLength?: number;
}

interface RawFrame { id: string; }
interface RawFrameTree { frame: RawFrame; childFrames?: RawFrameTree[]; }
interface RawPolicyState {
  feature?: unknown;
  allowed?: unknown;
  locator?: { frameId?: unknown; blockReason?: unknown; };
}
interface RawPermissionQueryResult { name?: unknown; state?: unknown; error?: unknown; }
interface RawPagePermissionResult { origin?: unknown; secureContext?: unknown; apiAvailable?: unknown; results?: unknown; }

const DEFAULT_MAX_FRAMES = 16;
const DEFAULT_MAX_PERMISSIONS = 16;
const DEFAULT_MAX_ERRORS = 16;
const DEFAULT_MAX_TEXT_LENGTH = 256;

const POLICY_FEATURE_BY_PERMISSION: Readonly<Record<StandardPermissionName, string | undefined>> = {
  camera: 'camera',
  microphone: 'microphone',
  notifications: undefined,
  geolocation: 'geolocation',
  'clipboard-read': 'clipboard-read',
  'clipboard-write': 'clipboard-write',
};

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}
function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
}
function errorMessage(error: unknown, maxTextLength: number): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= maxTextLength ? text : text.slice(0, maxTextLength);
}
function parseDecision(value: unknown): PermissionDecision {
  return value === 'granted' || value === 'denied' || value === 'prompt' ? value : 'unknown';
}
function flattenFrames(frameTree: RawFrameTree, maxFrames: number): { frames: string[]; truncated: boolean } {
  const frames: string[] = [];
  let truncated = false;
  const visit = (tree: RawFrameTree) => {
    if (frames.length >= maxFrames) { truncated = true; return; }
    frames.push(tree.frame.id);
    for (const child of tree.childFrames ?? []) visit(child);
  };
  visit(frameTree);
  return { frames, truncated };
}
function standardPermission(name: PermissionName): StandardPermissionName | undefined {
  return (DEFAULT_PERMISSION_NAMES as readonly string[]).includes(name) ? name as StandardPermissionName : undefined;
}

function normalizeRequestedPermissions(
  values: readonly PermissionName[],
  maxPermissions: number,
  maxTextLength: number,
): { permissions: PermissionName[]; truncated: boolean } {
  const permissions: PermissionName[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (!normalized) continue;
    if (normalized.length > maxTextLength) {
      truncated = true;
      continue;
    }
    if (seen.has(normalized)) continue;
    if (permissions.length >= maxPermissions) {
      truncated = true;
      continue;
    }
    seen.add(normalized);
    permissions.push(normalized as PermissionName);
  }
  return { permissions, truncated };
}

async function createWorld(session: CdpSessionLike, frameId: string): Promise<number> {
  const result = await session.send('Page.createIsolatedWorld', { frameId, worldName: 'browser-automation-permission-observer' });
  if (!Number.isInteger(result?.executionContextId)) throw new Error('Page.createIsolatedWorld returned no executionContextId');
  return result.executionContextId;
}

function permissionExpression(names: readonly PermissionName[], maxTextLength: number): string {
  return `(async () => {
    const names = ${JSON.stringify(names)};
    const maxTextLength = ${maxTextLength};
    const text = (value) => String(value ?? '').slice(0, maxTextLength);
    const apiAvailable = Boolean(navigator.permissions && typeof navigator.permissions.query === 'function');
    const results = [];
    if (apiAvailable) {
      for (const name of names) {
        try {
          const status = await navigator.permissions.query({ name });
          results.push({ name, state: status && status.state });
        } catch (error) {
          results.push({ name, state: 'unknown', error: text(error && (error.message || error.name || error)) });
        }
      }
    }
    return {
      origin: location.origin,
      secureContext: Boolean(globalThis.isSecureContext),
      apiAvailable,
      results,
    };
  })()`;
}

async function evaluatePermissions(session: CdpSessionLike, contextId: number, names: readonly PermissionName[], maxTextLength: number): Promise<RawPagePermissionResult> {
  const result = await session.send('Runtime.evaluate', {
    expression: permissionExpression(names, maxTextLength),
    contextId,
    awaitPromise: true,
    returnByValue: true,
    silent: true,
  });
  if (result?.exceptionDetails) {
    const description = result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text ?? 'runtime exception';
    throw new Error(String(description));
  }
  return (result?.result?.value ?? {}) as RawPagePermissionResult;
}

function policyForPermission(name: PermissionName, states: readonly RawPolicyState[] | undefined, maxTextLength: number): PermissionPolicyState {
  const standard = standardPermission(name);
  let feature: string | undefined;
  if (standard) {
    feature = POLICY_FEATURE_BY_PERMISSION[standard];
    if (!feature) return { state: 'not-applicable' };
  } else if (states) {
    feature = states.some((state) => state?.feature === name) ? name : undefined;
    if (!feature) return { state: 'not-applicable' };
  } else {
    // For extension permission names we cannot tell whether an unavailable policy call
    // would have exposed a same-named Permissions Policy feature.
    return { state: 'unknown' };
  }

  if (!states) return { state: 'unknown', feature };
  const raw = states.find((state) => state?.feature === feature);
  if (!raw || typeof raw.allowed !== 'boolean') return { state: 'unknown', feature };
  return {
    state: raw.allowed ? 'allowed' : 'blocked',
    feature,
    blockReason: raw.allowed ? undefined : boundedText(raw.locator?.blockReason, maxTextLength),
    blockerFrameId: raw.allowed ? undefined : boundedText(raw.locator?.frameId, maxTextLength),
  };
}

/** Observe effective permission state without granting, denying, resetting, or otherwise mutating permissions. */
export async function observePermissionState(session: CdpSessionLike, options: ObservePermissionStateOptions = {}): Promise<PermissionStateSnapshot> {
  const maxFrames = boundedInteger(options.maxFrames, DEFAULT_MAX_FRAMES, 1, 128);
  const maxPermissions = boundedInteger(options.maxPermissions, DEFAULT_MAX_PERMISSIONS, 1, 64);
  const maxErrors = boundedInteger(options.maxErrors, DEFAULT_MAX_ERRORS, 1, 128);
  const maxTextLength = boundedInteger(options.maxTextLength, DEFAULT_MAX_TEXT_LENGTH, 32, 2048);
  const normalized = normalizeRequestedPermissions(options.permissions ?? DEFAULT_PERMISSION_NAMES, maxPermissions, maxTextLength);
  const requested = normalized.permissions;
  let truncated = normalized.truncated;

  const errors: PermissionObservationError[] = [];
  let errorsTruncated = false;
  const recordError = (error: PermissionObservationError) => {
    if (errors.length < maxErrors) errors.push(error);
    else errorsTruncated = true;
  };

  let frameIds: string[] = [];
  try {
    const result = await session.send('Page.getFrameTree');
    if (!result?.frameTree?.frame?.id) throw new Error('Page.getFrameTree returned no root frame');
    const flattened = flattenFrames(result.frameTree as RawFrameTree, maxFrames);
    frameIds = flattened.frames;
    truncated ||= flattened.truncated;
  } catch (error) {
    recordError({ scope: 'frames', operation: 'Page.getFrameTree', message: errorMessage(error, maxTextLength) });
  }

  const frames: PermissionFrameState[] = [];
  for (const frameId of frameIds) {
    let policyStates: RawPolicyState[] | undefined;
    try {
      const policyResult = await session.send('Page.getPermissionsPolicyState', { frameId });
      if (Array.isArray(policyResult?.states)) policyStates = policyResult.states as RawPolicyState[];
    } catch (error) {
      recordError({ scope: 'permissions-policy', operation: 'Page.getPermissionsPolicyState', frameId, message: errorMessage(error, maxTextLength) });
    }

    let pageResult: RawPagePermissionResult = {};
    try {
      const contextId = await createWorld(session, frameId);
      pageResult = await evaluatePermissions(session, contextId, requested, maxTextLength);
    } catch (error) {
      recordError({ scope: 'permissions-api', operation: 'navigator.permissions.query', frameId, message: errorMessage(error, maxTextLength) });
    }

    const rawResults = Array.isArray(pageResult.results) ? pageResult.results as RawPermissionQueryResult[] : [];
    const apiAvailable = pageResult.apiAvailable === true;
    const permissions = requested.map((name): PermissionObservation => {
      const raw = rawResults.find((result) => result?.name === name);
      const pageState = apiAvailable ? parseDecision(raw?.state) : 'unknown';
      const policy = policyForPermission(name, policyStates, maxTextLength);
      const state: PermissionDecision = policy.state === 'blocked' ? 'denied' : pageState;
      return {
        name,
        state,
        pageState,
        browserState: 'unknown',
        policy,
        pageStateSource: apiAvailable ? 'permissions-api' : 'unavailable',
        browserStateSource: 'cdp-readback-unavailable',
        errorText: boundedText(raw?.error, maxTextLength),
      };
    });

    frames.push({
      frameId,
      origin: boundedText(pageResult.origin, maxTextLength * 2),
      secureContext: typeof pageResult.secureContext === 'boolean' ? pageResult.secureContext : undefined,
      permissions,
    });
  }

  return { frames, truncated: truncated || errorsTruncated, errors };
}
