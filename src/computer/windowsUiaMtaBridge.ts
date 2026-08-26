import type { ComputerEffectClass } from './environmentAdapter.js';
import type { DesktopBackendActionResult } from './desktopUiBackend.js';
import { WindowsComApartmentExecutor, type WindowsComApartmentContext } from './windowsComApartment.js';
import type {
  WindowsUiaCachedObservation,
  WindowsUiaControlRef,
  WindowsUiaRevalidation,
  WindowsUiaSemanticAction,
  WindowsUiaWindowRef,
} from './windowsUiaContract.js';
import type {
  WindowsUiaNativeElementHandle,
  WindowsUiaProviderBridge,
} from './windowsUiaProviderRuntime.js';
import type { WindowsUiaCacheRequestPlan } from './windowsUiaCacheRequestPlan.js';

export interface WindowsUiaMtaNativeClient {
  resolveWindow(
    context: WindowsComApartmentContext,
    window: WindowsUiaWindowRef,
  ): Promise<{ readonly status:'current'; readonly root:WindowsUiaNativeElementHandle } | { readonly status:'missing'|'stale'|'inaccessible' }>;

  buildCache(
    context: WindowsComApartmentContext,
    root: WindowsUiaNativeElementHandle,
    plan: WindowsUiaCacheRequestPlan,
    invalidationEpoch:number,
  ): Promise<WindowsUiaCachedObservation>;

  resolveControl(
    context: WindowsComApartmentContext,
    ref: WindowsUiaControlRef,
  ): Promise<{ readonly status:'candidate'; readonly element:WindowsUiaNativeElementHandle } | { readonly status:'missing'|'ambiguous'|'inaccessible' }>;

  compareElements(
    context: WindowsComApartmentContext,
    a: WindowsUiaNativeElementHandle,
    b: WindowsUiaNativeElementHandle,
  ): Promise<boolean>;

  snapshotControl(
    context: WindowsComApartmentContext,
    element: WindowsUiaNativeElementHandle,
    ref: WindowsUiaControlRef,
  ): Promise<WindowsUiaRevalidation>;

  performPattern(
    context: WindowsComApartmentContext,
    element: WindowsUiaNativeElementHandle,
    action: WindowsUiaSemanticAction,
    effect:ComputerEffectClass,
  ): Promise<DesktopBackendActionResult>;
}

/**
 * Concrete provider bridge boundary for a native Windows UIA host.
 *
 * Every native operation is serialized through the dedicated MTA apartment. COM
 * interface pointers must remain behind `WindowsUiaMtaNativeClient`; the opaque
 * handle token is only meaningful to that client and must never be dereferenced
 * by TypeScript code.
 */
export class WindowsUiaMtaBridge implements WindowsUiaProviderBridge {
  constructor(
    readonly apartment: WindowsComApartmentExecutor,
    readonly client: WindowsUiaMtaNativeClient,
  ) {}

  resolveWindow(window: WindowsUiaWindowRef) {
    return this.apartment.run((context) => this.client.resolveWindow(context,window));
  }

  buildCache(root: WindowsUiaNativeElementHandle, plan: WindowsUiaCacheRequestPlan, invalidationEpoch:number) {
    return this.apartment.run((context) => this.client.buildCache(context,root,plan,invalidationEpoch));
  }

  resolveControl(ref: WindowsUiaControlRef) {
    return this.apartment.run((context) => this.client.resolveControl(context,ref));
  }

  compareElements(a: WindowsUiaNativeElementHandle, b: WindowsUiaNativeElementHandle) {
    return this.apartment.run((context) => this.client.compareElements(context,a,b));
  }

  snapshotControl(element: WindowsUiaNativeElementHandle, ref: WindowsUiaControlRef) {
    return this.apartment.run((context) => this.client.snapshotControl(context,element,ref));
  }

  performPattern(element: WindowsUiaNativeElementHandle, action: WindowsUiaSemanticAction, effect:ComputerEffectClass) {
    return this.apartment.run((context) => this.client.performPattern(context,element,action,effect));
  }
}
