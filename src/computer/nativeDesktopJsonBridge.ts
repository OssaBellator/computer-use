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
  /** Advertise only when the configured helper really implements native relative motion. */
  supportsRelativePointer?:boolean;
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
function asObject(value:unknown):object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('native desktop bridge returned non-object');
  return value;
}
function field(object:object,key:string):{present:boolean;value:unknown} {
  let property:PropertyDescriptor|undefined;
  try { property = Object.getOwnPropertyDescriptor(object,key); }
  catch { throw new Error('native desktop bridge result field malformed'); }
  if (!property) return {present:false,value:undefined};
  if (!('value' in property) || property.get !== undefined || property.set !== undefined) throw new Error('native desktop bridge result accessor rejected');
  return {present:true,value:property.value};
}
function requiredField(object:object,key:string):unknown {
  const result = field(object,key);
  if (!result.present) throw new Error('native desktop bridge result field missing');
  return result.value;
}
function capturedArray(value:unknown,maxItems:number):readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('native desktop bridge array malformed');
  let lengthProperty:PropertyDescriptor|undefined;
  try { lengthProperty = Object.getOwnPropertyDescriptor(value,'length'); }
  catch { throw new Error('native desktop bridge array malformed'); }
  if (!lengthProperty || !('value' in lengthProperty) || !Number.isSafeInteger(lengthProperty.value) || lengthProperty.value < 0 || lengthProperty.value > maxItems) {
    throw new Error('native desktop bridge array malformed');
  }
  const result:unknown[] = [];
  for (let index=0;index<(lengthProperty.value as number);index+=1) {
    let property:PropertyDescriptor|undefined;
    try { property = Object.getOwnPropertyDescriptor(value,String(index)); }
    catch { throw new Error('native desktop bridge array malformed'); }
    if (!property || !('value' in property) || property.get !== undefined || property.set !== undefined) throw new Error('native desktop bridge array malformed');
    result.push(property.value);
  }
  return Object.freeze(result);
}
function finiteRect(value:unknown):{x:number;y:number;width:number;height:number}|undefined {
  if (value === undefined) return undefined;
  const object = asObject(value);
  const x = requiredField(object,'x'); const y = requiredField(object,'y'); const width = requiredField(object,'width'); const height = requiredField(object,'height');
  const values = [x,y,width,height];
  if (values.some((entry)=>typeof entry !== 'number' || !Number.isFinite(entry) || Math.abs(entry) > 1_000_000) ||
      (width as number) < 0 || (height as number) < 0) throw new Error('native desktop rectangle malformed');
  return Object.freeze({x:x as number,y:y as number,width:width as number,height:height as number});
}
function windowValue(value:unknown):PlatformDesktopWindow {
  const object = asObject(value);
  const nativeId = requiredField(object,'nativeId');
  const instanceToken = requiredField(object,'instanceToken');
  const foreground = requiredField(object,'foreground');
  const focused = requiredField(object,'focused');
  const applicationId = field(object,'applicationId');
  const processId = field(object,'processId');
  const title = field(object,'title');
  const bounds = field(object,'bounds');
  if (!boundedString(nativeId,256) || !boundedString(instanceToken,512) || typeof foreground !== 'boolean' || typeof focused !== 'boolean') {
    throw new Error('native desktop window malformed');
  }
  if (applicationId.present && applicationId.value !== undefined && !boundedString(applicationId.value,256)) throw new Error('native application identity malformed');
  if (processId.present && processId.value !== undefined && !boundedString(processId.value,256)) throw new Error('native process identity malformed');
  if (title.present && title.value !== undefined && !boundedString(title.value,4_096,true)) throw new Error('native window title malformed');
  return Object.freeze({
    nativeId,instanceToken,
    ...(applicationId.present && applicationId.value !== undefined ? {applicationId:applicationId.value as string} : {}),
    ...(processId.present && processId.value !== undefined ? {processId:processId.value as string} : {}),
    ...(title.present && title.value !== undefined ? {title:title.value as string} : {}),
    ...(bounds.present && bounds.value !== undefined ? {bounds:finiteRect(bounds.value)!} : {}),
    foreground,focused,
  });
}
function windowsResult(value:unknown,limits:Required<ComputerObservationLimits>):{windows:readonly PlatformDesktopWindow[];truncated:boolean;focusedControlNativeId?:string} {
  const object = asObject(value);
  const windowsRaw = requiredField(object,'windows');
  const truncated = requiredField(object,'truncated');
  const focusedControlNativeId = field(object,'focusedControlNativeId');
  if (typeof truncated !== 'boolean') throw new Error('native desktop window response malformed');
  const rawWindows = capturedArray(windowsRaw,limits.maxItems);
  if (focusedControlNativeId.present && focusedControlNativeId.value !== undefined && !boundedString(focusedControlNativeId.value,256)) {
    throw new Error('native focused control identity malformed');
  }
  const windows:PlatformDesktopWindow[] = [];
  for (const rawWindow of rawWindows) windows.push(windowValue(rawWindow));
  return Object.freeze({windows:Object.freeze(windows),truncated,...(focusedControlNativeId.present && focusedControlNativeId.value !== undefined ? {focusedControlNativeId:focusedControlNativeId.value as string} : {})});
}
function controlTree(value:unknown,limits:Required<ComputerObservationLimits>):PlatformDesktopControl {
  let count = 0;
  let text = 0;
  const seen = new WeakSet<object>();
  const visit = (candidate:unknown,depth:number):PlatformDesktopControl => {
    if (depth > limits.maxDepth || count >= limits.maxItems) throw new Error('native accessibility response exceeded acquisition limits');
    const object = asObject(candidate);
    if (seen.has(object)) throw new Error('native accessibility cycle malformed');
    seen.add(object);
    const nativeId = requiredField(object,'nativeId');
    const instanceToken = requiredField(object,'instanceToken');
    if (!boundedString(nativeId,256) || !boundedString(instanceToken,512)) throw new Error('native accessibility identity malformed');
    const role = field(object,'role'); const name = field(object,'name'); const controlValue = field(object,'value');
    for (const [entry,max] of [[role,256],[name,4_096],[controlValue,4_096]] as const) {
      if (entry.present && entry.value !== undefined && !boundedString(entry.value,max,true)) throw new Error('native accessibility text malformed');
      if (typeof entry.value === 'string') text += textBytes(entry.value);
    }
    text += textBytes(nativeId) + textBytes(instanceToken);
    if (text > limits.maxTextBytes) throw new Error('native accessibility response exceeded text acquisition limit');
    const enabled = field(object,'enabled'); const focused = field(object,'focused'); const bounds = field(object,'bounds'); const childrenField = field(object,'children');
    if (enabled.present && enabled.value !== undefined && typeof enabled.value !== 'boolean') throw new Error('native accessibility enabled malformed');
    if (focused.present && focused.value !== undefined && typeof focused.value !== 'boolean') throw new Error('native accessibility focused malformed');
    count += 1;
    let children:readonly PlatformDesktopControl[]|undefined;
    if (childrenField.present && childrenField.value !== undefined) {
      const rawChildren = capturedArray(childrenField.value,limits.maxItems - count);
      if (depth >= limits.maxDepth && rawChildren.length > 0) throw new Error('native accessibility response exceeded acquisition limits');
      const copied:PlatformDesktopControl[] = [];
      for (const child of rawChildren) copied.push(visit(child,depth + 1));
      children = Object.freeze(copied);
    }
    return Object.freeze({
      nativeId,instanceToken,
      ...(role.present && role.value !== undefined ? {role:role.value as string} : {}),
      ...(name.present && name.value !== undefined ? {name:name.value as string} : {}),
      ...(controlValue.present && controlValue.value !== undefined ? {value:controlValue.value as string} : {}),
      ...(enabled.present && enabled.value !== undefined ? {enabled:enabled.value as boolean} : {}),
      ...(focused.present && focused.value !== undefined ? {focused:focused.value as boolean} : {}),
      ...(bounds.present && bounds.value !== undefined ? {bounds:finiteRect(bounds.value)!} : {}),
      ...(children !== undefined ? {children} : {}),
    });
  };
  return visit(value,0);
}
function accessibilityResult(value:unknown,limits:Required<ComputerObservationLimits>):PlatformDesktopAccessibilityObservation {
  const object = asObject(value);
  const status = requiredField(object,'status');
  const windowInstanceToken = requiredField(object,'windowInstanceToken');
  const root = field(object,'root'); const reason = field(object,'reason');
  if (status !== 'available' && status !== 'unavailable' && status !== 'unsupported') throw new Error('native accessibility status malformed');
  if (!boundedString(windowInstanceToken,512)) throw new Error('native accessibility window token malformed');
  if (reason.present && reason.value !== undefined && (!boundedString(reason.value,64) || !REASON_CODE.test(reason.value))) throw new Error('native accessibility reason malformed');
  if (status === 'available') {
    if (!root.present || root.value === undefined || (reason.present && reason.value !== undefined)) throw new Error('native accessibility availability malformed');
    return Object.freeze({status:'available',windowInstanceToken,root:controlTree(root.value,limits)});
  }
  if (root.present && root.value !== undefined) throw new Error('native accessibility unavailable response malformed');
  return Object.freeze({status,windowInstanceToken,...(reason.present && reason.value !== undefined ? {reason:reason.value as string} : {})});
}
function visualResult(value:unknown,limits:DesktopVisualAcquisitionLimits):PlatformDesktopVisualObservation {
  const object = asObject(value);
  const status = requiredField(object,'status'); const windowInstanceToken = requiredField(object,'windowInstanceToken');
  const width = field(object,'width'); const height = field(object,'height'); const artifactField = field(object,'artifact'); const reason = field(object,'reason');
  if (status !== 'available' && status !== 'unavailable' && status !== 'unsupported') throw new Error('native visual status malformed');
  if (!boundedString(windowInstanceToken,512)) throw new Error('native visual window token malformed');
  if (reason.present && reason.value !== undefined && (!boundedString(reason.value,64) || !REASON_CODE.test(reason.value))) throw new Error('native visual reason malformed');
  if (status !== 'available') {
    if ((width.present && width.value !== undefined) || (height.present && height.value !== undefined) || (artifactField.present && artifactField.value !== undefined)) throw new Error('native visual unavailable response malformed');
    return Object.freeze({status,windowInstanceToken,...(reason.present && reason.value !== undefined ? {reason:reason.value as string} : {})});
  }
  if ((reason.present && reason.value !== undefined) || !width.present || !height.present || !Number.isSafeInteger(width.value) || !Number.isSafeInteger(height.value) ||
      (width.value as number) <= 0 || (height.value as number) <= 0 || (width.value as number) * (height.value as number) > limits.maxPixels) {
    throw new Error('native visual dimensions exceeded acquisition limits');
  }
  if (!artifactField.present || artifactField.value === undefined) throw new Error('native visual artifact exceeded acquisition limits');
  const artifact = asObject(artifactField.value);
  const token = requiredField(artifact,'token'); const mediaType = field(artifact,'mediaType'); const byteLength = requiredField(artifact,'byteLength');
  if (!boundedString(token,256) || (mediaType.present && mediaType.value !== undefined && !boundedString(mediaType.value,128)) ||
      !Number.isSafeInteger(byteLength) || (byteLength as number) < 0 || (byteLength as number) > limits.maxBytes) {
    throw new Error('native visual artifact exceeded acquisition limits');
  }
  return Object.freeze({status:'available',windowInstanceToken,width:width.value as number,height:height.value as number,artifact:Object.freeze({token,...(mediaType.present && mediaType.value !== undefined ? {mediaType:mediaType.value as string} : {}),byteLength:byteLength as number})});
}
function dispatchResult(value:unknown):DesktopBackendActionResult {
  const object = asObject(value);
  const status = requiredField(object,'status'); const dispatched = requiredField(object,'dispatched'); const verified = field(object,'verified'); const evidenceField = field(object,'evidence');
  if (status !== 'completed' && status !== 'rejected' && status !== 'unsupported' && status !== 'failed') throw new Error('native dispatch status malformed');
  if (typeof dispatched !== 'boolean' || (verified.present && verified.value !== undefined && typeof verified.value !== 'boolean')) throw new Error('native dispatch result malformed');
  let evidence:readonly string[]|undefined;
  if (evidenceField.present && evidenceField.value !== undefined) {
    const rawEvidence = capturedArray(evidenceField.value,MAX_EVIDENCE_ITEMS);
    const copied:string[] = [];
    for (const entry of rawEvidence) {
      if (typeof entry !== 'string' || !REASON_CODE.test(entry)) throw new Error('native dispatch evidence malformed');
      copied.push(entry);
    }
    evidence = Object.freeze(copied);
  }
  return Object.freeze({status,dispatched,...(verified.present && verified.value !== undefined ? {verified:verified.value as boolean} : {}),...(evidence ? {evidence} : {})});
}

