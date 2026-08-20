import type { BrowserInput } from '../input/browserInput.js';
import type { Point } from '../types.js';
import {
  PointerLockLifecycle,
  pointerLockOwnerMatches,
  type PointerLockLossReason,
  type PointerLockObservation,
  type PointerLockOwnerIdentity,
  type PointerLockSnapshot,
} from '../browser/pointerLockState.js';

export interface PointerLockObserverLike {
  observeLock(): Promise<PointerLockObservation>;
}

export interface PointerLockAcquireAttempt {
  attempt: number;
  maxAttempts: number;
  owner?: PointerLockOwnerIdentity;
  state: PointerLockSnapshot;
}

export interface PointerLockAcquireOptions {
  owner?: PointerLockOwnerIdentity;
  request(context: PointerLockAcquireAttempt): Promise<void>;
  /** Hard bounded request count. Defaults to 1 and may not exceed 4. */
  maxAttempts?: number;
  /** Observations after each request. Defaults to 8 and may not exceed 32. */
  pollsPerAttempt?: number;
  /** Delay between polls. Defaults to 25 ms and may not exceed 1 second. */
  pollIntervalMs?: number;
  /** Optional bounded retry gate consulted only between attempts. */
  shouldRetry?(result: PointerLockAcquireResult): boolean | Promise<boolean>;
}

export type PointerLockRecoveryPolicy = Omit<PointerLockAcquireOptions, 'owner'>;

export type PointerLockAcquireStatus =
  | 'locked'
  | 'unsupported'
  | 'request-rejected'
  | 'timed-out'
  | 'identity-mismatch';

export interface PointerLockAcquireResult {
  status: PointerLockAcquireStatus;
  attempts: number;
  observations: number;
  state: PointerLockSnapshot;
}

export type PointerLockRequirement = 'none' | 'preferred' | 'required';

export interface RelativePointerDegradedEvent {
  delta: Point;
  status: Exclude<PointerLockAcquireStatus, 'locked'> | 'unavailable';
  state: PointerLockSnapshot;
}

export interface MoveRelativeWithLockOptions {
  requirement?: PointerLockRequirement;
  owner?: PointerLockOwnerIdentity;
  recovery?: PointerLockRecoveryPolicy;
  onDegraded?(event: RelativePointerDegradedEvent): void | Promise<void>;
}

export interface RelativePointerResult {
  status: 'dispatched' | 'degraded';
  state: PointerLockSnapshot;
}

