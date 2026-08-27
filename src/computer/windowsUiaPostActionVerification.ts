import type { WindowsInteractionVerification } from './windowsInteractionCoordinator.js';
import type { WindowsAuthoritativeObservation } from './windowsPostActionVerification.js';
import {
  captureWindowsUiaControlRef,
  captureWindowsUiaRevalidation,
  captureWindowsUiaSemanticAction,
  type WindowsUiaControlRef,
  type WindowsUiaProvider,
  type WindowsUiaRevalidation,
  type WindowsUiaSemanticAction,
} from './windowsUiaContract.js';

/**
 * Creates an authoritative fresh-control observer backed by provider-level UIA
 * revalidation. The local sequence only orders these fresh revalidation attempts;
 * it is not a durable UI identity and is never used for targeting.
 */
export function createWindowsUiaRevalidationObserver(
  provider:Pick<WindowsUiaProvider,'revalidateControl'>,
  ref:WindowsUiaControlRef,
  now:()=>number=Date.now,
):{observe():Promise<WindowsAuthoritativeObservation<WindowsUiaRevalidation>>}{
  const authority=captureWindowsUiaControlRef(ref);
  if(!authority)throw new Error('windows-uia-verification-ref-invalid');
  let sequence=0;
  return Object.freeze({
    observe:async()=>{
      const raw=await provider.revalidateControl(authority);
      const value=captureWindowsUiaRevalidation(raw);
      if(!value)throw new Error('windows-uia-verification-observation-invalid');
      sequence+=1;
      if(!Number.isSafeInteger(sequence))throw new Error('windows-uia-verification-sequence-exhausted');
      const capturedAtMs=now();
      if(!Number.isSafeInteger(capturedAtMs)||capturedAtMs<0)throw new Error('windows-uia-verification-time-invalid');
      return Object.freeze({sequence,capturedAtMs,value});
    },
  });
}

/**
 * Supplies generic semantic verification only where the current normalized UIA
 * contract contains authoritative post-state evidence:
 *
 * - set-value: exact current ValueProperty match;
 * - window close: the exact control becoming missing.
 *
 * Other patterns intentionally return undefined until their normalized pattern
 * state is available. Invoke/scroll in particular require app-specific effect
 * predicates rather than transport-level success assumptions.
 */
export function createWindowsUiaActionVerification(
  provider:Pick<WindowsUiaProvider,'revalidateControl'>,
  ref:WindowsUiaControlRef,
  action:WindowsUiaSemanticAction,
  now:()=>number=Date.now,
):WindowsInteractionVerification<WindowsUiaRevalidation>|undefined{
  const authorityAction=captureWindowsUiaSemanticAction(action);
  if(!authorityAction)throw new Error('windows-uia-verification-action-invalid');
  const observer=createWindowsUiaRevalidationObserver(provider,ref,now);

  if(authorityAction.kind==='set-value'){
    return Object.freeze({
      provider:observer,
      predicate:(observation:WindowsAuthoritativeObservation<WindowsUiaRevalidation>)=>observation.value.status==='current'&&observation.value.control.value===authorityAction.value
        ?'match'
        :'inconclusive',
    });
  }
  if(authorityAction.kind==='window'&&authorityAction.operation==='close'){
    return Object.freeze({
      provider:observer,
      // Missing exact UIA identity is positive evidence for close. Stale/replaced
      // identity is deliberately inconclusive rather than assumed to mean closed.
      predicate:(observation:WindowsAuthoritativeObservation<WindowsUiaRevalidation>)=>observation.value.status==='missing'?'match':'inconclusive',
    });
  }
  return undefined;
}
