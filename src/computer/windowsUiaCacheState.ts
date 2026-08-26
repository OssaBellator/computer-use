import type { WindowsUiaCachedObservation, WindowsUiaWindowRef } from './windowsUiaContract.js';

export type WindowsUiaInvalidationReason =
  | 'structure-changed'
  | 'property-changed'
  | 'focus-changed'
  | 'window-opened'
  | 'window-closed'
  | 'provider-reset';

export interface WindowsUiaCacheLease {
  readonly window: WindowsUiaWindowRef;
  readonly invalidationEpoch: number;
  readonly capturedAtMs: number;
}

export type WindowsUiaCacheValidation =
  | { readonly status: 'current' }
  | { readonly status: 'invalidated'; readonly reason?: WindowsUiaInvalidationReason }
  | { readonly status: 'window-mismatch' }
  | { readonly status: 'epoch-regressed' };

function sameWindow(a: WindowsUiaWindowRef, b: WindowsUiaWindowRef): boolean {
  return a.hwnd === b.hwnd &&
    a.desktopSessionId === b.desktopSessionId &&
    a.process.processId === b.process.processId &&
    a.process.startIdentity === b.process.startIdentity &&
    a.generation === b.generation;
}

/**
 * Tracks provider-local UIA cache invalidation epochs. UIA events are treated as
 * reasons to re-observe, never as semantic success evidence.
 */
export class WindowsUiaCacheState {
  private readonly epochs = new Map<string, { epoch:number; reason?:WindowsUiaInvalidationReason }>();

  private key(window: WindowsUiaWindowRef): string {
    return `${window.desktopSessionId}:${window.hwnd}:${window.process.processId}:${window.process.startIdentity}:${window.generation}`;
  }

  register(observation: WindowsUiaCachedObservation): WindowsUiaCacheLease {
    if (!Number.isSafeInteger(observation.invalidationEpoch) || observation.invalidationEpoch < 0) {
      throw new Error('windows-uia-cache-epoch-invalid');
    }
    const key = this.key(observation.window);
    const known = this.epochs.get(key);
    if (known && observation.invalidationEpoch < known.epoch) throw new Error('windows-uia-cache-epoch-regressed');
    this.epochs.set(key,{epoch:observation.invalidationEpoch});
    return Object.freeze({
      window:observation.window,
      invalidationEpoch:observation.invalidationEpoch,
      capturedAtMs:observation.capturedAtMs,
    });
  }

  invalidate(window: WindowsUiaWindowRef, nextEpoch: number, reason: WindowsUiaInvalidationReason): void {
    if (!Number.isSafeInteger(nextEpoch) || nextEpoch < 0) throw new Error('windows-uia-cache-epoch-invalid');
    const key = this.key(window);
    const known = this.epochs.get(key);
    if (known && nextEpoch <= known.epoch) throw new Error('windows-uia-cache-epoch-must-increase');
    this.epochs.set(key,{epoch:nextEpoch,reason});
  }

  validate(lease: WindowsUiaCacheLease, currentWindow: WindowsUiaWindowRef): WindowsUiaCacheValidation {
    if (!sameWindow(lease.window,currentWindow)) return Object.freeze({status:'window-mismatch'});
    const known = this.epochs.get(this.key(currentWindow));
    if (!known) return Object.freeze({status:'invalidated'});
    if (known.epoch < lease.invalidationEpoch) return Object.freeze({status:'epoch-regressed'});
    if (known.epoch > lease.invalidationEpoch) {
      return Object.freeze({status:'invalidated',...(known.reason ? {reason:known.reason} : {})});
    }
    return Object.freeze({status:'current'});
  }
}
