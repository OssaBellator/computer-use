import type { ComputerActionResult, ComputerEffectClass, ComputerSurfaceRef } from './environmentAdapter.js';
import type { DesktopInteractionLease, DesktopInteractionLeaseManager } from './desktopInteractionLease.js';
import { decideWindowsInputIntegrity, type WindowsInputIntegrityContext } from './windowsInputIntegrity.js';
import { captureWindowsUiaWindowRef, type WindowsUiaWindowRef } from './windowsUiaContract.js';

export interface WindowsNativeInputRequest {
  readonly lease: DesktopInteractionLease;
  readonly targetDesktop: string;
  readonly targetSurface: ComputerSurfaceRef;
  /** Exact generation-bearing HWND that must own foreground at SendInput. */
  readonly targetWindow: WindowsUiaWindowRef;
  readonly integrity: WindowsInputIntegrityContext;
  readonly effect: ComputerEffectClass;
}

export interface WindowsNativeInputDispatchAuthority {
  readonly targetWindow:WindowsUiaWindowRef;
  /** Exact physical-input sequence captured when the interactive lease began. */
  readonly humanInputSequence:number;
}

export interface WindowsNativeInputDispatchResult {
  /** Number of INPUT records submitted/planned for the native dispatch call. */
  readonly requestedEventCount: number;
  /** Number of INPUT records the native call reports as inserted. */
  readonly insertedEventCount: number;
  /**
   * Definite failure before the native effect boundary. When present, inserted
   * count must be zero; callers may safely report not-dispatched rather than
   * sticky UNKNOWN.
   */
  readonly preDispatchFailure?: string;
  readonly verified?: boolean;
  readonly evidence?: readonly string[];
}

export interface WindowsNativeInputDispatcher {
  dispatch(authority:WindowsNativeInputDispatchAuthority): Promise<WindowsNativeInputDispatchResult>;
}

const EVIDENCE_PATTERN=/^[a-z0-9][a-z0-9._:-]{0,191}$/i;
function validDispatchCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 4_096;
}
function cloneSurface(surface:ComputerSurfaceRef):ComputerSurfaceRef {
  return Object.freeze({
    adapterId:surface.adapterId,
    environment:surface.environment,
    surfaceId:surface.surfaceId,
    ...(surface.generation!==undefined?{generation:surface.generation}:{}),
    ...(surface.parentSurfaceId!==undefined?{parentSurfaceId:surface.parentSurfaceId}:{}),
  });
}

/**
 * Final fail-closed gate for SendInput-style fallback. Semantic UIA actions do
 * not pass through this path. Lease and integrity are revalidated immediately
 * before exactly one native-input dispatch attempt. The dispatcher receives an
 * immutable exact target window plus the lease's human-input baseline so the
 * native host can repeat foreground/interference checks at the Win32 boundary.
 */
export class WindowsNativeInputGate {
  constructor(private readonly leases: DesktopInteractionLeaseManager) {}

  async dispatch(request: WindowsNativeInputRequest, dispatcher: WindowsNativeInputDispatcher): Promise<ComputerActionResult> {
    const targetWindow=captureWindowsUiaWindowRef(request.targetWindow);
    if(!targetWindow){
      return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['windows-input-target-window-invalid']};
    }
    const targetDesktop=request.targetDesktop;
    const targetSurface=cloneSurface(request.targetSurface);
    const leaseAuthority=request.lease;

    if (request.effect === 'observe-only') {
      return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['windows-input-effect-invalid']};
    }
    if (leaseAuthority.mode !== 'interactive-host') {
      return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['windows-input-interactive-lease-required']};
    }

    const integrity = decideWindowsInputIntegrity(request.integrity);
    if (!integrity.allowed) {
      return {status:'unsupported',dispatch:'not-dispatched',verification:'unverified',evidence:[integrity.reason]};
    }

    const lease = await this.leases.validate(leaseAuthority,{
      targetDesktop,
      targetSurface,
    });
    if (lease.status !== 'valid') {
      return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:[`windows-input-lease-${lease.status}`]};
    }

    const authority=Object.freeze({targetWindow,humanInputSequence:leaseAuthority.humanInputBaseline});
    try {
      const result = await dispatcher.dispatch(authority);
      if (!validDispatchCount(result.requestedEventCount) ||
          !validDispatchCount(result.insertedEventCount) ||
          result.requestedEventCount < 1 ||
          result.insertedEventCount > result.requestedEventCount) {
        return {status:'unknown',dispatch:'unknown',verification:'unverified',evidence:['windows-input-dispatch-result-invalid']};
      }
      if(result.preDispatchFailure!==undefined){
        if(result.insertedEventCount!==0||typeof result.preDispatchFailure!=='string'||!EVIDENCE_PATTERN.test(result.preDispatchFailure)){
          return {status:'unknown',dispatch:'unknown',verification:'unverified',evidence:['windows-input-dispatch-result-invalid']};
        }
        return {
          status:'rejected',dispatch:'not-dispatched',verification:'unverified',
          evidence:Object.freeze([result.preDispatchFailure,...(result.evidence??[])]),
        };
      }
      if (result.insertedEventCount === 0) {
        return {status:'failed',dispatch:'not-dispatched',verification:'unverified',...(result.evidence ? {evidence:result.evidence} : {})};
      }
      if (result.insertedEventCount !== result.requestedEventCount) {
        return {
          status:'unknown',
          dispatch:'unknown',
          verification:'unverified',
          evidence:Object.freeze(['windows-input-partial-dispatch',...(result.evidence ?? [])]),
        };
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
