import type {
  DesktopAccessibilityObservation,
  DesktopAbsolutePointerInput,
  DesktopBackendActionResult,
  DesktopFocusTarget,
  DesktopKeyboardInput,
  DesktopNativeWindowRef,
  DesktopRelativePointerInput,
  DesktopSystemObservation,
  DesktopVisualObservation,
  DesktopWindowSnapshot,
  NativeDesktopUiBackend,
} from './desktopUiBackend.js';
import type { ComputerEffectClass, ComputerObservationLimits } from './environmentAdapter.js';

export class SyntheticDesktopUiBackend implements NativeDesktopUiBackend {
  readonly id = 'synthetic';
  readonly supportsRelativePointer = true;
  windows: DesktopWindowSnapshot[] = [];
  focusedControlId?: string;
  accessibility = new Map<string, DesktopAccessibilityObservation>();
  visuals = new Map<string, DesktopVisualObservation>();
  actions: Array<{kind:string;window:DesktopNativeWindowRef;payload?:unknown;effect:ComputerEffectClass}> = [];
  throwOnAction?: string;

  key(ref:DesktopNativeWindowRef):string { return `${ref.nativeWindowId}@${ref.generation}`; }
  observeSystem(): Promise<DesktopSystemObservation> {
    const foreground = this.windows.find((w)=>w.foreground);
    const focused = this.windows.find((w)=>w.focused);
    return Promise.resolve({ windows:this.windows.map((w)=>({...w})), foregroundWindow:foreground&&{nativeWindowId:foreground.nativeWindowId,generation:foreground.generation}, focusedWindow:focused&&{nativeWindowId:focused.nativeWindowId,generation:focused.generation}, focusedControlId:this.focusedControlId });
  }
  observeAccessibility(window:DesktopNativeWindowRef, _limits:Required<ComputerObservationLimits>):Promise<DesktopAccessibilityObservation> {
    return Promise.resolve(this.accessibility.get(this.key(window)) ?? {status:'unavailable',window,reason:'not-configured'});
  }
  observeVisual(window:DesktopNativeWindowRef):Promise<DesktopVisualObservation> {
    return Promise.resolve(this.visuals.get(this.key(window)) ?? {status:'unsupported',window,reason:'not-configured'});
  }
  private dispatch(kind:string,window:DesktopNativeWindowRef,payload:unknown,effect:ComputerEffectClass):DesktopBackendActionResult {
    this.actions.push({kind,window,payload,effect});
    if (this.throwOnAction===kind) throw new Error('synthetic action failure');
    return {status:'completed',dispatched:true,verified:true,evidence:[`synthetic-${kind}`]};
  }
  focus(target:DesktopFocusTarget,effect:ComputerEffectClass):Promise<DesktopBackendActionResult> { return Promise.resolve(this.dispatch('focus',target.window,target,effect)); }
  keyboard(window:DesktopNativeWindowRef,input:DesktopKeyboardInput,effect:ComputerEffectClass):Promise<DesktopBackendActionResult> { return Promise.resolve(this.dispatch('keyboard',window,input,effect)); }
  pointerAbsolute(window:DesktopNativeWindowRef,input:DesktopAbsolutePointerInput,effect:ComputerEffectClass):Promise<DesktopBackendActionResult> { return Promise.resolve(this.dispatch('pointer-absolute',window,input,effect)); }
  pointerRelative(window:DesktopNativeWindowRef,input:DesktopRelativePointerInput,effect:ComputerEffectClass):Promise<DesktopBackendActionResult> { return Promise.resolve(this.dispatch('pointer-relative',window,input,effect)); }
}