/**
 * Rigorously testable production bridge boundary. The native helper owns the
 * platform call and MUST enforce instance-token freshness inside the same native
 * critical section as input dispatch. Executor-owned results are captured only
 * through fixed authority-bearing fields and bounded array indices; unknown
 * fields are ignored rather than whole-object enumerated. Helper exceptions after
 * possible emission deliberately propagate so the neutral adapter reports
 * dispatch:unknown.
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

function helperOptions(command:NativeDesktopBridgeCommand) {
  return {supportsRelativePointer:command.supportsRelativePointer === true,maxResponseBytes:command.maxResponseBytes,timeoutMs:command.timeoutMs};
}
export function windowsUiAutomationBridge(command:NativeDesktopBridgeCommand,executor:DesktopBridgeExecutor=new JsonProcessDesktopBridgeExecutor(command)) {
  return new NativeJsonDesktopPlatformBridge('windows-uia','windows-uia',executor,helperOptions(command));
}
export function macOsAccessibilityBridge(command:NativeDesktopBridgeCommand,executor:DesktopBridgeExecutor=new JsonProcessDesktopBridgeExecutor(command)) {
  return new NativeJsonDesktopPlatformBridge('macos-accessibility','macos-accessibility',executor,helperOptions(command));
}
export function linuxAtSpiBridge(command:NativeDesktopBridgeCommand,executor:DesktopBridgeExecutor=new JsonProcessDesktopBridgeExecutor(command)) {
  return new NativeJsonDesktopPlatformBridge('linux-atspi','linux-atspi',executor,helperOptions(command));
}
