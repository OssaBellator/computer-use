import type { ComputerActionResult, ComputerEffectClass, ComputerSurfaceRef } from './environmentAdapter.js';
import type { DesktopInteractionLease, DesktopInteractionLeaseManager } from './desktopInteractionLease.js';
import { decideWindowsInputIntegrity, type WindowsInputIntegrityContext } from './windowsInputIntegrity.js';

export interface WindowsNativeInputRequest {
  readonly lease: DesktopInteractionLease;
  readonly targetDesktop: string;
  readonly targetSurface: ComputerSurfaceRef;
  readonly integrity: WindowsInputIntegrityContext;
  readonly effect: ComputerEffectClass;
}

export interface WindowsNativeInputDispatcher {
  dispatch(): Promise<{ readonly dispatched:boolean; readonly verified?:boolean; readonly evidence?:readonly string[] }>;
}

/**
 * Final fail-closed gate for SendInput-style fallback. Semantic UIA actions do
 * not pass through this path. Lease and integrity are revalidated immediately
 * before exactly one native-input dispatch attempt.
 */
export class WindowsNativeInputGate {
  constructor(private readonly leases: DesktopInteractionLeaseManager) {}

  async dispatch(request: WindowsNativeInputRequest, dispatcher: WindowsNativeInputDispatcher): Promise<ComputerActionResult> {
    if (request.effect === 'observe-only') {
      return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['windows-input-effect-invalid']};
    }
    if (request.lease.mode !== 'interactive-host') {
      return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['windows-input-interactive-lease-required']};
    }

    const integrity = decideWindowsInputIntegrity(request.integrity);
    if (!integrity.allowed) {
      return {status:'unsupported',dispatch:'not-dispatched',verification:'unverified',evidence:[integrity.reason]};
    }

    const lease = await this.leases.validate(request.lease,{
      targetDesktop:request.targetDesktop,
      targetSurface:request.targetSurface,
    });
    if (lease.status !== 'valid') {
      return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:[`windows-input-lease-${lease.status}`]};
    }

    try {
      const result = await dispatcher.dispatch();
      if (!result.dispatched) {
        return {status:'failed',dispatch:'not-dispatched',verification:'unverified',...(result.evidence ? {evidence:result.evidence} : {})};
      }
      return {
        status:'completed',
        dispatch:'dispatched-once',
        verification:result.verified === true ? 'verified' : result.verified === false ? 'mismatch' : 'unverified',
        ...(result.evidence ? {evidence:result.evidence} : {}),
      };
    } catch {
      // The call boundary may already have emitted one or more input events.
      return {status:'unknown',dispatch:'unknown',verification:'unverified',evidence:['windows-input-dispatch-uncertain']};
    }
  }
}
