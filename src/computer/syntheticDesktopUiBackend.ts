import type {
  DesktopAccessibilityNode,
  DesktopAccessibilityObservation,
  DesktopAbsolutePointerInput,
  DesktopBackendActionResult,
  DesktopFocusTarget,
  DesktopKeyboardInput,
  DesktopNativeWindowRef,
  DesktopRelativePointerInput,
  DesktopSystemObservation,
  DesktopVisualAcquisitionLimits,
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
  private observedAccessibilityRoots = new Map<string, DesktopAccessibilityNode>();
  visuals = new Map<string, DesktopVisualObservation>();
  lazyVisuals = new Map<string, {width:number;height:number;byteLength:number;token?:string;mediaType?:string}>();
  visualMaterializations = 0;
  lastVisualLimits?: DesktopVisualAcquisitionLimits;
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
    const observation = this.accessibility.get(this.key(window)) ?? {status:'unavailable' as const,window,reason:'not-configured'};
    if (observation.status === 'available' && observation.root) this.observedAccessibilityRoots.set(this.key(window), observation.root);
    else this.observedAccessibilityRoots.delete(this.key(window));
    return Promise.resolve(observation);
  }
  observeVisual(window:DesktopNativeWindowRef, limits:DesktopVisualAcquisitionLimits):Promise<DesktopVisualObservation> {
    this.lastVisualLimits = limits;
    const lazy = this.lazyVisuals.get(this.key(window));
    if (lazy) {
      if (lazy.width * lazy.height > limits.maxPixels || lazy.byteLength > limits.maxBytes) {
        return Promise.resolve({status:'unavailable',window,reason:'capture-budget-exceeded'});
      }
      this.visualMaterializations += 1;
      return Promise.resolve({
        status:'available', window, width:lazy.width, height:lazy.height,
        artifact:{token:lazy.token ?? 'synthetic-lazy-visual',...(lazy.mediaType ? {mediaType:lazy.mediaType} : {}),byteLength:lazy.byteLength},
      });
    }
    return Promise.resolve(this.visuals.get(this.key(window)) ?? {status:'unsupported',window,reason:'not-configured'});
  }
  private dispatch(kind:string,window:DesktopNativeWindowRef,payload:unknown,effect:ComputerEffectClass):DesktopBackendActionResult {
    this.actions.push({kind,window,payload,effect});
    if (this.throwOnAction===kind) throw new Error('synthetic action failure');
    return {status:'completed',dispatched:true,verified:true,evidence:[`synthetic-${kind}`]};
  }
  private currentControlExists(window:DesktopNativeWindowRef, controlId:string): boolean {
    const observation = this.accessibility.get(this.key(window));
    const leasedRoot = this.observedAccessibilityRoots.get(this.key(window));
    if (!observation || observation.status !== 'available' || !observation.root || observation.root !== leasedRoot) return false;
    const queue: Array<{node:DesktopAccessibilityNode;depth:number}> = [{node:observation.root,depth:0}];
    let cursor = 0;
    let seen = 0;
    while (cursor < queue.length && seen < 256) {
      const {node,depth} = queue[cursor++]!;
      seen += 1;
      if (node.controlId === controlId) return true;
      if (depth >= 16 || !node.children) continue;
      const remaining = 256 - seen - (queue.length - cursor);
      const childLimit = Math.min(node.children.length, Math.max(0, remaining));
      for (let index = 0; index < childLimit; index += 1) {
        const child = node.children[index];
        if (child) queue.push({node:child,depth:depth + 1});
      }
    }
    return false;
  }
  focus(target:DesktopFocusTarget,effect:ComputerEffectClass):Promise<DesktopBackendActionResult> {
    if (target.controlId !== undefined && !this.currentControlExists(target.window,target.controlId)) {
      return Promise.resolve({status:'rejected',dispatched:false,verified:false,evidence:['synthetic-control-stale']});
    }
    return Promise.resolve(this.dispatch('focus',target.window,target,effect));
  }
  keyboard(window:DesktopNativeWindowRef,input:DesktopKeyboardInput,effect:ComputerEffectClass):Promise<DesktopBackendActionResult> { return Promise.resolve(this.dispatch('keyboard',window,input,effect)); }
  pointerAbsolute(window:DesktopNativeWindowRef,input:DesktopAbsolutePointerInput,effect:ComputerEffectClass):Promise<DesktopBackendActionResult> { return Promise.resolve(this.dispatch('pointer-absolute',window,input,effect)); }
  pointerRelative(window:DesktopNativeWindowRef,input:DesktopRelativePointerInput,effect:ComputerEffectClass):Promise<DesktopBackendActionResult> { return Promise.resolve(this.dispatch('pointer-relative',window,input,effect)); }
}
