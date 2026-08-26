import type { WindowsUiaWindowRef } from './windowsUiaContract.js';

export type WindowsWindowInteractionState =
  | 'running'
  | 'closing'
  | 'ready-for-user-interaction'
  | 'blocked-by-modal-window'
  | 'not-responding';

export interface WindowsWindowAuthoritySnapshot {
  readonly window: WindowsUiaWindowRef;
  readonly isModal: boolean;
  readonly isTopmost?: boolean;
  readonly interactionState: WindowsWindowInteractionState;
  /** Exact owner window when the provider can determine it. */
  readonly owner?: WindowsUiaWindowRef;
}

export type WindowsWindowAuthorityDecision =
  | { readonly allowed:true; readonly target:WindowsUiaWindowRef }
  | { readonly allowed:false; readonly reason:
      | 'window-closing'
      | 'window-not-responding'
      | 'window-blocked-by-modal'
      | 'modal-ambiguity'
      | 'target-not-found' };

function sameWindow(a: WindowsUiaWindowRef, b: WindowsUiaWindowRef): boolean {
  return a.hwnd === b.hwnd &&
    a.desktopSessionId === b.desktopSessionId &&
    a.process.processId === b.process.processId &&
    a.process.startIdentity === b.process.startIdentity &&
    a.generation === b.generation;
}

/**
 * Resolves whether the requested top-level window currently has interaction
 * authority. A live HWND is not sufficient when UIA reports modal blocking,
 * closing state, non-responsiveness, or multiple plausible modal descendants.
 */
export function decideWindowsWindowAuthority(
  requested: WindowsUiaWindowRef,
  snapshots: readonly WindowsWindowAuthoritySnapshot[],
): WindowsWindowAuthorityDecision {
  const target = snapshots.find((snapshot) => sameWindow(snapshot.window,requested));
  if (!target) return Object.freeze({allowed:false,reason:'target-not-found'});

  if (target.interactionState === 'closing') return Object.freeze({allowed:false,reason:'window-closing'});
  if (target.interactionState === 'not-responding') return Object.freeze({allowed:false,reason:'window-not-responding'});
  if (target.interactionState === 'blocked-by-modal-window') return Object.freeze({allowed:false,reason:'window-blocked-by-modal'});

  const ownedModals = snapshots.filter((snapshot) =>
    snapshot.isModal && snapshot.owner !== undefined && sameWindow(snapshot.owner,requested),
  );
  if (ownedModals.length > 1) return Object.freeze({allowed:false,reason:'modal-ambiguity'});
  if (ownedModals.length === 1) return Object.freeze({allowed:true,target:ownedModals[0]!.window});

  return Object.freeze({allowed:true,target:requested});
}
