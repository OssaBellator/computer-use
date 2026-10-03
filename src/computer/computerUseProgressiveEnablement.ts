import {
  COMPUTER_CAPABILITIES,
  computerCapabilityState,
  type ComputerCapability,
  type ComputerCapabilityProfile,
} from './computerCapabilities.js';

export const COMPUTER_USE_ENABLEMENT_LEVELS = [
  'CU-0','CU-1','CU-2','CU-3','CU-4','CU-5','CU-6','CU-7','CU-8',
] as const;
export type ComputerUseEnablementLevel = typeof COMPUTER_USE_ENABLEMENT_LEVELS[number];

export interface ComputerUseEnablementLevelPolicy {
  readonly level:ComputerUseEnablementLevel;
  /** Capability support required for this level. This is eligibility, never authority. */
  readonly requiredCapabilities:readonly ComputerCapability[];
  readonly note?:string;
}

export interface ComputerUseEnablementAssessment {
  readonly level:ComputerUseEnablementLevel;
  readonly ordinal:number;
  readonly eligible:boolean;
  readonly requiredCapabilities:readonly ComputerCapability[];
  readonly unsupportedCapabilities:readonly ComputerCapability[];
  readonly partialCapabilities:readonly ComputerCapability[];
  /** Progressive enablement never manufactures consequence/session/credential authority. */
  readonly authorityGranted:false;
}

const NOTE=/^[\x20-\x7e]{1,512}$/;

function validatePolicies(policies:readonly ComputerUseEnablementLevelPolicy[]):readonly ComputerUseEnablementLevelPolicy[]{
  if(!Array.isArray(policies)||policies.length!==COMPUTER_USE_ENABLEMENT_LEVELS.length)
    throw new Error('computer-use-enablement-policy-count-invalid');
  const seen=new Set<ComputerUseEnablementLevel>();
  const normalized:ComputerUseEnablementLevelPolicy[]=[];
  for(const policy of policies){
    if(!policy||typeof policy!=='object'||!COMPUTER_USE_ENABLEMENT_LEVELS.includes(policy.level))
      throw new Error('computer-use-enablement-level-invalid');
    if(seen.has(policy.level))throw new Error('computer-use-enablement-level-duplicate');
    seen.add(policy.level);
    if(!Array.isArray(policy.requiredCapabilities)||new Set(policy.requiredCapabilities).size!==policy.requiredCapabilities.length||
      policy.requiredCapabilities.some((capability:unknown)=>typeof capability!=='string'||!COMPUTER_CAPABILITIES.includes(capability as ComputerCapability)))
      throw new Error('computer-use-enablement-capabilities-invalid');
    if(policy.note!==undefined&&(typeof policy.note!=='string'||!NOTE.test(policy.note)))
      throw new Error('computer-use-enablement-note-invalid');
    normalized.push(Object.freeze({
      level:policy.level,
      requiredCapabilities:Object.freeze([...policy.requiredCapabilities]),
      ...(policy.note!==undefined?{note:policy.note}:{}),
    }));
  }
  normalized.sort((a,b)=>COMPUTER_USE_ENABLEMENT_LEVELS.indexOf(a.level)-COMPUTER_USE_ENABLEMENT_LEVELS.indexOf(b.level));
  return Object.freeze(normalized);
}

/**
 * Evaluate exactly one progressive computer-use level against granular capability
 * truth. Level number itself grants no capability or authority, and requirements
 * are not silently inherited from lower/higher levels.
 */
export function assessComputerUseEnablement(
  profile:ComputerCapabilityProfile,
  policies:readonly ComputerUseEnablementLevelPolicy[],
  level:ComputerUseEnablementLevel,
):ComputerUseEnablementAssessment{
  if(!COMPUTER_USE_ENABLEMENT_LEVELS.includes(level))throw new Error('computer-use-enablement-level-invalid');
  const normalized=validatePolicies(policies);
  const policy=normalized.find((entry)=>entry.level===level)!;
  const unsupported:ComputerCapability[]=[];
  const partial:ComputerCapability[]=[];
  for(const capability of policy.requiredCapabilities){
    const state=computerCapabilityState(profile,capability);
    if(state.support==='unsupported')unsupported.push(capability);
    else if(state.support==='partial')partial.push(capability);
  }
  return Object.freeze({
    level,
    ordinal:COMPUTER_USE_ENABLEMENT_LEVELS.indexOf(level),
    eligible:unsupported.length===0&&partial.length===0,
    requiredCapabilities:policy.requiredCapabilities,
    unsupportedCapabilities:Object.freeze(unsupported),
    partialCapabilities:Object.freeze(partial),
    authorityGranted:false as const,
  });
}
