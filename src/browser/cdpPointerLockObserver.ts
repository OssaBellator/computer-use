import type { CdpSessionLike } from './cdpIdentity.js';
import type {
  PointerCaptureObservation,
  PointerLockObservation,
  PointerLockOwnerIdentity,
} from './pointerLockState.js';

export interface PointerLockGameRegionIdentity {
  backendNodeId?: number;
  generation?: number;
}

export interface CdpPointerLockObserverOptions {
  targetId?: string;
  sessionId?: string;
  /** Owner metadata. For non-main frames, also use that frame's CDP session or executionContextId. */
  frameId?: string;
  executionContextId?: number;
  gameRegion?: () => PointerLockGameRegionIdentity | undefined;
}

interface RuntimeEvaluateResult {
  result?: {
    objectId?: string;
    value?: unknown;
  };
}

interface DescribedNodeResult {
  node?: {
    backendNodeId?: number;
    localName?: string;
    nodeName?: string;
    attributes?: string[];
    frameId?: string;
  };
}

interface ResolvedNodeResult {
  object?: { objectId?: string };
}

function attributesObject(attributes: string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index + 1 < (attributes?.length ?? 0); index += 2) {
    result[attributes![index]] = attributes![index + 1];
  }
  return result;
}

function finitePointerId(pointerId: number): void {
  if (!Number.isInteger(pointerId) || pointerId < 0) {
    throw new Error('pointerId must be a non-negative integer');
  }
}

/**
 * Browser-native pointer-lock and pointer-capture observation through CDP.
 * Page JavaScript is queried for authoritative DOM state, but no page-side
 * input events are synthesized.
 */
export class CdpPointerLockObserver {
  constructor(
    private readonly session: CdpSessionLike,
    private readonly options: CdpPointerLockObserverOptions = {},
  ) {}

  private runtimeParams(expression: string, returnByValue: boolean): Record<string, unknown> {
    return {
      expression,
      returnByValue,
      awaitPromise: false,
      ...(this.options.executionContextId === undefined
        ? {}
        : { contextId: this.options.executionContextId }),
    };
  }

  private baseOwner(): PointerLockOwnerIdentity {
    return {
      ...(this.options.targetId ? { targetId: this.options.targetId } : {}),
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
      ...(this.options.frameId ? { frameId: this.options.frameId } : {}),
    };
  }

  private gameRegionAssociation(
    backendNodeId: number | undefined,
    gameRegion: PointerLockGameRegionIdentity | undefined,
  ): Pick<PointerLockOwnerIdentity, 'gameRegionBackendNodeId' | 'gameRegionGeneration'> {
    if (
      backendNodeId === undefined ||
      gameRegion?.backendNodeId === undefined ||
      backendNodeId !== gameRegion.backendNodeId
    ) {
      return {};
    }
    return {
      gameRegionBackendNodeId: gameRegion.backendNodeId,
      ...(gameRegion.generation === undefined ? {} : { gameRegionGeneration: gameRegion.generation }),
    };
  }

  private async describeOwner(
    params: { objectId?: string; backendNodeId?: number },
    gameRegion: PointerLockGameRegionIdentity | undefined,
  ): Promise<PointerLockOwnerIdentity> {
    const described = await this.session.send('DOM.describeNode', params) as DescribedNodeResult;
    const node = described.node;
    const attributes = attributesObject(node?.attributes);
    const tag = (node?.localName || node?.nodeName || '').toLowerCase();
    const backendNodeId = typeof node?.backendNodeId === 'number' ? node.backendNodeId : undefined;
    return {
      ...this.baseOwner(),
      ...(node?.frameId || this.options.frameId
        ? { frameId: node?.frameId ?? this.options.frameId }
        : {}),
      ...(backendNodeId === undefined ? {} : { backendNodeId }),
      ...this.gameRegionAssociation(backendNodeId, gameRegion),
      ...(tag ? { elementTag: tag } : {}),
      ...(attributes.id ? { elementId: attributes.id } : {}),
    };
  }

  async observeLock(): Promise<PointerLockObservation> {
    const evaluated = await this.session.send(
      'Runtime.evaluate',
      this.runtimeParams(`(() => ({
        supported: 'pointerLockElement' in document &&
          typeof Element.prototype.requestPointerLock === 'function',
        locked: !!document.pointerLockElement,
        focused: typeof document.hasFocus === 'function' ? document.hasFocus() : undefined,
      }))()`, true),
    ) as RuntimeEvaluateResult;
    const value = evaluated.result?.value as {
      supported?: unknown;
      locked?: unknown;
      focused?: unknown;
    } | undefined;
    if (!value || typeof value.supported !== 'boolean' || typeof value.locked !== 'boolean') {
      throw new Error('Pointer-lock observation did not return a boolean state');
    }

    const observation: PointerLockObservation = {
      supported: value.supported,
      locked: value.locked,
      ...(typeof value.focused === 'boolean' ? { focused: value.focused } : {}),
    };
    if (!value.locked) return observation;

    const element = await this.session.send(
      'Runtime.evaluate',
      this.runtimeParams('document.pointerLockElement', false),
    ) as RuntimeEvaluateResult;
    const objectId = element.result?.objectId;
    if (!objectId) {
      // Lock truth is still authoritative, but element/game-region identity
      // could not be re-resolved, so do not inherit stale renderer identity.
      return { ...observation, owner: this.baseOwner() };
    }

    const gameRegion = this.options.gameRegion?.();
    try {
      const owner = await this.describeOwner({ objectId }, gameRegion);
      const comparable = owner.backendNodeId !== undefined && gameRegion?.backendNodeId !== undefined;
      return {
        ...observation,
        owner,
        ...(comparable ? { gameRegionMatch: owner.backendNodeId === gameRegion!.backendNodeId } : {}),
      };
    } finally {
      try {
        await this.session.send('Runtime.releaseObject', { objectId });
      } catch {
        // Best-effort cleanup only; a navigated context may already be gone.
      }
    }
  }

  async observeCapture(
    pointerId: number,
    backendNodeId: number,
  ): Promise<PointerCaptureObservation> {
    finitePointerId(pointerId);
    if (!Number.isInteger(backendNodeId) || backendNodeId < 1) {
      throw new Error('backendNodeId must be a positive integer');
    }

    const resolved = await this.session.send('DOM.resolveNode', { backendNodeId }) as ResolvedNodeResult;
    const objectId = resolved.object?.objectId;
    if (!objectId) {
      return {
        pointerId,
        supported: true,
        captured: false,
        owner: { ...this.baseOwner(), backendNodeId },
        lossReason: 'element-detached',
      };
    }

    const gameRegion = this.options.gameRegion?.();
    try {
      const called = await this.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(pointerId) {
          const supported = typeof this.hasPointerCapture === 'function';
          return { supported, captured: supported && this.hasPointerCapture(pointerId) };
        }`,
        arguments: [{ value: pointerId }],
        returnByValue: true,
      }) as RuntimeEvaluateResult;
      const value = called.result?.value as { supported?: unknown; captured?: unknown } | undefined;
      if (!value || typeof value.supported !== 'boolean' || typeof value.captured !== 'boolean') {
        throw new Error('Pointer-capture observation did not return a boolean state');
      }
      return {
        pointerId,
        supported: value.supported,
        captured: value.captured,
        owner: await this.describeOwner({ backendNodeId }, gameRegion),
      };
    } finally {
      try {
        await this.session.send('Runtime.releaseObject', { objectId });
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}
