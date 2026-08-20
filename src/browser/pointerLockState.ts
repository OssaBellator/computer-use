export type PointerLockPhase = 'unlocked' | 'requested' | 'locked' | 'lost';

export type PointerLockLossReason =
  | 'focus-lost'
  | 'escape'
  | 'navigation'
  | 'renderer-replaced'
  | 'target-changed'
  | 'element-detached'
  | 'unknown';

export type PointerLockRequestFailure =
  | 'unsupported'
  | 'request-rejected'
  | 'request-timeout'
  | 'identity-mismatch';

export interface PointerLockOwnerIdentity {
  targetId?: string;
  sessionId?: string;
  frameId?: string;
  backendNodeId?: number;
  gameRegionBackendNodeId?: number;
  gameRegionGeneration?: number;
  elementTag?: string;
  elementId?: string;
}

export interface PointerLockObservation {
  supported: boolean;
  locked: boolean;
  focused?: boolean;
  owner?: PointerLockOwnerIdentity;
}

export interface PointerLockSnapshot {
  phase: PointerLockPhase;
  generation: number;
  supported?: boolean;
  owner?: PointerLockOwnerIdentity;
  requestedOwner?: PointerLockOwnerIdentity;
  lossReason?: PointerLockLossReason;
  requestFailure?: PointerLockRequestFailure;
}

const OWNER_KEYS: readonly (keyof PointerLockOwnerIdentity)[] = [
  'targetId',
  'sessionId',
  'frameId',
  'backendNodeId',
  'gameRegionBackendNodeId',
  'gameRegionGeneration',
  'elementTag',
  'elementId',
];

function cloneOwner(owner: PointerLockOwnerIdentity | undefined): PointerLockOwnerIdentity | undefined {
  return owner ? { ...owner } : undefined;
}

function ownerHasIdentity(owner: PointerLockOwnerIdentity | undefined): boolean {
  return !!owner && OWNER_KEYS.some((key) => owner[key] !== undefined);
}

function sameOwner(a: PointerLockOwnerIdentity | undefined, b: PointerLockOwnerIdentity | undefined): boolean {
  if (!ownerHasIdentity(a) && !ownerHasIdentity(b)) return true;
  return OWNER_KEYS.every((key) => a?.[key] === b?.[key]);
}

/**
 * Match a possibly-partial expected owner against an observed pointer-lock owner.
 * Only identity fields supplied by the caller are required to match.
 */
export function pointerLockOwnerMatches(
  expected: PointerLockOwnerIdentity | undefined,
  actual: PointerLockOwnerIdentity | undefined,
): boolean {
  if (!ownerHasIdentity(expected)) return true;
  if (!actual) return false;
  return OWNER_KEYS.every((key) => expected?.[key] === undefined || expected[key] === actual[key]);
}

/** Pure deterministic state holder for browser pointer-lock lifecycle observations. */
export class PointerLockLifecycle {
  private snapshot: PointerLockSnapshot = { phase: 'unlocked', generation: 0 };

  current(): PointerLockSnapshot {
    return {
      ...this.snapshot,
      owner: cloneOwner(this.snapshot.owner),
      requestedOwner: cloneOwner(this.snapshot.requestedOwner),
    };
  }

  beginRequest(owner?: PointerLockOwnerIdentity): PointerLockSnapshot {
    this.snapshot = {
      phase: 'requested',
      generation: this.snapshot.generation,
      supported: this.snapshot.supported,
      requestedOwner: cloneOwner(owner),
    };
    return this.current();
  }

  observe(
    observation: PointerLockObservation,
    lossReasonHint?: PointerLockLossReason,
  ): PointerLockSnapshot {
    const previous = this.snapshot;

    if (!observation.supported) {
      if (previous.phase === 'requested') {
        this.snapshot = {
          phase: 'unlocked',
          generation: previous.generation,
          supported: false,
          requestFailure: 'unsupported',
        };
      } else if (previous.phase === 'locked') {
        this.snapshot = {
          phase: 'lost',
          generation: previous.generation,
          supported: false,
          owner: cloneOwner(previous.owner),
          lossReason: lossReasonHint ?? 'unknown',
        };
      } else {
        this.snapshot = { ...previous, supported: false };
      }
      return this.current();
    }

    if (observation.locked) {
      const owner = cloneOwner(observation.owner ?? previous.requestedOwner ?? previous.owner);
      const generation = previous.phase !== 'locked' || !sameOwner(previous.owner, owner)
        ? previous.generation + 1
        : previous.generation;
      this.snapshot = {
        phase: 'locked',
        generation,
        supported: true,
        owner,
      };
      return this.current();
    }

    if (previous.phase === 'locked') {
      this.snapshot = {
        phase: 'lost',
        generation: previous.generation,
        supported: true,
        owner: cloneOwner(previous.owner),
        lossReason: lossReasonHint ?? (observation.focused === false ? 'focus-lost' : 'unknown'),
      };
      return this.current();
    }

    if (previous.phase === 'requested') {
      this.snapshot = { ...previous, supported: true };
      return this.current();
    }

    if (previous.phase === 'lost') {
      this.snapshot = { ...previous, supported: true };
      return this.current();
    }

    this.snapshot = {
      phase: 'unlocked',
      generation: previous.generation,
      supported: true,
      ...(previous.requestFailure ? { requestFailure: previous.requestFailure } : {}),
    };
    return this.current();
  }

