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

function textBytes(value: string | undefined): number {
  return value ? new TextEncoder().encode(value).byteLength : 0;
}

function windowTextBytes(window: DesktopWindowSnapshot): number {
  return textBytes(window.nativeWindowId) + textBytes(window.title) + textBytes(window.application?.applicationId) + textBytes(window.application?.processId);
}

export class SyntheticDesktopUiBackend implements NativeDesktopUiBackend {
  readonly id = 'synthetic';
  readonly supportsRelativePointer = true;
  windows: DesktopWindowSnapshot[] = [];
  /** Optional lazy source used to prove bounded enumeration without materializing a huge fixture. */
  lazyWindowCount = 0;
  lazyWindowFactory?: (index:number) => DesktopWindowSnapshot;
  systemEnumeratedWindows = 0;
  focusedControlId?: string;
  accessibility = new Map<string, DesktopAccessibilityObservation>();
  visuals = new Map<string, DesktopVisualObservation>();
  actions: Array<{kind:string;window:DesktopNativeWindowRef;payload?:unknown;effect:ComputerEffectClass}> = [];
  throwOnAction?: string;

  key(ref:DesktopNativeWindowRef):string { return `${ref.nativeWindowId}@${ref.generation}`; }
  observeSystem(limits:Required<ComputerObservationLimits>): Promise<DesktopSystemObservation> {
    const emitted: DesktopWindowSnapshot[] = [];
    let bytes = 0;
    let truncated = false;
    const total = this.lazyWindowFactory ? this.lazyWindowCount : this.windows.length;
    this.systemEnumeratedWindows = 0;
    for (let index = 0; index < total; index += 1) {
      if (emitted.length >= limits.maxItems) { truncated = true; break; }
      const source = this.lazyWindowFactory ? this.lazyWindowFactory(index) : this.windows[index]!;
      this.systemEnumeratedWindows += 1;
      const ownBytes = windowTextBytes(source);
      if (bytes + ownBytes > limits.maxTextBytes) { truncated = true; break; }
      bytes += ownBytes;
      emitted.push({...source, application:source.application ? {...source.application} : undefined, bounds:source.bounds ? {...source.bounds} : undefined});
    }
    if (emitted.length < total) truncated = true;
    const foreground = emitted.find((w)=>w.foreground);
    const focused = emitted.find((w)=>w.focused);
    return Promise.resolve({ windows:emitted, truncated, foregroundWindow:foreground&&{nativeWindowId:foreground.nativeWindowId,generation:foreground.generation}, focusedWindow:focused&&{nativeWindowId:focused.nativeWindowId,generation:focused.generation}, focusedControlId:focused ? this.focusedControlId : undefined });
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
