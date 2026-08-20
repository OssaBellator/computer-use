import { createHash, randomUUID } from 'node:crypto';
import type { ComputerEffectClass, ComputerObservationLimits } from './environmentAdapter.js';
import type {
  DesktopAbsolutePointerInput,
  DesktopAccessibilityNode,
  DesktopAccessibilityObservation,
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

export type DesktopPlatformKind = 'windows-uia' | 'macos-accessibility' | 'linux-atspi';

export interface PlatformDesktopWindow {
  /** OS/backend locator. It may be recycled and therefore is never sufficient identity by itself. */
  nativeId: string;
  /** Stable token for this exact live window instance. Changes whenever nativeId is replaced/reused and MUST NOT be reused for another instance. */
  instanceToken: string;
  applicationId?: string;
  processId?: string;
  title?: string;
  bounds?: { x:number; y:number; width:number; height:number };
  foreground: boolean;
  focused: boolean;
}

export interface PlatformDesktopControl {
  /** OS/backend locator. It may be recycled. */
  nativeId: string;
  /** Stable token for this exact live control instance; it MUST NOT be reused for a distinct replacement instance. */
  instanceToken: string;
  role?: string;
  name?: string;
  value?: string;
  enabled?: boolean;
  focused?: boolean;
  bounds?: { x:number; y:number; width:number; height:number };
  children?: readonly PlatformDesktopControl[];
}

export interface PlatformDesktopAccessibilityObservation {
  status: 'available' | 'unavailable' | 'unsupported';
  windowInstanceToken: string;
  root?: PlatformDesktopControl;
  reason?: string;
}

export interface PlatformDesktopVisualObservation {
  status: 'available' | 'unavailable' | 'unsupported';
  windowInstanceToken: string;
  width?: number;
  height?: number;
  artifact?: { token:string; mediaType?:string; byteLength:number };
  reason?: string;
}

export interface PlatformDispatchTarget {
  nativeWindowId: string;
  expectedWindowInstanceToken: string;
  nativeControlId?: string;
  expectedControlInstanceToken?: string;
}

export type PlatformDesktopDispatch =
  | { kind:'focus'; target:PlatformDispatchTarget }
  | { kind:'keyboard'; target:PlatformDispatchTarget; input:DesktopKeyboardInput }
  | { kind:'pointer-absolute'; target:PlatformDispatchTarget; input:DesktopAbsolutePointerInput }
  | { kind:'pointer-relative'; target:PlatformDispatchTarget; input:DesktopRelativePointerInput };

/**
 * Production OS seam. Implementations sit next to UI Automation, AX, or AT-SPI.
 *
 * Acquisition methods MUST apply the supplied limits while enumerating native
 * objects, before a large tree/image is materialized in JavaScript.
 *
 * dispatch() is the final authority boundary: immediately before emitting native
 * keyboard/pointer/focus input it MUST atomically verify every expected instance
 * token. A missing/replaced target returns rejected + dispatched:false. If an
 * exception can occur after input may have been emitted, it MUST be allowed to
 * escape so DesktopUiEnvironmentAdapter conservatively reports dispatch:unknown.
 * Native input transport success is not application-domain success.
 */
export interface DesktopPlatformBridge {
  readonly id: string;
  readonly platform: DesktopPlatformKind;
  readonly supportsRelativePointer?: boolean;
  enumerateWindows(limits:Required<ComputerObservationLimits>):Promise<{windows:readonly PlatformDesktopWindow[];truncated:boolean;focusedControlNativeId?:string}>;
  accessibility(window:PlatformDesktopWindow, limits:Required<ComputerObservationLimits>):Promise<PlatformDesktopAccessibilityObservation>;
  visual(window:PlatformDesktopWindow, limits:DesktopVisualAcquisitionLimits):Promise<PlatformDesktopVisualObservation>;
  dispatch(action:PlatformDesktopDispatch, effect:ComputerEffectClass):Promise<DesktopBackendActionResult>;
}

interface WindowLease {
  publicId:string;
  nativeId:string;
  instanceToken:string;
  generation:number;
  snapshot:PlatformDesktopWindow;
}
interface ControlLease { publicId:string; nativeId:string; instanceToken:string; serial:number }

function opaque(prefix:string, value:string):string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0,32)}`;
}
function cloneRect(value:{x:number;y:number;width:number;height:number}|undefined) {
  return value ? Object.freeze({x:value.x,y:value.y,width:value.width,height:value.height}) : undefined;
}
function freezeWindow(value:PlatformDesktopWindow):PlatformDesktopWindow {
  return Object.freeze({
    nativeId:String(value.nativeId), instanceToken:String(value.instanceToken),
    ...(value.applicationId !== undefined ? {applicationId:String(value.applicationId)} : {}),
    ...(value.processId !== undefined ? {processId:String(value.processId)} : {}),
    ...(value.title !== undefined ? {title:String(value.title)} : {}),
    ...(value.bounds ? {bounds:cloneRect(value.bounds)} : {}),
    foreground:value.foreground === true, focused:value.focused === true,
  });
}

function ownData(value:object,key:string):{present:boolean;value:unknown} {
  const property = Object.getOwnPropertyDescriptor(value,key);
  if (!property) return {present:false,value:undefined};
  if (!('value' in property)) throw new Error('platform accessibility accessor field rejected');
  return {present:true,value:property.value};
}
function finiteString(value:unknown,maxBytes:number,allowEmpty=false):string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new Error('platform accessibility string invalid');
  }
  return value;
}
function finiteControlRect(value:unknown):{x:number;y:number;width:number;height:number}|undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('platform accessibility bounds invalid');
  const x = ownData(value,'x'); const y = ownData(value,'y'); const width = ownData(value,'width'); const height = ownData(value,'height');
  if (!x.present || !y.present || !width.present || !height.present) throw new Error('platform accessibility bounds invalid');
  const numbers = [x.value,y.value,width.value,height.value];
  if (numbers.some((entry)=>typeof entry !== 'number' || !Number.isFinite(entry) || Math.abs(entry) > 1_000_000) ||
      (width.value as number) < 0 || (height.value as number) < 0) throw new Error('platform accessibility bounds invalid');
  return Object.freeze({x:x.value as number,y:y.value as number,width:width.value as number,height:height.value as number});
}
function captureControlTree(value:unknown,limits:Required<ComputerObservationLimits>):PlatformDesktopControl {
  let items = 0;
  let text = 0;
  const seen = new WeakSet<object>();
  const addText = (candidate:string) => {
    text += new TextEncoder().encode(candidate).byteLength;
    if (text > limits.maxTextBytes) throw new Error('platform bridge exceeded accessibility text budget');
  };
  const visit = (candidate:unknown,depth:number):PlatformDesktopControl => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('platform accessibility control invalid');
    if (depth > limits.maxDepth || items >= limits.maxItems) throw new Error('platform bridge exceeded accessibility acquisition budget');
    if (seen.has(candidate)) throw new Error('platform accessibility cycle invalid');
    seen.add(candidate);
    const nativeIdField = ownData(candidate,'nativeId');
    const instanceTokenField = ownData(candidate,'instanceToken');
    if (!nativeIdField.present || !instanceTokenField.present) throw new Error('platform accessibility identity invalid');
    const nativeId = finiteString(nativeIdField.value,256);
    const instanceToken = finiteString(instanceTokenField.value,512);
    addText(nativeId); addText(instanceToken);
    items += 1;

    const roleField = ownData(candidate,'role');
    const nameField = ownData(candidate,'name');
    const valueField = ownData(candidate,'value');
    const enabledField = ownData(candidate,'enabled');
    const focusedField = ownData(candidate,'focused');
    const boundsField = ownData(candidate,'bounds');
    const childrenField = ownData(candidate,'children');
    const role = roleField.present && roleField.value !== undefined ? finiteString(roleField.value,256,true) : undefined;
    const name = nameField.present && nameField.value !== undefined ? finiteString(nameField.value,4_096,true) : undefined;
    const controlValue = valueField.present && valueField.value !== undefined ? finiteString(valueField.value,4_096,true) : undefined;
    if (role !== undefined) addText(role); if (name !== undefined) addText(name); if (controlValue !== undefined) addText(controlValue);
    if (enabledField.present && enabledField.value !== undefined && typeof enabledField.value !== 'boolean') throw new Error('platform accessibility enabled invalid');
    if (focusedField.present && focusedField.value !== undefined && typeof focusedField.value !== 'boolean') throw new Error('platform accessibility focused invalid');
    const bounds = boundsField.present ? finiteControlRect(boundsField.value) : undefined;

    let children:readonly PlatformDesktopControl[]|undefined;
    if (childrenField.present && childrenField.value !== undefined) {
      const rawChildren = childrenField.value;
      if (!Array.isArray(rawChildren)) throw new Error('platform accessibility children invalid');
      const lengthProperty = Object.getOwnPropertyDescriptor(rawChildren,'length');
      if (!lengthProperty || !('value' in lengthProperty) || !Number.isSafeInteger(lengthProperty.value) || lengthProperty.value < 0) {
        throw new Error('platform accessibility children invalid');
      }
      const length = lengthProperty.value as number;
      if ((depth >= limits.maxDepth && length > 0) || length > limits.maxItems - items) {
        throw new Error('platform bridge exceeded accessibility acquisition budget');
      }
      const copied:PlatformDesktopControl[] = [];
      for (let index=0;index<length;index+=1) {
        const child = Object.getOwnPropertyDescriptor(rawChildren,String(index));
        if (!child || !('value' in child)) throw new Error('platform accessibility child invalid');
        copied.push(visit(child.value,depth + 1));
      }
      children = Object.freeze(copied);
    }
    return Object.freeze({
      nativeId,instanceToken,
      ...(role !== undefined ? {role} : {}),
      ...(name !== undefined ? {name} : {}),
      ...(controlValue !== undefined ? {value:controlValue} : {}),
      ...(enabledField.present && enabledField.value !== undefined ? {enabled:enabledField.value as boolean} : {}),
      ...(focusedField.present && focusedField.value !== undefined ? {focused:focusedField.value as boolean} : {}),
      ...(bounds ? {bounds} : {}),
      ...(children !== undefined ? {children} : {}),
    });
  };
  return visit(value,0);
}

/**
 * Generation/identity enforcing implementation shared by real platform bridges.
 * It intentionally exposes only NativeDesktopUiBackend's neutral data model.
 */
export class PlatformDesktopUiBackend implements NativeDesktopUiBackend {
  readonly id:string;
  readonly supportsRelativePointer:boolean;
  private readonly identityNamespace = randomUUID();
  private readonly windowsByNative = new Map<string,WindowLease>();
  private readonly windowsByPublic = new Map<string,WindowLease>();
  private readonly controls = new Map<string,Map<string,ControlLease>>();

  constructor(readonly bridge:DesktopPlatformBridge) {
    this.id = bridge.id;
    this.supportsRelativePointer = bridge.supportsRelativePointer === true;
  }

  private leaseWindow(raw:PlatformDesktopWindow):WindowLease {
    const snapshot = freezeWindow(raw);
    const previous = this.windowsByNative.get(snapshot.nativeId);
    const generation = previous === undefined ? 0 : previous.instanceToken === snapshot.instanceToken ? previous.generation : previous.generation + 1;
    const publicId = previous?.publicId ?? opaque('window', `${this.identityNamespace}\0${this.bridge.platform}\0${snapshot.nativeId}`);
    const lease = Object.freeze({publicId,nativeId:snapshot.nativeId,instanceToken:snapshot.instanceToken,generation,snapshot});
    this.windowsByNative.set(snapshot.nativeId,lease);
    this.windowsByPublic.set(publicId,lease);
    if (previous && previous.generation !== generation) this.controls.delete(`${publicId}@${previous.generation}`);
    return lease;
  }

  private snapshotWindow(lease:WindowLease):DesktopWindowSnapshot {
    const value = lease.snapshot;
    return Object.freeze({
      nativeWindowId:lease.publicId, generation:lease.generation,
      ...((value.applicationId !== undefined || value.processId !== undefined) ? {application:Object.freeze({
        ...(value.applicationId !== undefined ? {applicationId:value.applicationId} : {}),
        ...(value.processId !== undefined ? {processId:value.processId} : {}),
      })} : {}),
      ...(value.title !== undefined ? {title:value.title} : {}),
      ...(value.bounds ? {bounds:cloneRect(value.bounds)} : {}),
      foreground:value.foreground, focused:value.focused,
    });
  }

  async observeSystem(limits:Required<ComputerObservationLimits>):Promise<DesktopSystemObservation> {
    const result = await this.bridge.enumerateWindows(Object.freeze({...limits}));
    if (!Array.isArray(result.windows) || result.windows.length > limits.maxItems) throw new Error('platform bridge exceeded window acquisition budget');
    const leases = result.windows.map((window)=>this.leaseWindow(window));
    const windows = Object.freeze(leases.map((lease)=>this.snapshotWindow(lease)));
    const foreground = leases.find((lease)=>lease.snapshot.foreground);
    const focused = leases.find((lease)=>lease.snapshot.focused);
    let focusedControlId:string|undefined;
    if (focused && result.focusedControlNativeId) focusedControlId = this.controls.get(`${focused.publicId}@${focused.generation}`)?.get(result.focusedControlNativeId)?.publicId;
    return Object.freeze({
      windows, truncated:result.truncated === true,
      ...(foreground ? {foregroundWindow:Object.freeze({nativeWindowId:foreground.publicId,generation:foreground.generation})} : {}),
      ...(focused ? {focusedWindow:Object.freeze({nativeWindowId:focused.publicId,generation:focused.generation})} : {}),
      ...(focusedControlId ? {focusedControlId} : {}),
    });
  }

  private current(ref:DesktopNativeWindowRef):WindowLease|undefined {
    const lease = this.windowsByPublic.get(ref.nativeWindowId);
    return lease && lease.generation === ref.generation ? lease : undefined;
  }

  private leaseControl(window:WindowLease, raw:PlatformDesktopControl):DesktopAccessibilityNode {
    const key = `${window.publicId}@${window.generation}`;
    let map = this.controls.get(key);
    if (!map) { map = new Map(); this.controls.set(key,map); }
    const previous = map.get(raw.nativeId);
    const serial = previous === undefined ? 0 : previous.instanceToken === raw.instanceToken ? previous.serial : previous.serial + 1;
    const publicId = previous && previous.instanceToken === raw.instanceToken
      ? previous.publicId
      : opaque('control', `${this.identityNamespace}\0${key}\0${raw.nativeId}\0${serial}\0${raw.instanceToken}`);
    map.set(raw.nativeId,Object.freeze({publicId,nativeId:raw.nativeId,instanceToken:raw.instanceToken,serial}));
    const children = raw.children?.map((child)=>this.leaseControl(window,child));
    return Object.freeze({
      controlId:publicId,
      ...(raw.role !== undefined ? {role:raw.role} : {}),
      ...(raw.name !== undefined ? {name:raw.name} : {}),
      ...(raw.value !== undefined ? {value:raw.value} : {}),
      ...(raw.enabled !== undefined ? {enabled:raw.enabled} : {}),
      ...(raw.focused !== undefined ? {focused:raw.focused} : {}),
      ...(raw.bounds ? {bounds:cloneRect(raw.bounds)} : {}),
      ...(children ? {children:Object.freeze(children)} : {}),
    });
  }

  async observeAccessibility(ref:DesktopNativeWindowRef, limits:Required<ComputerObservationLimits>):Promise<DesktopAccessibilityObservation> {
    const lease = this.current(ref);
    if (!lease) return Object.freeze({status:'unavailable',window:Object.freeze({...ref}),reason:'stale-window'});
    const raw = await this.bridge.accessibility(lease.snapshot,Object.freeze({...limits}));
    if (raw.windowInstanceToken !== lease.instanceToken) return Object.freeze({status:'unavailable',window:Object.freeze({...ref}),reason:'window-replaced'});
    if (raw.status !== 'available' || !raw.root) return Object.freeze({status:raw.status,window:Object.freeze({...ref}),...(raw.reason ? {reason:String(raw.reason)} : {})});
    const capturedRoot = captureControlTree(raw.root,limits);
    const root = this.leaseControl(lease,capturedRoot);
    return Object.freeze({status:'available',window:Object.freeze({...ref}),root});
  }

  async observeVisual(ref:DesktopNativeWindowRef, limits:DesktopVisualAcquisitionLimits):Promise<DesktopVisualObservation> {
    const lease = this.current(ref);
    if (!lease) return Object.freeze({status:'unavailable',window:Object.freeze({...ref}),reason:'stale-window'});
    const raw = await this.bridge.visual(lease.snapshot,Object.freeze({...limits}));
    if (raw.windowInstanceToken !== lease.instanceToken) return Object.freeze({status:'unavailable',window:Object.freeze({...ref}),reason:'window-replaced'});
    if (raw.status !== 'available' || !raw.artifact || raw.width === undefined || raw.height === undefined) {
      return Object.freeze({status:raw.status,window:Object.freeze({...ref}),...(raw.reason ? {reason:String(raw.reason)} : {})});
    }
    return Object.freeze({status:'available',window:Object.freeze({...ref}),width:raw.width,height:raw.height,artifact:Object.freeze({...raw.artifact})});
  }

  private dispatchTarget(ref:DesktopNativeWindowRef, controlId?:string):PlatformDispatchTarget|undefined {
    const window = this.current(ref);
    if (!window) return undefined;
    if (controlId === undefined) return Object.freeze({nativeWindowId:window.nativeId,expectedWindowInstanceToken:window.instanceToken});
    const controls = this.controls.get(`${window.publicId}@${window.generation}`);
    const control = controls && [...controls.values()].find((candidate)=>candidate.publicId === controlId);
    if (!control) return undefined;
    return Object.freeze({nativeWindowId:window.nativeId,expectedWindowInstanceToken:window.instanceToken,nativeControlId:control.nativeId,expectedControlInstanceToken:control.instanceToken});
  }

  private rejected():DesktopBackendActionResult { return Object.freeze({status:'rejected',dispatched:false,verified:false,evidence:Object.freeze(['desktop-target-stale'])}); }

  async focus(target:DesktopFocusTarget,effect:ComputerEffectClass):Promise<DesktopBackendActionResult> {
    const platformTarget = this.dispatchTarget(target.window,target.controlId);
    if (!platformTarget) return this.rejected();
    return this.bridge.dispatch(Object.freeze({kind:'focus',target:platformTarget}),effect);
  }
  async keyboard(window:DesktopNativeWindowRef,input:DesktopKeyboardInput,effect:ComputerEffectClass):Promise<DesktopBackendActionResult> {
    const target = this.dispatchTarget(window); if (!target) return this.rejected();
    return this.bridge.dispatch(Object.freeze({kind:'keyboard',target,input:Object.freeze({...input})}),effect);
  }
  async pointerAbsolute(window:DesktopNativeWindowRef,input:DesktopAbsolutePointerInput,effect:ComputerEffectClass):Promise<DesktopBackendActionResult> {
    const target = this.dispatchTarget(window); if (!target) return this.rejected();
    return this.bridge.dispatch(Object.freeze({kind:'pointer-absolute',target,input:Object.freeze({...input})}),effect);
  }
  async pointerRelative(window:DesktopNativeWindowRef,input:DesktopRelativePointerInput,effect:ComputerEffectClass):Promise<DesktopBackendActionResult> {
    if (!this.supportsRelativePointer) return Object.freeze({status:'unsupported',dispatched:false,verified:false});
    const target = this.dispatchTarget(window); if (!target) return this.rejected();
    return this.bridge.dispatch(Object.freeze({kind:'pointer-relative',target,input:Object.freeze({...input})}),effect);
  }
}