  markRequestFailed(failure: PointerLockRequestFailure): PointerLockSnapshot {
    const owner = this.snapshot.requestedOwner;
    this.snapshot = {
      phase: 'unlocked',
      generation: this.snapshot.generation,
      supported: failure === 'unsupported' ? false : this.snapshot.supported,
      ...(owner ? { requestedOwner: cloneOwner(owner) } : {}),
      requestFailure: failure,
    };
    return this.current();
  }

  markLoss(reason: PointerLockLossReason): PointerLockSnapshot {
    if (this.snapshot.phase === 'unlocked') return this.current();
    const owner = this.snapshot.owner ?? this.snapshot.requestedOwner;
    this.snapshot = {
      phase: 'lost',
      generation: this.snapshot.generation,
      supported: this.snapshot.supported,
      ...(owner ? { owner: cloneOwner(owner) } : {}),
      lossReason: reason,
    };
    return this.current();
  }

  markUnlocked(): PointerLockSnapshot {
    this.snapshot = {
      phase: 'unlocked',
      generation: this.snapshot.generation,
      supported: this.snapshot.supported,
    };
    return this.current();
  }
}

export type PointerCapturePhase = 'uncaptured' | 'captured' | 'lost';
export type PointerCaptureLossReason =
  | 'navigation'
  | 'renderer-replaced'
  | 'target-changed'
  | 'element-detached'
  | 'unknown';

export interface PointerCaptureObservation {
  pointerId: number;
  supported: boolean;
  captured: boolean;
  owner?: PointerLockOwnerIdentity;
}

export interface PointerCaptureSnapshot {
  pointerId: number;
  phase: PointerCapturePhase;
  generation: number;
  supported?: boolean;
  owner?: PointerLockOwnerIdentity;
  lossReason?: PointerCaptureLossReason;
}

/** Track independent pointer-capture ownership for active pointer ids. */
export class PointerCaptureLifecycle {
  private readonly captures = new Map<number, PointerCaptureSnapshot>();

  current(pointerId: number): PointerCaptureSnapshot {
    const state = this.captures.get(pointerId) ?? {
      pointerId,
      phase: 'uncaptured' as const,
      generation: 0,
    };
    return { ...state, owner: cloneOwner(state.owner) };
  }

  observe(
    observation: PointerCaptureObservation,
    lossReasonHint?: PointerCaptureLossReason,
  ): PointerCaptureSnapshot {
    const previous = this.current(observation.pointerId);
    if (!observation.supported) {
      const state: PointerCaptureSnapshot = {
        pointerId: observation.pointerId,
        phase: previous.phase === 'captured' ? 'lost' : 'uncaptured',
        generation: previous.generation,
        supported: false,
        ...(previous.owner ? { owner: cloneOwner(previous.owner) } : {}),
        ...(previous.phase === 'captured'
          ? { lossReason: (lossReasonHint ?? 'unknown') as PointerCaptureLossReason }
          : {}),
      };
      this.captures.set(observation.pointerId, state);
      return this.current(observation.pointerId);
    }

    if (observation.captured) {
      const owner = cloneOwner(observation.owner);
      const generation = previous.phase !== 'captured' || !sameOwner(previous.owner, owner)
        ? previous.generation + 1
        : previous.generation;
      this.captures.set(observation.pointerId, {
        pointerId: observation.pointerId,
        phase: 'captured',
        generation,
        supported: true,
        owner,
      });
      return this.current(observation.pointerId);
    }

    if (previous.phase === 'captured') {
      this.captures.set(observation.pointerId, {
        pointerId: observation.pointerId,
        phase: 'lost',
        generation: previous.generation,
        supported: true,
        owner: cloneOwner(previous.owner),
        lossReason: lossReasonHint ?? 'unknown',
      });
      return this.current(observation.pointerId);
    }

    this.captures.set(observation.pointerId, {
      pointerId: observation.pointerId,
      phase: 'uncaptured',
      generation: previous.generation,
      supported: true,
    });
    return this.current(observation.pointerId);
  }

  release(pointerId: number): PointerCaptureSnapshot {
    const previous = this.current(pointerId);
    this.captures.set(pointerId, {
      pointerId,
      phase: 'uncaptured',
      generation: previous.generation,
      supported: previous.supported,
    });
    return this.current(pointerId);
  }

  markLoss(pointerId: number, reason: PointerCaptureLossReason): PointerCaptureSnapshot {
    const previous = this.current(pointerId);
    if (previous.phase === 'uncaptured') return previous;
    this.captures.set(pointerId, {
      pointerId,
      phase: 'lost',
      generation: previous.generation,
      supported: previous.supported,
      ...(previous.owner ? { owner: cloneOwner(previous.owner) } : {}),
      lossReason: reason,
    });
    return this.current(pointerId);
  }
}
