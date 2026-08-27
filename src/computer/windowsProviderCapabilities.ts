export const WINDOWS_PROVIDER_CAPABILITIES = [
  'uia-observation',
  'uia-invoke',
  'uia-value',
  'uia-toggle',
  'uia-selection-item',
  'uia-expand-collapse',
  'uia-scroll',
  'uia-range-value',
  'uia-window',
  'window-modal-authority',
  'wgc-hwnd-capture',
  'visual-frame-binding',
  'visual-grounding',
  'keyboard-input',
  'pointer-input',
  'input-integrity-gating',
  'foreground-interaction-lease',
  'human-interference-detection',
  'transient-capture-retention',
  'side-effect-verification',
  'credential-brokered-use',
  'authentication-factor-brokered-use',
] as const;

export type WindowsProviderCapability = typeof WINDOWS_PROVIDER_CAPABILITIES[number];
export type WindowsProviderCapabilitySupport = 'supported'|'partial'|'unsupported';

export interface WindowsProviderCapabilityState {
  readonly support:WindowsProviderCapabilitySupport;
  readonly reason?:string;
}

export interface WindowsProviderCapabilityProfile {
  readonly id:string;
  readonly capabilities:Readonly<Partial<Record<WindowsProviderCapability,WindowsProviderCapabilitySupport|WindowsProviderCapabilityState>>>;
}

export interface WindowsProviderCapabilityRequirement {
  readonly capability:WindowsProviderCapability;
  readonly level?:'required'|'preferred';
}

export interface WindowsProviderCapabilityAssessment {
  readonly runnable:boolean;
  readonly fullySupported:boolean;
  readonly missingRequired:readonly WindowsProviderCapability[];
  readonly partialRequired:readonly WindowsProviderCapability[];
  readonly missingPreferred:readonly WindowsProviderCapability[];
}

export const WINDOWS_PROVIDER_REQUIREMENT_SETS = Object.freeze({
  semantic:Object.freeze([
    {capability:'uia-observation'},
    {capability:'window-modal-authority'},
  ] as const),
  semanticActions:Object.freeze([
    {capability:'uia-invoke'},
    {capability:'uia-value'},
    {capability:'uia-toggle'},
    {capability:'uia-selection-item'},
    {capability:'uia-expand-collapse'},
    {capability:'uia-scroll'},
    {capability:'uia-range-value'},
    {capability:'uia-window'},
  ] as const),
  visualFallback:Object.freeze([
    {capability:'wgc-hwnd-capture'},
    {capability:'visual-frame-binding'},
    {capability:'visual-grounding'},
    {capability:'input-integrity-gating'},
    {capability:'foreground-interaction-lease'},
    {capability:'human-interference-detection'},
    {capability:'transient-capture-retention'},
    {capability:'pointer-input'},
  ] as const),
});

function state(profile:WindowsProviderCapabilityProfile,capability:WindowsProviderCapability):WindowsProviderCapabilityState {
  const value = profile.capabilities[capability];
  return typeof value === 'string' ? {support:value} : value ?? {support:'unsupported'};
}

/**
 * Assesses explicit provider features without collapsing them into a single
 * "computer use" boolean. Callers can require exactly the embodiment primitives
 * their task needs and retain partial/unsupported reasons for diagnostics.
 */
export function assessWindowsProviderCapabilities(
  profile:WindowsProviderCapabilityProfile,
  requirements:readonly WindowsProviderCapabilityRequirement[],
):WindowsProviderCapabilityAssessment {
  const missingRequired:WindowsProviderCapability[]=[];
  const partialRequired:WindowsProviderCapability[]=[];
  const missingPreferred:WindowsProviderCapability[]=[];
  let fullySupported = true;
  for (const requirement of requirements) {
    const support = state(profile,requirement.capability).support;
    const preferred = requirement.level === 'preferred';
    if (support === 'unsupported') {
      fullySupported = false;
      (preferred ? missingPreferred : missingRequired).push(requirement.capability);
    } else if (support === 'partial') {
      fullySupported = false;
      if (!preferred) partialRequired.push(requirement.capability);
    }
  }
  return Object.freeze({
    runnable:missingRequired.length===0,
    fullySupported,
    missingRequired:Object.freeze(missingRequired),
    partialRequired:Object.freeze(partialRequired),
    missingPreferred:Object.freeze(missingPreferred),
  });
}
