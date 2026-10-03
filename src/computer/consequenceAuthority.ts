import { COMPUTER_EFFECT_CLASSES, type ComputerEffectClass } from './environmentAdapter.js';
import { mayContributeInstructionAuthority, type ObservationTrust } from './observationTrust.js';

export interface ComputerEffectAuthorityGrant {
  /** Bounded machine identifier; never user-visible instruction text. */
  readonly grantId:string;
  /** Original authority source retained separately from derived observations. */
  readonly source:ObservationTrust;
  /** Exact effect classes this grant permits. No wildcard or hierarchy expansion. */
  readonly allowedEffects:readonly ComputerEffectClass[];
}

export type ComputerConsequenceAuthorityDecision =
  | {readonly allowed:true;readonly reason:'non-consequential'|'effect-authorized';readonly grantId?:string}
  | {readonly allowed:false;readonly reason:'effect-authority-required'|'authority-source-untrusted'|'effect-not-granted'};

const GRANT_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const CONSEQUENTIAL_EFFECTS = new Set<ComputerEffectClass>([
  'local-destructive',
  'process-execution',
  'system-configuration',
  'external-communication',
  'external-transaction',
  'security-sensitive',
  'process-trigger',
  'remote-execution',
  'hardware-affecting',
]);

export function isConsequentialComputerEffect(effect:ComputerEffectClass):boolean {
  return CONSEQUENTIAL_EFFECTS.has(effect);
}

function validGrant(grant:ComputerEffectAuthorityGrant):boolean {
  return GRANT_PATTERN.test(grant.grantId) &&
    Array.isArray(grant.allowedEffects) && grant.allowedEffects.length > 0 && grant.allowedEffects.length <= COMPUTER_EFFECT_CLASSES.length &&
    grant.allowedEffects.every((effect)=>COMPUTER_EFFECT_CLASSES.includes(effect));
}

/**
 * Prevents untrusted observations from escalating consequences.
 *
 * A derived/model-produced observation may influence target resolution, but a
 * consequential effect requires an original user/host authority grant explicitly
 * naming that effect class. Grants are exact sets: authorizing communication does
 * not implicitly authorize transactions, execution, configuration, or deletion.
 */
export function decideComputerConsequenceAuthority(
  effect:ComputerEffectClass,
  grants:readonly ComputerEffectAuthorityGrant[] = [],
):ComputerConsequenceAuthorityDecision {
  if (!COMPUTER_EFFECT_CLASSES.includes(effect)) {
    return Object.freeze({allowed:false,reason:'effect-not-granted'});
  }
  if (!isConsequentialComputerEffect(effect)) {
    return Object.freeze({allowed:true,reason:'non-consequential'});
  }
  if (grants.length === 0) return Object.freeze({allowed:false,reason:'effect-authority-required'});

  let sawTrustedSource = false;
  for (const grant of grants) {
    if (!validGrant(grant)) continue;
    if (!mayContributeInstructionAuthority(grant.source)) continue;
    sawTrustedSource = true;
    if (grant.allowedEffects.includes(effect)) {
      return Object.freeze({allowed:true,reason:'effect-authorized',grantId:grant.grantId});
    }
  }
  if (!sawTrustedSource) return Object.freeze({allowed:false,reason:'authority-source-untrusted'});
  return Object.freeze({allowed:false,reason:'effect-not-granted'});
}
