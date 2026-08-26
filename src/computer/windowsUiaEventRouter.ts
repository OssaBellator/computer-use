import type { WindowsUiaWindowRef } from './windowsUiaContract.js';
import type { WindowsUiaInvalidationReason } from './windowsUiaCacheState.js';

export const WINDOWS_UIA_INVALIDATION_EVENTS = [
  'structure-changed',
  'property-changed',
  'focus-changed',
  'window-opened',
  'window-closed',
] as const;
export type WindowsUiaInvalidationEvent = typeof WINDOWS_UIA_INVALIDATION_EVENTS[number];

export interface WindowsUiaEventRegistration {
  readonly registrationId: string;
  readonly window: WindowsUiaWindowRef;
  readonly events: readonly WindowsUiaInvalidationEvent[];
}

export interface WindowsUiaEventBridge {
  register(
    registration: WindowsUiaEventRegistration,
    onEvent: (event:WindowsUiaInvalidationEvent) => void,
  ): Promise<void>;
  unregister(registrationId:string): Promise<void>;
}

export interface WindowsUiaEpochSink {
  currentEpoch(window:WindowsUiaWindowRef): number;
  invalidate(window:WindowsUiaWindowRef, epoch:number, reason:WindowsUiaInvalidationReason): void;
}

const REGISTRATION_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

/**
 * Serializes event-handler registration/removal and translates UIA events into
 * monotonically increasing invalidation epochs. Event delivery is freshness
 * evidence only; it never verifies an action outcome.
 */
export class WindowsUiaEventRouter {
  private queue: Promise<void> = Promise.resolve();
  private readonly active = new Map<string, WindowsUiaEventRegistration>();

  constructor(private readonly bridge:WindowsUiaEventBridge, private readonly epochs:WindowsUiaEpochSink) {}

  register(registration:WindowsUiaEventRegistration): Promise<void> {
    return this.enqueue(async()=>{
      if (!REGISTRATION_ID.test(registration.registrationId)) throw new Error('windows-uia-event-registration-id-invalid');
      if (this.active.has(registration.registrationId)) throw new Error('windows-uia-event-registration-duplicate');
      if (registration.events.length === 0 || registration.events.some((event)=>!WINDOWS_UIA_INVALIDATION_EVENTS.includes(event))) {
        throw new Error('windows-uia-event-set-invalid');
      }
      const frozen = Object.freeze({...registration,events:Object.freeze([...new Set(registration.events)])});
      await this.bridge.register(frozen,(event)=>this.onEvent(frozen,event));
      this.active.set(frozen.registrationId,frozen);
    });
  }

  unregister(registrationId:string): Promise<void> {
    return this.enqueue(async()=>{
      if (!this.active.has(registrationId)) return;
      await this.bridge.unregister(registrationId);
      this.active.delete(registrationId);
    });
  }

  private onEvent(registration:WindowsUiaEventRegistration, event:WindowsUiaInvalidationEvent): void {
    if (!this.active.has(registration.registrationId)) return;
    if (!registration.events.includes(event)) return;
    const next = this.epochs.currentEpoch(registration.window) + 1;
    this.epochs.invalidate(registration.window,next,event);
  }

  private enqueue(operation:()=>Promise<void>): Promise<void> {
    const run = this.queue.then(operation,operation);
    this.queue = run.catch(()=>undefined);
    return run;
  }
}
