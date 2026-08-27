import type {
  ComputerCapability,
  ComputerCapabilityProfile,
  ComputerCapabilityState,
  ComputerCapabilitySupport,
} from './computerCapabilities.js';
import type {
  WindowsProviderCapability,
  WindowsProviderCapabilityProfile,
  WindowsProviderCapabilityState,
  WindowsProviderCapabilitySupport,
} from './windowsProviderCapabilities.js';

function windowsState(
  profile:WindowsProviderCapabilityProfile,
  capability:WindowsProviderCapability,
):WindowsProviderCapabilityState {
  const value=profile.capabilities[capability];
  return typeof value==='string'?Object.freeze({support:value}):value??Object.freeze({support:'unsupported'});
}

function weakest(...supports:WindowsProviderCapabilitySupport[]):ComputerCapabilitySupport {
  if(supports.includes('unsupported'))return 'unsupported';
  if(supports.includes('partial'))return 'partial';
  return 'supported';
}

function mapped(
  profile:WindowsProviderCapabilityProfile,
  sources:readonly WindowsProviderCapability[],
  note:string,
):ComputerCapabilityState {
  const states=sources.map((capability)=>windowsState(profile,capability));
  const support=weakest(...states.map((state)=>state.support));
  const reasons=states.flatMap((state)=>state.reason?[state.reason]:[]);
  return Object.freeze({
    support,
    note:reasons.length>0?`${note}: ${reasons.join(' | ')}`:note,
  });
}

/**
 * Projects the production Windows provider into the environment-neutral computer
 * capability vocabulary. Only capabilities directly proven by Windows provider
 * primitives are mapped; the bridge never infers unrelated powers such as
 * clipboard, filesystem, process, or installation authority from GUI access.
 */
export function windowsProviderComputerCapabilityProfile(
  profile:WindowsProviderCapabilityProfile,
):ComputerCapabilityProfile {
  const capabilities:Partial<Record<ComputerCapability,ComputerCapabilityState>>={};
  capabilities['semantic-ui-observation']=mapped(profile,['uia-observation','window-modal-authority'],'Windows UIA semantic observation');
  capabilities['visual-observation']=mapped(profile,['wgc-hwnd-capture','visual-frame-binding'],'generation-bound Windows.Graphics.Capture observation');
  capabilities['pointer-input']=mapped(profile,['pointer-input','input-integrity-gating','foreground-interaction-lease','human-interference-detection'],'guarded Windows pointer input');
  capabilities['keyboard-input']=mapped(profile,['keyboard-input','input-integrity-gating','foreground-interaction-lease','human-interference-detection'],'guarded Windows keyboard input');
  capabilities['text-input']=mapped(profile,['keyboard-input','input-integrity-gating','foreground-interaction-lease','human-interference-detection'],'guarded Windows Unicode keyboard input');
  capabilities['side-effect-verification']=mapped(profile,['side-effect-verification'],'Windows post-action verification');
  return Object.freeze({id:`${profile.id}:computer-capabilities`,capabilities:Object.freeze(capabilities)});
}
