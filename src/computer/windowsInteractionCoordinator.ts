import type { ComputerActionResult, ComputerEffectClass, ComputerSurfaceRef } from './environmentAdapter.js';
import type { DesktopInteractionLease } from './desktopInteractionLease.js';
import { decideComputerConsequenceAuthority, type ComputerEffectAuthorityGrant } from './consequenceAuthority.js';
import { WindowsNativeInputGate, type WindowsNativeInputDispatcher } from './windowsNativeInputGate.js';
import { resolveWindowsInputIntegrityContext, type WindowsProcessTokenIntegrityReader } from './windowsProcessIntegrity.js';
import {
  sameWindowsUiaWindow,
  WindowsUiaSemanticRuntime,
  type WindowsUiaControlRef,
  type WindowsUiaSemanticAction,
} from './windowsUiaContract.js';
import { validateWindowsVisualPointBinding, type WindowsVisualFrameRef, type WindowsVisualPointBinding } from './windowsVisualFrame.js';
import { decideWindowsWindowAuthority, type WindowsWindowAuthoritySnapshot } from './windowsWindowAuthority.js';

function rejected(reason:string):ComputerActionResult {
  return Object.freeze({status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:Object.freeze([reason])});
}

function consequence(effect:ComputerEffectClass,grants:readonly ComputerEffectAuthorityGrant[]|undefined):ComputerActionResult|undefined {
  const decision = decideComputerConsequenceAuthority(effect,grants ?? []);
  return decision.allowed ? undefined : rejected(`windows-consequence-${decision.reason}`);
}

export interface WindowsSemanticInteractionRequest {
  readonly ref:WindowsUiaControlRef;
  readonly action:WindowsUiaSemanticAction;
  readonly effect:ComputerEffectClass;
  readonly windows:readonly WindowsWindowAuthoritySnapshot[];
  readonly grants?:readonly ComputerEffectAuthorityGrant[];
}

export interface WindowsVisualNativeInteractionRequest {
  readonly binding:WindowsVisualPointBinding;
  /** Most recent frame available immediately before dispatch. */
  readonly currentFrame:WindowsVisualFrameRef;
  readonly windows:readonly WindowsWindowAuthoritySnapshot[];
  readonly lease:DesktopInteractionLease;
  readonly targetDesktop:string;
  readonly targetSurface:ComputerSurfaceRef;
  readonly effect:ComputerEffectClass;
  readonly grants?:readonly ComputerEffectAuthorityGrant[];
  readonly dispatcher:WindowsNativeInputDispatcher;
}

/**
 * Cross-channel Windows authority coordinator.
 *
 * Semantic and visual/native embodiments share one consequence gate and one
 * window/modal authority model. A modal reroute never carries an old control ref
 * or old visual coordinate into the new window; the caller must re-observe or
 * re-ground against the authoritative modal first. Visual input additionally
 * requires an exact current frame and a fresh process-token integrity read
 * immediately before the native input gate.
 */
export class WindowsInteractionCoordinator {
  constructor(
    readonly semantic:WindowsUiaSemanticRuntime,
    readonly nativeInput:WindowsNativeInputGate,
    readonly integrity:WindowsProcessTokenIntegrityReader,
  ) {}

  async actSemantic(request:WindowsSemanticInteractionRequest):Promise<ComputerActionResult> {
    const consequenceDenied = consequence(request.effect,request.grants);
    if (consequenceDenied) return consequenceDenied;
    const authority = decideWindowsWindowAuthority(request.ref.window,request.windows);
    if (!authority.allowed) return rejected(`windows-window-authority-${authority.reason}`);
    if (!sameWindowsUiaWindow(authority.target,request.ref.window)) {
      return rejected('windows-window-authority-rerouted-reobserve');
    }
    return this.semantic.act(request.ref,request.action,request.effect);
  }

  async actVisualNative(request:WindowsVisualNativeInteractionRequest):Promise<ComputerActionResult> {
    const consequenceDenied = consequence(request.effect,request.grants);
    if (consequenceDenied) return consequenceDenied;
    const requestedWindow = request.binding.frame.window;
    const authority = decideWindowsWindowAuthority(requestedWindow,request.windows);
    if (!authority.allowed) return rejected(`windows-window-authority-${authority.reason}`);
    if (!sameWindowsUiaWindow(authority.target,requestedWindow)) {
      return rejected('windows-window-authority-rerouted-reground');
    }
    if (!sameWindowsUiaWindow(request.currentFrame.window,requestedWindow)) {
      return rejected('windows-input-current-frame-window-mismatch');
    }
    const grounding = validateWindowsVisualPointBinding(request.binding,request.currentFrame);
    if (grounding.status !== 'valid') return rejected(`windows-input-grounding-${grounding.status}`);

    const integrity = await resolveWindowsInputIntegrityContext(this.integrity,requestedWindow.process);
    return this.nativeInput.dispatch({
      lease:request.lease,
      targetDesktop:request.targetDesktop,
      targetSurface:request.targetSurface,
      integrity,
      effect:request.effect,
    },request.dispatcher);
  }
}
