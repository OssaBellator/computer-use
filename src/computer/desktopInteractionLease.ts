import type { ComputerSurfaceRef } from './environmentAdapter.js';

export type DesktopInteractionMode = 'background-semantic' | 'interactive-host' | 'isolated-environment';

export interface HumanInputSnapshot {
  /** Monotonic backend-defined sequence. It must change after observed human input. */
  sequence: number;
}

export interface DesktopInteractionLease {
  readonly leaseId: string;
  readonly mode: DesktopInteractionMode;
  readonly targetDesktop: string;
  readonly targetSurface?: ComputerSurfaceRef;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
  readonly humanInputBaseline: number;
}

export type DesktopLeaseValidation =
  | { readonly status: 'valid' }
  | { readonly status: 'expired' }
  | { readonly status: 'released' }
  | { readonly status: 'human-interference' }
  | { readonly status: 'target-mismatch' };

export interface HumanInputObserver {
  snapshot(): Promise<HumanInputSnapshot>;
}

const MAX_LEASE_MS = 5 * 60_000;
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

function sameSurface(a: ComputerSurfaceRef | undefined, b: ComputerSurfaceRef | undefined): boolean {
  if (!a || !b) return a === b;
  return a.adapterId === b.adapterId && a.environment === b.environment && a.surfaceId === b.surfaceId && a.generation === b.generation;
}

function cloneSurface(surface: ComputerSurfaceRef | undefined): ComputerSurfaceRef | undefined {
  if (!surface) return undefined;
  return Object.freeze({
    adapterId: surface.adapterId,
    environment: surface.environment,
    surfaceId: surface.surfaceId,
    ...(surface.generation !== undefined ? { generation: surface.generation } : {}),
    ...(surface.parentSurfaceId !== undefined ? { parentSurfaceId: surface.parentSurfaceId } : {}),
  });
}

export class DesktopInteractionLeaseManager {
  private readonly active = new Map<string, DesktopInteractionLease>();

  constructor(private readonly humanInput: HumanInputObserver, private readonly now: () => number = Date.now) {}

  async acquire(input: {
    leaseId: string;
    mode: DesktopInteractionMode;
    targetDesktop: string;
    targetSurface?: ComputerSurfaceRef;
    durationMs: number;
  }): Promise<DesktopInteractionLease> {
    if (!ID_PATTERN.test(input.leaseId)) throw new Error('invalid desktop interaction lease id');
    if (!ID_PATTERN.test(input.targetDesktop)) throw new Error('invalid target desktop id');
    if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 1 || input.durationMs > MAX_LEASE_MS) throw new Error('invalid desktop interaction lease duration');
    if (this.active.has(input.leaseId)) throw new Error('desktop interaction lease id already active');

    const baseline = await this.humanInput.snapshot();
    if (!Number.isSafeInteger(baseline.sequence) || baseline.sequence < 0) throw new Error('invalid human input snapshot');
    const acquiredAtMs = this.now();
    const lease = Object.freeze({
      leaseId: input.leaseId,
      mode: input.mode,
      targetDesktop: input.targetDesktop,
      ...(input.targetSurface ? { targetSurface: cloneSurface(input.targetSurface) } : {}),
      acquiredAtMs,
      expiresAtMs: acquiredAtMs + input.durationMs,
      humanInputBaseline: baseline.sequence,
    });
    this.active.set(input.leaseId, lease);
    return lease;
  }

  release(leaseId: string): void {
    this.active.delete(leaseId);
  }

  /** Revokes every locally active lease immediately. Returns the revoked count. */
  releaseAll(): number {
    const count=this.active.size;
    this.active.clear();
    return count;
  }

  async validate(
    lease: DesktopInteractionLease,
    expected: { targetDesktop: string; targetSurface?: ComputerSurfaceRef },
  ): Promise<DesktopLeaseValidation> {
    const current = this.active.get(lease.leaseId);
    if (current !== lease) return Object.freeze({ status: 'released' });
    if (this.now() >= lease.expiresAtMs) return Object.freeze({ status: 'expired' });
    if (lease.targetDesktop !== expected.targetDesktop || !sameSurface(lease.targetSurface, expected.targetSurface)) {
      return Object.freeze({ status: 'target-mismatch' });
    }

    // Background-semantic and isolated execution do not share the host input stream.
    if (lease.mode !== 'interactive-host') return Object.freeze({ status: 'valid' });

    const latest = await this.humanInput.snapshot();
    if (!Number.isSafeInteger(latest.sequence) || latest.sequence < lease.humanInputBaseline) {
      return Object.freeze({ status: 'human-interference' });
    }
    if (latest.sequence !== lease.humanInputBaseline) return Object.freeze({ status: 'human-interference' });
    return Object.freeze({ status: 'valid' });
  }
}
