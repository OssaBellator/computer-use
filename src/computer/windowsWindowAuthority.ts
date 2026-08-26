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

function windowKey(window:WindowsUiaWindowRef):string {
  return `${window.desktopSessionId}:${window.hwnd}:${window.process.processId}:${window.process.startIdentity}:${window.generation}`;
}

/**
 * Resolves the interaction-authoritative top-level/modal window.
 *
 * A requested owner that UIA reports as BlockedByModalWindow may still route to
 * exactly one owned modal. Nested modal chains are followed until the deepest
 * unique modal is reached. Ambiguous/cyclic chains, closing/nonresponsive
 * windows, or a blocked window with no represented modal fail closed.
 */
export function decideWindowsWindowAuthority(
  requested: WindowsUiaWindowRef,
  snapshots: readonly WindowsWindowAuthoritySnapshot[],
): WindowsWindowAuthorityDecision {
  let current = snapshots.find((snapshot) => sameWindow(snapshot.window,requested));
  if (!current) return Object.freeze({allowed:false,reason:'target-not-found'});

  const visited = new Set<string>();
  for (let depth=0; depth<16; depth+=1) {
    const key = windowKey(current.window);
    if (visited.has(key)) return Object.freeze({allowed:false,reason:'modal-ambiguity'});
    visited.add(key);

    if (current.interactionState === 'closing') return Object.freeze({allowed:false,reason:'window-closing'});
    if (current.interactionState === 'not-responding') return Object.freeze({allowed:false,reason:'window-not-responding'});

    const ownedModals = snapshots.filter((snapshot) =>
      snapshot.isModal && snapshot.owner !== undefined && sameWindow(snapshot.owner,current!.window),
    );
    if (ownedModals.length > 1) return Object.freeze({allowed:false,reason:'modal-ambiguity'});
    if (ownedModals.length === 1) {
      current = ownedModals[0]!;
      continue;
    }

    if (current.interactionState === 'blocked-by-modal-window') {
      return Object.freeze({allowed:false,reason:'window-blocked-by-modal'});
    }
    return Object.freeze({allowed:true,target:current.window});
  }

  return Object.freeze({allowed:false,reason:'modal-ambiguity'});
}
