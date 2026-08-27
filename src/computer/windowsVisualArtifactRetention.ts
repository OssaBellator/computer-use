import type { DesktopVisualAcquisitionLimits } from './desktopUiBackend.js';
import { WindowsGraphicsCaptureRuntime, type WindowsGraphicsCaptureObservation, type WindowsGraphicsCaptureNativeBridge } from './windowsGraphicsCaptureRuntime.js';
import type { WindowsUiaWindowRef } from './windowsUiaContract.js';

export type WindowsVisualArtifactSensitivity = 'normal' | 'sensitive-field' | 'credential-adjacent';

export interface WindowsVisualArtifactLease {
  readonly token:string;
  readonly captureGeneration:number;
  readonly frameSequence:number;
  readonly byteLength:number;
  readonly sensitivity:WindowsVisualArtifactSensitivity;
  readonly acquiredAtMs:number;
  readonly expiresAtMs:number;
}

export type WindowsVisualArtifactLeaseValidation =
  | {readonly status:'current'}
  | {readonly status:'expired'|'released'|'frame-mismatch'};

export interface WindowsRetainedGraphicsCapture {
  readonly observation:WindowsGraphicsCaptureObservation;
  readonly lease:WindowsVisualArtifactLease;
}

const MAX_NORMAL_TTL_MS = 60_000;
const MAX_SENSITIVE_TTL_MS = 5_000;
const MAX_CREDENTIAL_TTL_MS = 1_000;
const MAX_ARTIFACTS = 32;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

function ttlLimit(sensitivity:WindowsVisualArtifactSensitivity):number {
  switch (sensitivity) {
    case 'normal':return MAX_NORMAL_TTL_MS;
    case 'sensitive-field':return MAX_SENSITIVE_TTL_MS;
    case 'credential-adjacent':return MAX_CREDENTIAL_TTL_MS;
  }
}

/**
 * Tracks only metadata for transient backend-owned screenshots/surfaces.
 * Raw visual bytes never enter this manager. Release always delegates to the
 * capture backend so native GPU/encoded material can be destroyed promptly.
 */
export class WindowsVisualArtifactRetentionManager {
  private readonly active = new Map<string,WindowsVisualArtifactLease>();
  private totalBytes = 0;

  constructor(
    readonly bridge:Pick<WindowsGraphicsCaptureNativeBridge,'releaseArtifact'|'consumeArtifact'>,
    readonly now:()=>number = Date.now,
  ) {}

  acquire(
    observation:WindowsGraphicsCaptureObservation,
    input:{sensitivity:WindowsVisualArtifactSensitivity;ttlMs:number},
  ):WindowsVisualArtifactLease {
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > ttlLimit(input.sensitivity)) {
      throw new Error('windows-visual-retention-ttl-invalid');
    }
    const token = observation.artifact.token;
    if (this.active.has(token)) throw new Error('windows-visual-retention-token-active');
    if (this.active.size >= MAX_ARTIFACTS) throw new Error('windows-visual-retention-count-limit');
    if (this.totalBytes + observation.artifact.byteLength > MAX_TOTAL_BYTES) throw new Error('windows-visual-retention-byte-limit');
    const acquiredAtMs = this.now();
    const lease = Object.freeze({
      token,
      captureGeneration:observation.frame.captureGeneration,
      frameSequence:observation.frame.frameSequence,
      byteLength:observation.artifact.byteLength,
      sensitivity:input.sensitivity,
      acquiredAtMs,
      expiresAtMs:acquiredAtMs + input.ttlMs,
    });
    this.active.set(token,lease);
    this.totalBytes += lease.byteLength;
    return lease;
  }

  validate(lease:WindowsVisualArtifactLease,observation:WindowsGraphicsCaptureObservation):WindowsVisualArtifactLeaseValidation {
    const current = this.active.get(lease.token);
    if (current !== lease) return Object.freeze({status:'released'});
    if (this.now() >= lease.expiresAtMs) return Object.freeze({status:'expired'});
    if (observation.artifact.token !== lease.token ||
        observation.frame.captureGeneration !== lease.captureGeneration ||
        observation.frame.frameSequence !== lease.frameSequence) {
      return Object.freeze({status:'frame-mismatch'});
    }
    return Object.freeze({status:'current'});
  }

  async consume(lease:WindowsVisualArtifactLease,maxBytes:number):Promise<Readonly<{mediaType:string;bytes:Uint8Array}>> {
    const current=this.active.get(lease.token);
    if(current!==lease)throw new Error('windows-visual-retention-released');
    if(this.now()>=lease.expiresAtMs)throw new Error('windows-visual-retention-expired');
    if(!this.bridge.consumeArtifact)throw new Error('windows-visual-retention-consume-unsupported');
    this.active.delete(lease.token);
    this.totalBytes-=lease.byteLength;
    try{return await this.bridge.consumeArtifact(lease.token,maxBytes);}
    catch{throw new Error('windows-visual-retention-consume-uncertain');}
  }

  async release(lease:WindowsVisualArtifactLease):Promise<void> {
    const current = this.active.get(lease.token);
    if (current !== lease) return;
    this.active.delete(lease.token);
    this.totalBytes -= lease.byteLength;
    try {
      await this.bridge.releaseArtifact(lease.token);
    } catch {
      // Metadata remains released even when backend destruction reporting fails;
      // callers must not regain authority to use an artifact after release.
      throw new Error('windows-visual-retention-release-uncertain');
    }
  }

  async releaseExpired():Promise<number> {
    const expired = [...this.active.values()].filter((lease)=>this.now() >= lease.expiresAtMs);
    let released = 0;
    for (const lease of expired) {
      await this.release(lease);
      released += 1;
    }
    return released;
  }

  /**
   * Revokes every local artifact lease before attempting backend destruction.
   * Backend failures therefore cannot restore screenshot authority. All tokens are
   * attempted; any failure is reported only after local authority is fully cleared.
   */
  async releaseAll():Promise<number> {
    const leases=[...this.active.values()];
    this.active.clear();
    this.totalBytes=0;
    let uncertain=false;
    for(const lease of leases){
      try{await this.bridge.releaseArtifact(lease.token);}catch{uncertain=true;}
    }
    if(uncertain)throw new Error('windows-visual-retention-release-uncertain');
    return leases.length;
  }

  activeCount():number { return this.active.size; }
  activeBytes():number { return this.totalBytes; }
}

/**
 * Capture plus retention is one authority transaction: a successful native
 * screenshot is never exposed to callers unless a bounded lease was acquired.
 * If lease acquisition fails, backend ownership is revoked before the original
 * acquisition error is rethrown.
 */
export class WindowsRetainedGraphicsCaptureRuntime {
  constructor(
    readonly capture:WindowsGraphicsCaptureRuntime,
    readonly retention:WindowsVisualArtifactRetentionManager,
  ) {}

  async captureRetained(
    window:WindowsUiaWindowRef,
    limits:DesktopVisualAcquisitionLimits,
    retention:{sensitivity:WindowsVisualArtifactSensitivity;ttlMs:number},
  ):Promise<WindowsRetainedGraphicsCapture>{
    const observation=await this.capture.capture(window,limits);
    try{
      const lease=this.retention.acquire(observation,retention);
      return Object.freeze({observation,lease});
    }catch(error){
      try{await this.capture.release(observation);}catch{
        throw new Error('windows-visual-retention-acquire-cleanup-uncertain',{cause:error});
      }
      throw error;
    }
  }
}