export interface PointerLockControllerOptions {
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function boundedInteger(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min},${max}]`);
  }
  return value;
}

function boundedDelay(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1_000) {
    throw new Error('pollIntervalMs must be finite and in [0,1000]');
  }
  return value;
}

function finiteDelta(delta: Point): void {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) {
    throw new Error('relative pointer delta coordinates must be finite');
  }
}

export class PointerLockRequiredError extends Error {
  constructor(
    readonly status: RelativePointerDegradedEvent['status'],
    readonly state: PointerLockSnapshot,
  ) {
    super(`Pointer lock is required for relative movement (${status})`);
    this.name = 'PointerLockRequiredError';
  }
}

/**
 * Bounded pointer-lock acquisition/recovery plus fail-closed relative movement.
 * Callers own the page's normal activation flow through request(); this class
 * never bypasses browser user-activation, focus, or permission rules.
 */
export class PointerLockController {
  readonly lifecycle = new PointerLockLifecycle();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly input: BrowserInput,
    private readonly observer: PointerLockObserverLike,
    options: PointerLockControllerOptions = {},
  ) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  current(): PointerLockSnapshot {
    return this.lifecycle.current();
  }

  async observe(lossReasonHint?: PointerLockLossReason): Promise<PointerLockSnapshot> {
    return this.lifecycle.observe(await this.observer.observeLock(), lossReasonHint);
  }

  noteLoss(reason: PointerLockLossReason): PointerLockSnapshot {
    return this.lifecycle.markLoss(reason);
  }

  noteNavigation(): PointerLockSnapshot { return this.noteLoss('navigation'); }
  noteRendererReplacement(): PointerLockSnapshot { return this.noteLoss('renderer-replaced'); }
  noteTargetChange(): PointerLockSnapshot { return this.noteLoss('target-changed'); }
  noteEscape(): PointerLockSnapshot { return this.noteLoss('escape'); }
  noteFocusLoss(): PointerLockSnapshot { return this.noteLoss('focus-lost'); }

  async acquire(options: PointerLockAcquireOptions): Promise<PointerLockAcquireResult> {
    const maxAttempts = boundedInteger('maxAttempts', options.maxAttempts ?? 1, 1, 4);
    const pollsPerAttempt = boundedInteger('pollsPerAttempt', options.pollsPerAttempt ?? 8, 1, 32);
    const pollIntervalMs = boundedDelay(options.pollIntervalMs ?? 25);
    let observations = 0;
    let lastResult: PointerLockAcquireResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const requested = this.lifecycle.beginRequest(options.owner);
      let requestRejected = false;
      try {
        await options.request({
          attempt,
          maxAttempts,
          owner: options.owner ? { ...options.owner } : undefined,
          state: requested,
        });
      } catch {
        requestRejected = true;
        const state = this.lifecycle.markRequestFailed('request-rejected');
        lastResult = { status: 'request-rejected', attempts: attempt, observations, state };
      }

      if (!requestRejected) {
        for (let poll = 0; poll < pollsPerAttempt; poll += 1) {
          const state = await this.observe();
          observations += 1;
          if (state.supported === false) {
            return { status: 'unsupported', attempts: attempt, observations, state };
          }
          if (state.phase === 'locked') {
            if (pointerLockOwnerMatches(options.owner, state.owner)) {
              return { status: 'locked', attempts: attempt, observations, state };
            }
            return { status: 'identity-mismatch', attempts: attempt, observations, state };
          }
          if (poll + 1 < pollsPerAttempt && pollIntervalMs > 0) {
            await this.sleep(pollIntervalMs);
          }
        }
        const state = this.lifecycle.markRequestFailed('request-timeout');
        lastResult = { status: 'timed-out', attempts: attempt, observations, state };
      }

      if (!lastResult) throw new Error('pointer-lock acquisition ended without a result');
      if (attempt >= maxAttempts) return lastResult;
      if (options.shouldRetry && !(await options.shouldRetry(lastResult))) return lastResult;
    }

    throw new Error('pointer-lock acquisition exceeded its bounded attempt loop');
  }

  private async ensureLocked(
    owner: PointerLockOwnerIdentity | undefined,
    recovery: PointerLockRecoveryPolicy | undefined,
  ): Promise<{ status: PointerLockAcquireStatus | 'unavailable'; state: PointerLockSnapshot }> {
    const state = await this.observe();
    if (state.phase === 'locked' && pointerLockOwnerMatches(owner, state.owner)) {
      return { status: 'locked', state };
    }
    if (!recovery) return { status: 'unavailable', state };
    const acquired = await this.acquire({ ...recovery, owner });
    return { status: acquired.status, state: acquired.state };
  }

  async moveRelative(
    delta: Point,
    options: MoveRelativeWithLockOptions = {},
  ): Promise<RelativePointerResult> {
    finiteDelta(delta);
    const relativeMove = this.input.movePointerBy?.bind(this.input);
    if (!relativeMove) throw new Error('BrowserInput does not support relative pointer movement');

    const requirement = options.requirement ?? 'required';
    if (requirement === 'none') {
      await relativeMove(delta);
      return { status: 'dispatched', state: this.current() };
    }

    const ensured = await this.ensureLocked(options.owner, options.recovery);
    if (ensured.status === 'locked') {
      await relativeMove(delta);
      return { status: 'dispatched', state: ensured.state };
    }

    const degraded: RelativePointerDegradedEvent = {
      delta: { ...delta },
      status: ensured.status,
      state: ensured.state,
    };
    if (requirement === 'preferred') {
      if (!options.onDegraded) {
        throw new Error('preferred pointer-lock degradation requires onDegraded');
      }
      await options.onDegraded(degraded);
      return { status: 'degraded', state: ensured.state };
    }

    throw new PointerLockRequiredError(ensured.status, ensured.state);
  }
}

export interface PointerLockInputGuardOptions
  extends Omit<MoveRelativeWithLockOptions, 'owner'> {
  /** May be dynamic so game-region generation/renderer identity is checked per delta. */
  owner?: PointerLockOwnerIdentity | (() => PointerLockOwnerIdentity | undefined);
}

/**
 * Preserve the existing BrowserInput surface while routing only relative pointer
 * movement through pointer-lock policy. This lets RealtimeControlLoop keep its
 * framework-independent BrowserInput dependency unchanged.
 */
export function guardRelativePointerInput(
  input: BrowserInput,
  controller: PointerLockController,
  options: PointerLockInputGuardOptions = {},
): BrowserInput {
  const owner = () => typeof options.owner === 'function' ? options.owner() : options.owner;
  return {
    movePointer: input.movePointer.bind(input),
    movePointerBy: async (delta) => {
      await controller.moveRelative(delta, {
        requirement: options.requirement,
        owner: owner(),
        recovery: options.recovery,
        onDegraded: options.onDegraded,
      });
    },
    pointerDown: input.pointerDown.bind(input),
    pointerUp: input.pointerUp.bind(input),
    pressKey: input.pressKey.bind(input),
    keyDown: input.keyDown.bind(input),
    keyUp: input.keyUp.bind(input),
    typeText: input.typeText.bind(input),
    ...(input.insertText ? { insertText: input.insertText.bind(input) } : {}),
    scroll: input.scroll.bind(input),
  };
}
