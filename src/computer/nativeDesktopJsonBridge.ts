import { execFile } from 'node:child_process';
import type { ComputerEffectClass, ComputerObservationLimits } from './environmentAdapter.js';
import type { DesktopBackendActionResult, DesktopVisualAcquisitionLimits } from './desktopUiBackend.js';
import type {
  DesktopPlatformBridge,
  DesktopPlatformKind,
  PlatformDesktopAccessibilityObservation,
  PlatformDesktopControl,
  PlatformDesktopDispatch,
  PlatformDesktopVisualObservation,
  PlatformDesktopWindow,
} from './desktopPlatformBackend.js';

const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_NATIVE_STRING_BYTES = 4_096;
const MAX_EVIDENCE_ITEMS = 16;
const REASON_CODE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

export interface NativeDesktopBridgeCommand {
  executable:string;
  args?:readonly string[];
  env?:Readonly<Record<string,string>>;
  maxResponseBytes?:number;
  timeoutMs?:number;
}

export interface DesktopBridgeExecutor {
  invoke(operation:string,payload:unknown,limits:{maxResponseBytes:number;timeoutMs:number}):Promise<unknown>;
}

/**
 * Executes one bounded request against a small native helper process. The helper
 * is expected to use UIA/AX/AT-SPI and OS input injection directly; browser/page
 * synthetic event mechanisms are outside this protocol.
 */
export class JsonProcessDesktopBridgeExecutor implements DesktopBridgeExecutor {
  constructor(private readonly command:NativeDesktopBridgeCommand) {}

  invoke(operation:string,payload:unknown,limits:{maxResponseBytes:number;timeoutMs:number}):Promise<unknown> {
    const request = JSON.stringify({version:1,operation,payload});
    return new Promise((resolve,reject)=>{
      execFile(this.command.executable,[...(this.command.args ?? []),'--request',request],{
        encoding:'utf8',
        maxBuffer:Math.min(this.command.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,limits.maxResponseBytes),
        timeout:Math.min(this.command.timeoutMs ?? DEFAULT_TIMEOUT_MS,limits.timeoutMs),
        windowsHide:true,
        env:this.command.env ? {...process.env,...this.command.env} : process.env,
      },(error,stdout)=>{
        if (error) { reject(error); return; }
        try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
      });
    });
  }
}

