import type { ComputerActionResult, ComputerEffectClass, ComputerSurfaceRef } from './environmentAdapter.js';
import type { DesktopInteractionLease } from './desktopInteractionLease.js';
import { decideComputerConsequenceAuthority, type ComputerEffectAuthorityGrant } from './consequenceAuthority.js';
import { WindowsNativeInputGate, type WindowsNativeInputDispatcher } from './windowsNativeInputGate.js';
import { createWindowsUiaActionVerification } from './windowsUiaPostActionVerification.js';
import {
  verifyWindowsPostAction,
  type WindowsPostActionObservationProvider,
  type WindowsPostActionVerificationOptions,
  type WindowsVerificationPredicate,
} from './windowsPostActionVerification.js';
import { resolveWindowsInputIntegrityContext, type WindowsProcessTokenIntegrityReader } from './windowsProcessIntegrity.js';
import {
  sameWindowsUiaWindow,
  WindowsUiaSemanticRuntime,
  type WindowsUiaControlRef,
  type WindowsUiaSemanticAction,
} from './windowsUiaContract.js';
import { validateWindowsVisualPointBinding, type WindowsVisualFrameRef, type WindowsVisualPointBinding } from './windowsVisualFrame.js';
import {
  assessWindowsVisualPostActionEvidence,
  type WindowsVisualEvidencePredicate,
  type WindowsVisualPostActionEvidenceProvider,
} from './windowsVisualPostActionEvidence.js';
import { decideWindowsWindowAuthority, type WindowsWindowAuthoritySnapshot } from './windowsWindowAuthority.js';

function rejected(reason:string):ComputerActionResult {
  return Object.freeze({status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:Object.freeze([reason])});
}

function consequence(effect:ComputerEffectClass,grants:readonly ComputerEffectAuthorityGrant[]|undefined):ComputerActionResult|undefined {
  const decision = decideComputerConsequenceAuthority(effect,grants ?? []);
  return decision.allowed ? undefined : rejected(`windows-consequence-${decision.reason}`);
}

export interface WindowsInteractionVerification<T> {
  readonly provider:WindowsPostActionObservationProvider<T>;
  readonly predicate:WindowsVerificationPredicate<T>;
  readonly options?:WindowsPostActionVerificationOptions;
}

export interface WindowsInteractionVisualEvidence<T> {
  readonly provider:WindowsVisualPostActionEvidenceProvider<T>;
  readonly predicate:WindowsVisualEvidencePredicate<T>;
}

export interface WindowsSemanticInteractionRequest<TVerification=unknown,TVisualEvidence=unknown> {
  readonly ref:WindowsUiaControlRef;
  readonly action:WindowsUiaSemanticAction;
  readonly effect:ComputerEffectClass;
  readonly windows:readonly WindowsWindowAuthoritySnapshot[];
  readonly grants?:readonly ComputerEffectAuthorityGrant[];
  readonly verification?:WindowsInteractionVerification<TVerification>;
  readonly visualEvidence?:WindowsInteractionVisualEvidence<TVisualEvidence>;
}

export interface WindowsVisualNativeInteractionRequest<TVerification=unknown,TVisualEvidence=unknown> {
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
  readonly verification?:WindowsInteractionVerification<TVerification>;
  readonly visualEvidence?:WindowsInteractionVisualEvidence<TVisualEvidence>;
}

async function verifyIfRequested<T>(
  result:ComputerActionResult,
  verification:WindowsInteractionVerification<T>|undefined,
  notBeforeMs:number,
):Promise<ComputerActionResult>{
  if(!verification||result.dispatch==='not-dispatched')return result;
  const callerNotBefore=verification.options?.notBeforeMs??0;
  return verifyWindowsPostAction(result,verification.provider,verification.predicate,{
    ...verification.options,
    // The coordinator owns this lower bound so a caller cannot accidentally
    // verify against a sample captured before this action attempt began.
    notBeforeMs:Math.max(callerNotBefore,notBeforeMs),
  });
}

/**
 * Cross-channel Windows authority coordinator.
 *
 * Semantic and visual/native embodiments share one consequence gate and one
 * window/modal authority model. A modal reroute never carries an old control ref
 * or old visual coordinate into the new window; the caller must re-observe or
 * re-ground against the authoritative modal first. Visual input additionally
 * requires an exact current frame and a fresh process-token integrity read
 * immediately before the native input gate. Optional post-action verification is
 * observational only: it never rewrites an UNKNOWN dispatch ledger into success.
 */
export class WindowsInteractionCoordinator {
  constructor(
    readonly semantic:WindowsUiaSemanticRuntime,
    readonly nativeInput:WindowsNativeInputGate,
    readonly integrity:WindowsProcessTokenIntegrityReader,
  ) {}

  async actSemantic<TVerification=unknown,TVisualEvidence=unknown>(request:WindowsSemanticInteractionRequest<TVerification,TVisualEvidence>):Promise<ComputerActionResult> {
    const consequenceDenied = consequence(request.effect,request.grants);
    if (consequenceDenied) return consequenceDenied;
    const authority = decideWindowsWindowAuthority(request.ref.window,request.windows);
    if (!authority.allowed) return rejected(`windows-window-authority-${authority.reason}`);
    if (!sameWindowsUiaWindow(authority.target,request.ref.window)) {
      return rejected('windows-window-authority-rerouted-reobserve');
    }
    const notBeforeMs=Date.now();
    const result=await this.semantic.act(request.ref,request.action,request.effect);
    const authoritative=request.verification
      ?await verifyIfRequested(result,request.verification,notBeforeMs)
      :await verifyIfRequested(result,createWindowsUiaActionVerification(this.semantic.provider,request.ref,request.action),notBeforeMs);
    return request.visualEvidence
      ?assessWindowsVisualPostActionEvidence(authoritative,request.visualEvidence.provider,request.visualEvidence.predicate,notBeforeMs)
      :authoritative;
  }

  async actVisualNative<TVerification=unknown,TVisualEvidence=unknown>(request:WindowsVisualNativeInteractionRequest<TVerification,TVisualEvidence>):Promise<ComputerActionResult> {
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
    const notBeforeMs=Date.now();
    const result=await this.nativeInput.dispatch({
      lease:request.lease,
      targetDesktop:request.targetDesktop,
      targetSurface:request.targetSurface,
      targetWindow:requestedWindow,
      integrity,
      effect:request.effect,
    },request.dispatcher);
    const authoritative=await verifyIfRequested(result,request.verification,notBeforeMs);
    return request.visualEvidence
      ?assessWindowsVisualPostActionEvidence(authoritative,request.visualEvidence.provider,request.visualEvidence.predicate,notBeforeMs)
      :authoritative;
  }
}
