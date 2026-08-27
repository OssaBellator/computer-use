import type { ComputerSurfaceRef } from './environmentAdapter.js';
import type { DesktopInteractionLease, DesktopInteractionLeaseManager } from './desktopInteractionLease.js';
import type { WindowsNativeHostSystemObserver } from './windowsNativeHostSystem.js';
import { captureWindowsUiaWindowRef, sameWindowsUiaWindow, type WindowsUiaWindowRef } from './windowsUiaContract.js';

export interface WindowsInteractiveHostLeaseAcquisition {
  readonly lease:DesktopInteractionLease;
  readonly targetWindow:WindowsUiaWindowRef;
}

const OBSERVATION_LIMITS=Object.freeze({maxItems:1_024,maxTextBytes:256*1_024});

/**
 * Acquires an interactive-host lease only while the exact generation-bearing
 * target HWND is freshly observed as the foreground window. Native SendInput
 * repeats generation, foreground and physical-input checks at dispatch time, so
 * this acquisition proof is necessary but never treated as durable focus state.
 */
export class WindowsInteractiveHostLeaseService {
  constructor(
    readonly system:Pick<WindowsNativeHostSystemObserver,'observeWindows'>,
    readonly leases:DesktopInteractionLeaseManager,
  ) {}

  async acquire(input:{
    readonly leaseId:string;
    readonly targetWindow:WindowsUiaWindowRef;
    readonly targetSurface:ComputerSurfaceRef;
    readonly durationMs:number;
  }):Promise<WindowsInteractiveHostLeaseAcquisition>{
    const targetWindow=captureWindowsUiaWindowRef(input.targetWindow);
    if(!targetWindow)throw new Error('windows-interactive-lease-window-invalid');

    const observation=await this.system.observeWindows(OBSERVATION_LIMITS);
    const matches=observation.windows.filter(candidate=>sameWindowsUiaWindow(candidate.window,targetWindow));
    if(matches.length!==1){
      throw new Error(observation.truncated
        ? 'windows-interactive-lease-window-unresolved-truncated'
        : 'windows-interactive-lease-window-not-current');
    }
    if(!matches[0]!.foreground)throw new Error('windows-interactive-lease-window-not-foreground');

    const lease=await this.leases.acquire({
      leaseId:input.leaseId,
      mode:'interactive-host',
      targetDesktop:targetWindow.desktopSessionId,
      targetSurface:input.targetSurface,
      durationMs:input.durationMs,
    });
    return Object.freeze({lease,targetWindow});
  }

  release(leaseId:string):void { this.leases.release(leaseId); }
}