function textBytes(value:string):number { return new TextEncoder().encode(value).byteLength; }
function boundedString(value:unknown,maxBytes=MAX_NATIVE_STRING_BYTES,allowEmpty=false):value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && textBytes(value) <= maxBytes && !/[\0\r\n]/.test(value);
}
function asObject(value:unknown):Readonly<Record<string,unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('native desktop bridge returned non-plain object');
  }
  return value as Readonly<Record<string,unknown>>;
}
function ownKeysOnly(object:Readonly<Record<string,unknown>>,allowed:readonly string[]):void {
  if (Object.keys(object).some((key)=>!allowed.includes(key))) throw new Error('native desktop bridge returned unexpected fields');
}
function finiteRect(value:unknown):{x:number;y:number;width:number;height:number}|undefined {
  if (value === undefined) return undefined;
  const object = asObject(value); ownKeysOnly(object,['x','y','width','height']);
  const values = [object.x,object.y,object.width,object.height];
  if (values.some((entry)=>typeof entry !== 'number' || !Number.isFinite(entry) || Math.abs(entry) > 1_000_000) ||
      (object.width as number) < 0 || (object.height as number) < 0) throw new Error('native desktop rectangle malformed');
  return Object.freeze({x:object.x as number,y:object.y as number,width:object.width as number,height:object.height as number});
}
function windowValue(value:unknown):PlatformDesktopWindow {
  const object = asObject(value);
  ownKeysOnly(object,['nativeId','instanceToken','applicationId','processId','title','bounds','foreground','focused']);
  if (!boundedString(object.nativeId,256) || !boundedString(object.instanceToken,512) ||
      typeof object.foreground !== 'boolean' || typeof object.focused !== 'boolean') throw new Error('native desktop window malformed');
  if (object.applicationId !== undefined && !boundedString(object.applicationId,256)) throw new Error('native application identity malformed');
  if (object.processId !== undefined && !boundedString(object.processId,256)) throw new Error('native process identity malformed');
  if (object.title !== undefined && !boundedString(object.title,4_096,true)) throw new Error('native window title malformed');
  return Object.freeze({
    nativeId:object.nativeId,instanceToken:object.instanceToken,
    ...(object.applicationId !== undefined ? {applicationId:object.applicationId as string} : {}),
    ...(object.processId !== undefined ? {processId:object.processId as string} : {}),
    ...(object.title !== undefined ? {title:object.title as string} : {}),
    ...(object.bounds !== undefined ? {bounds:finiteRect(object.bounds)!} : {}),
    foreground:object.foreground,focused:object.focused,
  });
}
function windowsResult(value:unknown,limits:Required<ComputerObservationLimits>):{windows:readonly PlatformDesktopWindow[];truncated:boolean;focusedControlNativeId?:string} {
  const object = asObject(value); ownKeysOnly(object,['windows','truncated','focusedControlNativeId']);
  if (!Array.isArray(object.windows) || object.windows.length > limits.maxItems || typeof object.truncated !== 'boolean') {
    throw new Error('native desktop window response malformed');
  }
  if (object.focusedControlNativeId !== undefined && !boundedString(object.focusedControlNativeId,256)) {
    throw new Error('native focused control identity malformed');
  }
  const windows = Object.freeze(object.windows.map(windowValue));
  return Object.freeze({windows,truncated:object.truncated,...(object.focusedControlNativeId !== undefined ? {focusedControlNativeId:object.focusedControlNativeId as string} : {})});
}
function controlTree(value:unknown,limits:Required<ComputerObservationLimits>):PlatformDesktopControl {
  let count = 0;
  let text = 0;
  const visit = (candidate:unknown,depth:number):PlatformDesktopControl => {
    if (depth > limits.maxDepth || count >= limits.maxItems) throw new Error('native accessibility response exceeded acquisition limits');
    const object = asObject(candidate);
    ownKeysOnly(object,['nativeId','instanceToken','role','name','value','enabled','focused','bounds','children']);
    if (!boundedString(object.nativeId,256) || !boundedString(object.instanceToken,512)) throw new Error('native accessibility identity malformed');
    for (const key of ['role','name','value'] as const) {
      const field = object[key];
      if (field !== undefined && !boundedString(field,key === 'role' ? 256 : 4_096,true)) throw new Error('native accessibility text malformed');
      if (typeof field === 'string') text += textBytes(field);
    }
    text += textBytes(object.nativeId) + textBytes(object.instanceToken);
    if (text > limits.maxTextBytes) throw new Error('native accessibility response exceeded text acquisition limit');
    if (object.enabled !== undefined && typeof object.enabled !== 'boolean') throw new Error('native accessibility enabled malformed');
    if (object.focused !== undefined && typeof object.focused !== 'boolean') throw new Error('native accessibility focused malformed');
    count += 1;
    let children:readonly PlatformDesktopControl[]|undefined;
    if (object.children !== undefined) {
      if (!Array.isArray(object.children)) throw new Error('native accessibility children malformed');
      children = Object.freeze(object.children.map((child)=>visit(child,depth + 1)));
    }
    return Object.freeze({
      nativeId:object.nativeId,instanceToken:object.instanceToken,
      ...(object.role !== undefined ? {role:object.role as string} : {}),
      ...(object.name !== undefined ? {name:object.name as string} : {}),
      ...(object.value !== undefined ? {value:object.value as string} : {}),
      ...(object.enabled !== undefined ? {enabled:object.enabled as boolean} : {}),
      ...(object.focused !== undefined ? {focused:object.focused as boolean} : {}),
      ...(object.bounds !== undefined ? {bounds:finiteRect(object.bounds)!} : {}),
      ...(children !== undefined ? {children} : {}),
    });
  };
  return visit(value,0);
}
function accessibilityResult(value:unknown,limits:Required<ComputerObservationLimits>):PlatformDesktopAccessibilityObservation {
  const object = asObject(value); ownKeysOnly(object,['status','windowInstanceToken','root','reason']);
  if (object.status !== 'available' && object.status !== 'unavailable' && object.status !== 'unsupported') throw new Error('native accessibility status malformed');
  if (!boundedString(object.windowInstanceToken,512)) throw new Error('native accessibility window token malformed');
  if (object.reason !== undefined && (!boundedString(object.reason,64) || !REASON_CODE.test(object.reason))) throw new Error('native accessibility reason malformed');
  if (object.status === 'available') {
    if (object.root === undefined || object.reason !== undefined) throw new Error('native accessibility availability malformed');
    return Object.freeze({status:'available',windowInstanceToken:object.windowInstanceToken,root:controlTree(object.root,limits)});
  }
  if (object.root !== undefined) throw new Error('native accessibility unavailable response malformed');
  return Object.freeze({status:object.status,windowInstanceToken:object.windowInstanceToken,...(object.reason !== undefined ? {reason:object.reason as string} : {})});
}
function visualResult(value:unknown,limits:DesktopVisualAcquisitionLimits):PlatformDesktopVisualObservation {
  const object = asObject(value); ownKeysOnly(object,['status','windowInstanceToken','width','height','artifact','reason']);
  if (object.status !== 'available' && object.status !== 'unavailable' && object.status !== 'unsupported') throw new Error('native visual status malformed');
  if (!boundedString(object.windowInstanceToken,512)) throw new Error('native visual window token malformed');
  if (object.reason !== undefined && (!boundedString(object.reason,64) || !REASON_CODE.test(object.reason))) throw new Error('native visual reason malformed');
  if (object.status !== 'available') {
    if (object.width !== undefined || object.height !== undefined || object.artifact !== undefined) throw new Error('native visual unavailable response malformed');
    return Object.freeze({status:object.status,windowInstanceToken:object.windowInstanceToken,...(object.reason !== undefined ? {reason:object.reason as string} : {})});
  }
  if (object.reason !== undefined || !Number.isSafeInteger(object.width) || !Number.isSafeInteger(object.height) ||
      (object.width as number) <= 0 || (object.height as number) <= 0 || (object.width as number) * (object.height as number) > limits.maxPixels) {
    throw new Error('native visual dimensions exceeded acquisition limits');
  }
  const artifact = asObject(object.artifact); ownKeysOnly(artifact,['token','mediaType','byteLength']);
  if (!boundedString(artifact.token,256) || (artifact.mediaType !== undefined && !boundedString(artifact.mediaType,128)) ||
      !Number.isSafeInteger(artifact.byteLength) || (artifact.byteLength as number) < 0 || (artifact.byteLength as number) > limits.maxBytes) {
    throw new Error('native visual artifact exceeded acquisition limits');
  }
  return Object.freeze({status:'available',windowInstanceToken:object.windowInstanceToken,width:object.width as number,height:object.height as number,artifact:Object.freeze({token:artifact.token,...(artifact.mediaType !== undefined ? {mediaType:artifact.mediaType as string} : {}),byteLength:artifact.byteLength as number})});
}
function dispatchResult(value:unknown):DesktopBackendActionResult {
  const object = asObject(value); ownKeysOnly(object,['status','dispatched','verified','evidence']);
  if (object.status !== 'completed' && object.status !== 'rejected' && object.status !== 'unsupported' && object.status !== 'failed') throw new Error('native dispatch status malformed');
  if (typeof object.dispatched !== 'boolean' || (object.verified !== undefined && typeof object.verified !== 'boolean')) throw new Error('native dispatch result malformed');
  let evidence:readonly string[]|undefined;
  if (object.evidence !== undefined) {
    if (!Array.isArray(object.evidence) || object.evidence.length > MAX_EVIDENCE_ITEMS || object.evidence.some((entry)=>typeof entry !== 'string' || !REASON_CODE.test(entry))) {
      throw new Error('native dispatch evidence malformed');
    }
    evidence = Object.freeze([...object.evidence] as string[]);
  }
  return Object.freeze({status:object.status,dispatched:object.dispatched,...(object.verified !== undefined ? {verified:object.verified as boolean} : {}),...(evidence ? {evidence} : {})});
}

