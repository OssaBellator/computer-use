export const WINDOWS_INTEGRITY_LEVELS = [
  'untrusted',
  'low',
  'medium',
  'high',
  'system',
] as const;

export type WindowsIntegrityLevel = typeof WINDOWS_INTEGRITY_LEVELS[number];

export interface WindowsInputIntegrityContext {
  readonly caller?: WindowsIntegrityLevel;
  readonly target?: WindowsIntegrityLevel;
}

export type WindowsInputIntegrityDecision =
  | { readonly allowed: true; readonly reason: 'equal-or-lower-integrity' }
  | { readonly allowed: false; readonly reason: 'integrity-unknown' | 'uipi-higher-integrity-target' };

const RANK: Readonly<Record<WindowsIntegrityLevel, number>> = Object.freeze({
  untrusted: 0,
  low: 1,
  medium: 2,
  high: 3,
  system: 4,
});

/**
 * Windows SendInput is subject to UIPI: a process may inject input only into a
 * target at an equal or lower integrity level. Unknown integrity fails closed.
 */
export function decideWindowsInputIntegrity(
  context: WindowsInputIntegrityContext,
): WindowsInputIntegrityDecision {
  if (context.caller === undefined || context.target === undefined) {
    return Object.freeze({ allowed:false, reason:'integrity-unknown' });
  }
  if (RANK[context.target] > RANK[context.caller]) {
    return Object.freeze({ allowed:false, reason:'uipi-higher-integrity-target' });
  }
  return Object.freeze({ allowed:true, reason:'equal-or-lower-integrity' });
}