/**
 * Rigorously testable production bridge boundary. The native helper owns the
 * platform call and MUST enforce instance-token freshness inside the same native
 * critical section as input dispatch. Helper exceptions after possible emission
 * deliberately propagate; the neutral adapter will classify dispatch unknown.
 */
export class NativeJsonDesktopPlatformBridge implements DesktopPlatformBridge {
  readonly supportsRelativePointer:boolean;
  constructor(
    readonly id:string,
    readonly platform:DesktopPlatformKind,
    private readonly executor:DesktopBridgeExecutor,
    options?:{supportsRelativePointer?:boolean;maxResponseBytes?:number;timeoutMs?:number},
  ) {
    this.supportsRelativePointer = options?.supportsRelativePointer === true;
    this.maxResponseBytes = Math.max(4_096,Math.min(16_000_000,options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES));
    this.timeoutMs = Math.max(100,Math.min(30_000,options?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  }
  private readonly maxResponseBytes:number;
  private readonly timeoutMs:number;
  private invoke(operation:string,payload:unknown):Promise<unknown> {
    return this.executor.invoke(operation,payload,{maxResponseBytes:this.maxResponseBytes,timeoutMs:this.timeoutMs});
  }
  async enumerateWindows(limits:Required<ComputerObservationLimits>) {
    return windowsResult(await this.invoke('enumerate-windows',{limits:{...limits}}),limits);
  }
  async accessibility(window:PlatformDesktopWindow,limits:Required<ComputerObservationLimits>):Promise<PlatformDesktopAccessibilityObservation> {
    return accessibilityResult(await this.invoke('accessibility',{window:{nativeId:window.nativeId,instanceToken:window.instanceToken},limits:{...limits}}),limits);
  }
  async visual(window:PlatformDesktopWindow,limits:DesktopVisualAcquisitionLimits):Promise<PlatformDesktopVisualObservation> {
    return visualResult(await this.invoke('visual',{window:{nativeId:window.nativeId,instanceToken:window.instanceToken},limits:{...limits}}),limits);
  }
  async dispatch(action:PlatformDesktopDispatch,effect:ComputerEffectClass):Promise<DesktopBackendActionResult> {
    return dispatchResult(await this.invoke('dispatch',{action,effect}));
  }
}

export function windowsUiAutomationBridge(command:NativeDesktopBridgeCommand,executor:DesktopBridgeExecutor=new JsonProcessDesktopBridgeExecutor(command)) {
  return new NativeJsonDesktopPlatformBridge('windows-uia','windows-uia',executor,{supportsRelativePointer:true,maxResponseBytes:command.maxResponseBytes,timeoutMs:command.timeoutMs});
}
export function macOsAccessibilityBridge(command:NativeDesktopBridgeCommand,executor:DesktopBridgeExecutor=new JsonProcessDesktopBridgeExecutor(command)) {
  return new NativeJsonDesktopPlatformBridge('macos-accessibility','macos-accessibility',executor,{supportsRelativePointer:true,maxResponseBytes:command.maxResponseBytes,timeoutMs:command.timeoutMs});
}
export function linuxAtSpiBridge(command:NativeDesktopBridgeCommand,executor:DesktopBridgeExecutor=new JsonProcessDesktopBridgeExecutor(command)) {
  return new NativeJsonDesktopPlatformBridge('linux-atspi','linux-atspi',executor,{supportsRelativePointer:true,maxResponseBytes:command.maxResponseBytes,timeoutMs:command.timeoutMs});
}
