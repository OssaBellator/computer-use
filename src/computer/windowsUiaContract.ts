import {
  COMPUTER_EFFECT_CLASSES,
  type ComputerActionResult,
  type ComputerEffectClass,
  type ComputerObservationLimits,
} from './environmentAdapter.js';
import type { DesktopBackendActionResult, DesktopRect } from './desktopUiBackend.js';

export const WINDOWS_UIA_PATTERNS = [
  'invoke','value','toggle','selection-item','expand-collapse','scroll','range-value','window',
] as const;
export type WindowsUiaPattern = typeof WINDOWS_UIA_PATTERNS[number];
export type WindowsUiaScrollAmount = 'large-decrement'|'small-decrement'|'no-amount'|'large-increment'|'small-increment';
export type WindowsUiaWindowOperation = 'minimize'|'maximize'|'restore'|'close';

export interface WindowsProcessGeneration {
  /** OS PID is not durable by itself; startIdentity prevents PID-reuse confusion. */
  readonly processId:number;
  readonly startIdentity:string;
}
export interface WindowsUiaWindowRef {
  /** Opaque HWND representation; callers must not parse or synthesize it. */
  readonly hwnd:string;
  readonly desktopSessionId:string;
  readonly process:WindowsProcessGeneration;
  readonly generation:number;
}
export interface WindowsUiaControlRef {
  readonly window:WindowsUiaWindowRef;
  /** Opaque UIA RuntimeId comparison material. It may be reused over time. */
  readonly runtimeId:readonly number[];
  /** Locator hint only; not global or release-stable identity. */
  readonly automationId?:string;
  readonly controlType:string;
  readonly structuralPathHash?:string;
  readonly generation:number;
}
export interface WindowsUiaControlSnapshot {
  readonly ref:WindowsUiaControlRef;
  readonly name?:string;
  readonly value?:string;
  readonly enabled?:boolean;
  /** True means secret text must never be serialized in `value`. */
  readonly isPassword?:boolean;
  readonly offscreen?:boolean;
  readonly bounds?:DesktopRect;
  readonly patterns:readonly WindowsUiaPattern[];
  readonly toggleState?:'off'|'on'|'indeterminate';
  readonly selected?:boolean;
  readonly expandCollapseState?:'collapsed'|'expanded'|'partially-expanded'|'leaf-node';
  readonly rangeValue?:number;
  readonly windowVisualState?:'normal'|'minimized'|'maximized';
  /** Bounded Control View children. Omitted is normalized as an empty child set. */
  readonly children?:readonly WindowsUiaControlSnapshot[];
}
export interface WindowsUiaCachedObservation {
  readonly window:WindowsUiaWindowRef;
  readonly root?:WindowsUiaControlSnapshot;
  /** Exact number of nodes represented by `root`, including the root itself. */
  readonly itemCount:number;
  /** Exact UTF-8 byte count of represented node name/value strings. */
  readonly textBytes:number;
  readonly truncated:boolean;
  readonly invalidationEpoch:number;
  readonly capturedAtMs:number;
}
export type WindowsUiaSemanticAction =
  | {readonly kind:'invoke'}
  | {readonly kind:'set-value';readonly value:string}
  | {readonly kind:'toggle'}
  | {readonly kind:'select'}
  | {readonly kind:'expand-collapse';readonly state:'expanded'|'collapsed'}
  | {readonly kind:'scroll';readonly horizontal:WindowsUiaScrollAmount;readonly vertical:WindowsUiaScrollAmount}
  | {readonly kind:'set-range-value';readonly value:number}
  | {readonly kind:'window';readonly operation:WindowsUiaWindowOperation};
export type WindowsUiaRevalidation =
  | {readonly status:'current';readonly control:WindowsUiaControlSnapshot}
  | {readonly status:'stale'|'missing'|'ambiguous'|'inaccessible';readonly evidence?:readonly string[]};

export interface WindowsUiaProvider {
  observeCached(window:WindowsUiaWindowRef,limits:Required<ComputerObservationLimits>):Promise<WindowsUiaCachedObservation>;
  revalidateControl(ref:WindowsUiaControlRef):Promise<WindowsUiaRevalidation>;
  /** Exactly one semantic UIA pattern action. No SendInput/coordinate fallback. */
  performSemanticAction(ref:WindowsUiaControlRef,action:WindowsUiaSemanticAction,effect:ComputerEffectClass):Promise<DesktopBackendActionResult>;
}

const MAX_TEXT_BYTES=1_000_000;
const MAX_ITEMS=10_000;
const MAX_DEPTH=128;
const MAX_RUNTIME_ID_PARTS=64;
const MAX_ID_BYTES=256;
const MAX_VALUE_BYTES=16_384;
const MAX_EVIDENCE=16;
const MAX_EVIDENCE_BYTES=128;
const MAX_RECT_MAGNITUDE=1_000_000;
const TOKEN_PATTERN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const EXPAND_STATES=new Set(['expanded','collapsed']);
const SCROLL_AMOUNTS=new Set<WindowsUiaScrollAmount>(['large-decrement','small-decrement','no-amount','large-increment','small-increment']);
const WINDOW_OPERATIONS=new Set<WindowsUiaWindowOperation>(['minimize','maximize','restore','close']);
const REVALIDATION_STATUSES=new Set(['current','stale','missing','ambiguous','inaccessible']);
const TOGGLE_STATES=new Set(['off','on','indeterminate']);
const EXPAND_COLLAPSE_STATES=new Set(['collapsed','expanded','partially-expanded','leaf-node']);
const WINDOW_VISUAL_STATES=new Set(['normal','minimized','maximized']);

function utf8Bytes(value:string):number { return new TextEncoder().encode(value).byteLength; }
function boundedString(value:unknown,maxBytes=MAX_ID_BYTES,allowEmpty=false):value is string {
  return typeof value==='string' && (allowEmpty||value.length>0) && !value.includes('\0') && utf8Bytes(value)<=maxBytes;
}
function validGeneration(value:unknown):value is number { return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0; }
function boundedFinite(value:unknown,maxMagnitude=MAX_RECT_MAGNITUDE):value is number {
  return typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=maxMagnitude;
}
function validNonNegativeInteger(value:unknown,max=Number.MAX_SAFE_INTEGER):value is number {
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=max;
}

function captureOwnDataObject(value:unknown,allowed:readonly string[]):Readonly<Record<string,unknown>>|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value)) return undefined;
  try {
    const prototype=Object.getPrototypeOf(value);
    if(prototype!==Object.prototype&&prototype!==null) return undefined;
    const captured:Record<string,unknown>=Object.create(null);
    for(const key of allowed){
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(descriptor===undefined) continue;
      if(!('value' in descriptor)||descriptor.get!==undefined||descriptor.set!==undefined||!descriptor.enumerable) return undefined;
      captured[key]=descriptor.value;
    }
    return Object.freeze(captured);
  } catch { return undefined; }
}
function capturePlainArray(value:unknown,maxLength:number):readonly unknown[]|undefined {
  if(!Array.isArray(value)) return undefined;
  try {
    if(Object.getPrototypeOf(value)!==Array.prototype) return undefined;
    const length=Object.getOwnPropertyDescriptor(value,'length');
    if(!length||!('value' in length)||!Number.isSafeInteger(length.value)||length.value<0||length.value>maxLength) return undefined;
    const captured:unknown[]=[];
    for(let index=0;index<length.value;index+=1){
      const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
      if(!descriptor||!('value' in descriptor)||descriptor.get!==undefined||descriptor.set!==undefined||!descriptor.enumerable) return undefined;
      captured.push(descriptor.value);
    }
    return Object.freeze(captured);
  } catch { return undefined; }
}
function captureEvidence(value:unknown):readonly string[]|undefined {
  if(value===undefined) return undefined;
  const raw=capturePlainArray(value,MAX_EVIDENCE);
  if(!raw||raw.some((entry)=>!boundedString(entry,MAX_EVIDENCE_BYTES))) return undefined;
  return Object.freeze(raw as readonly string[]);
}
function captureProcess(value:unknown):WindowsProcessGeneration|undefined {
  const raw=captureOwnDataObject(value,['processId','startIdentity']);
  if(!raw||!Number.isSafeInteger(raw.processId)||(raw.processId as number)<=0||!boundedString(raw.startIdentity)) return undefined;
  return Object.freeze({processId:raw.processId as number,startIdentity:raw.startIdentity});
}

export function captureWindowsUiaWindowRef(value:unknown):WindowsUiaWindowRef|undefined {
  const raw=captureOwnDataObject(value,['hwnd','desktopSessionId','process','generation']);
  if(!raw||!boundedString(raw.hwnd)||!boundedString(raw.desktopSessionId)||!validGeneration(raw.generation)) return undefined;
  const process=captureProcess(raw.process);
  if(!process) return undefined;
  return Object.freeze({hwnd:raw.hwnd,desktopSessionId:raw.desktopSessionId,process,generation:raw.generation});
}
export function captureWindowsUiaControlRef(value:unknown):WindowsUiaControlRef|undefined {
  const raw=captureOwnDataObject(value,['window','runtimeId','automationId','controlType','structuralPathHash','generation']);
  if(!raw||!boundedString(raw.controlType)||!validGeneration(raw.generation)) return undefined;
  const window=captureWindowsUiaWindowRef(raw.window);
  const runtimeIdRaw=capturePlainArray(raw.runtimeId,MAX_RUNTIME_ID_PARTS);
  if(!window||!runtimeIdRaw||runtimeIdRaw.length===0||runtimeIdRaw.some((part)=>!Number.isSafeInteger(part))) return undefined;
  if(raw.automationId!==undefined&&!boundedString(raw.automationId)) return undefined;
  if(raw.structuralPathHash!==undefined&&(typeof raw.structuralPathHash!=='string'||!TOKEN_PATTERN.test(raw.structuralPathHash))) return undefined;
  return Object.freeze({
    window,runtimeId:Object.freeze(runtimeIdRaw as readonly number[]),
    ...(raw.automationId!==undefined?{automationId:raw.automationId as string}:{}),
    controlType:raw.controlType,
    ...(raw.structuralPathHash!==undefined?{structuralPathHash:raw.structuralPathHash as string}:{}),
    generation:raw.generation,
  });
}
export function captureWindowsUiaSemanticAction(value:unknown):WindowsUiaSemanticAction|undefined {
  const raw=captureOwnDataObject(value,['kind','value','state','horizontal','vertical','operation']);
  if(!raw||typeof raw.kind!=='string') return undefined;
  switch(raw.kind){
    case'invoke':return Object.freeze({kind:'invoke'});
    case'toggle':return Object.freeze({kind:'toggle'});
    case'select':return Object.freeze({kind:'select'});
    case'set-value':return boundedString(raw.value,MAX_VALUE_BYTES)?Object.freeze({kind:'set-value',value:raw.value}):undefined;
    case'set-range-value':return typeof raw.value==='number'&&Number.isFinite(raw.value)?Object.freeze({kind:'set-range-value',value:raw.value}):undefined;
    case'expand-collapse':return typeof raw.state==='string'&&EXPAND_STATES.has(raw.state)?Object.freeze({kind:'expand-collapse',state:raw.state as 'expanded'|'collapsed'}):undefined;
    case'scroll':return typeof raw.horizontal==='string'&&SCROLL_AMOUNTS.has(raw.horizontal as WindowsUiaScrollAmount)&&typeof raw.vertical==='string'&&SCROLL_AMOUNTS.has(raw.vertical as WindowsUiaScrollAmount)
      ?Object.freeze({kind:'scroll',horizontal:raw.horizontal as WindowsUiaScrollAmount,vertical:raw.vertical as WindowsUiaScrollAmount}):undefined;
    case'window':return typeof raw.operation==='string'&&WINDOW_OPERATIONS.has(raw.operation as WindowsUiaWindowOperation)
      ?Object.freeze({kind:'window',operation:raw.operation as WindowsUiaWindowOperation}):undefined;
    default:return undefined;
  }
}
function captureBounds(value:unknown):DesktopRect|undefined {
  if(value===undefined) return undefined;
  const raw=captureOwnDataObject(value,['x','y','width','height']);
  if(!raw||!boundedFinite(raw.x)||!boundedFinite(raw.y)||!boundedFinite(raw.width)||!boundedFinite(raw.height)||raw.width<0||raw.height<0) return undefined;
  return Object.freeze({x:raw.x,y:raw.y,width:raw.width,height:raw.height});
}

interface TreeCaptureState {
  items:number;
  textBytes:number;
  readonly maxItems:number;
  readonly maxTextBytes:number;
  readonly maxDepth:number;
  readonly seen:WeakSet<object>;
}

function captureControlSnapshotTree(
  value:unknown,
  depth:number,
  state:TreeCaptureState,
  expectedWindow?:WindowsUiaWindowRef,
):WindowsUiaControlSnapshot|undefined {
  if(depth>state.maxDepth||state.items>=state.maxItems||!value||typeof value!=='object') return undefined;
  if(state.seen.has(value)) return undefined;
  state.seen.add(value);

  const raw=captureOwnDataObject(value,['ref','name','value','enabled','isPassword','offscreen','bounds','patterns','toggleState','selected','expandCollapseState','rangeValue','windowVisualState','children']);
  if(!raw) return undefined;
  const ref=captureWindowsUiaControlRef(raw.ref);
  const patternsRaw=capturePlainArray(raw.patterns,WINDOWS_UIA_PATTERNS.length);
  if(!ref||expectedWindow!==undefined&&!sameWindowsUiaWindow(ref.window,expectedWindow)||
      !patternsRaw||patternsRaw.some((pattern)=>typeof pattern!=='string'||!WINDOWS_UIA_PATTERNS.includes(pattern as WindowsUiaPattern))) return undefined;
  if(new Set(patternsRaw).size!==patternsRaw.length) return undefined;
  if(raw.name!==undefined&&!boundedString(raw.name,MAX_VALUE_BYTES,true)) return undefined;
  if(raw.value!==undefined&&!boundedString(raw.value,MAX_VALUE_BYTES,true)) return undefined;
  if(raw.enabled!==undefined&&typeof raw.enabled!=='boolean') return undefined;
  if(raw.isPassword!==undefined&&typeof raw.isPassword!=='boolean') return undefined;
  if(raw.isPassword===true&&raw.value!==undefined) return undefined;
  if(raw.offscreen!==undefined&&typeof raw.offscreen!=='boolean') return undefined;
  if(raw.toggleState!==undefined&&(typeof raw.toggleState!=='string'||!TOGGLE_STATES.has(raw.toggleState))) return undefined;
  if(raw.selected!==undefined&&typeof raw.selected!=='boolean') return undefined;
  if(raw.expandCollapseState!==undefined&&(typeof raw.expandCollapseState!=='string'||!EXPAND_COLLAPSE_STATES.has(raw.expandCollapseState))) return undefined;
  if(raw.rangeValue!==undefined&&!(typeof raw.rangeValue==='number'&&Number.isFinite(raw.rangeValue))) return undefined;
  if(raw.windowVisualState!==undefined&&(typeof raw.windowVisualState!=='string'||!WINDOW_VISUAL_STATES.has(raw.windowVisualState))) return undefined;
  const bounds=captureBounds(raw.bounds);
  if(raw.bounds!==undefined&&!bounds) return undefined;

  state.items+=1;
  state.textBytes+=(typeof raw.name==='string'?utf8Bytes(raw.name):0)+(typeof raw.value==='string'?utf8Bytes(raw.value):0);
  if(state.items>state.maxItems||state.textBytes>state.maxTextBytes) return undefined;

  let children:readonly WindowsUiaControlSnapshot[]|undefined;
  if(raw.children!==undefined){
    const childValues=capturePlainArray(raw.children,state.maxItems-state.items);
    if(!childValues) return undefined;
    const captured:WindowsUiaControlSnapshot[]=[];
    for(const child of childValues){
      const node=captureControlSnapshotTree(child,depth+1,state,expectedWindow??ref.window);
      if(!node) return undefined;
      captured.push(node);
    }
    children=Object.freeze(captured);
  }

  return Object.freeze({
    ref,
    ...(raw.name!==undefined?{name:raw.name as string}:{}),
    ...(raw.value!==undefined?{value:raw.value as string}:{}),
    ...(raw.enabled!==undefined?{enabled:raw.enabled as boolean}:{}),
    ...(raw.isPassword!==undefined?{isPassword:raw.isPassword as boolean}:{}),
    ...(raw.offscreen!==undefined?{offscreen:raw.offscreen as boolean}:{}),
    ...(bounds?{bounds}:{}),
    patterns:Object.freeze(patternsRaw as readonly WindowsUiaPattern[]),
    ...(raw.toggleState!==undefined?{toggleState:raw.toggleState as WindowsUiaControlSnapshot['toggleState']}:{}),
    ...(raw.selected!==undefined?{selected:raw.selected as boolean}:{}),
    ...(raw.expandCollapseState!==undefined?{expandCollapseState:raw.expandCollapseState as WindowsUiaControlSnapshot['expandCollapseState']}:{}),
    ...(raw.rangeValue!==undefined?{rangeValue:raw.rangeValue as number}:{}),
    ...(raw.windowVisualState!==undefined?{windowVisualState:raw.windowVisualState as WindowsUiaControlSnapshot['windowVisualState']}:{}),
    ...(children!==undefined?{children}:{}),
  });
}

export function captureWindowsUiaControlSnapshot(value:unknown):WindowsUiaControlSnapshot|undefined {
  return captureControlSnapshotTree(value,0,{
    items:0,textBytes:0,maxItems:MAX_ITEMS,maxTextBytes:MAX_TEXT_BYTES,maxDepth:MAX_DEPTH,seen:new WeakSet<object>(),
  });
}
export function captureWindowsUiaRevalidation(value:unknown):WindowsUiaRevalidation|undefined {
  const raw=captureOwnDataObject(value,['status','control','evidence']);
  if(!raw||typeof raw.status!=='string'||!REVALIDATION_STATUSES.has(raw.status)) return undefined;
  if(raw.status==='current'){
    const control=captureWindowsUiaControlSnapshot(raw.control);
    return control?Object.freeze({status:'current',control}):undefined;
  }
  const evidence=captureEvidence(raw.evidence);
  if(raw.evidence!==undefined&&evidence===undefined) return undefined;
  return Object.freeze({status:raw.status as 'stale'|'missing'|'ambiguous'|'inaccessible',...(evidence?{evidence}:{})});
}
export function captureWindowsUiaCachedObservation(
  value:unknown,
  expectedWindow?:WindowsUiaWindowRef,
  expectedLimits?:Required<ComputerObservationLimits>,
):WindowsUiaCachedObservation|undefined {
  const raw=captureOwnDataObject(value,['window','root','itemCount','textBytes','truncated','invalidationEpoch','capturedAtMs']);
  if(!raw) return undefined;
  const window=captureWindowsUiaWindowRef(raw.window);
  if(!window||expectedWindow!==undefined&&!sameWindowsUiaWindow(window,expectedWindow)) return undefined;
  if(!validNonNegativeInteger(raw.itemCount,MAX_ITEMS)||!validNonNegativeInteger(raw.textBytes,MAX_TEXT_BYTES)||
      typeof raw.truncated!=='boolean'||!validNonNegativeInteger(raw.invalidationEpoch)||!validNonNegativeInteger(raw.capturedAtMs)) return undefined;
  const maxItems=expectedLimits?.maxItems??MAX_ITEMS;
  const maxTextBytes=expectedLimits?.maxTextBytes??MAX_TEXT_BYTES;
  const maxDepth=expectedLimits?.maxDepth??MAX_DEPTH;
  if(raw.itemCount>maxItems||raw.textBytes>maxTextBytes) return undefined;

  const state:TreeCaptureState={items:0,textBytes:0,maxItems,maxTextBytes,maxDepth,seen:new WeakSet<object>()};
  const root=raw.root===undefined?undefined:captureControlSnapshotTree(raw.root,0,state,window);
  if(raw.root!==undefined&&!root) return undefined;
  if(raw.itemCount!==state.items||raw.textBytes!==state.textBytes) return undefined;

  return Object.freeze({
    window,...(root?{root}:{}),itemCount:raw.itemCount,textBytes:raw.textBytes,truncated:raw.truncated,
    invalidationEpoch:raw.invalidationEpoch,capturedAtMs:raw.capturedAtMs,
  });
}
export function captureDesktopBackendActionResult(value:unknown):DesktopBackendActionResult|undefined {
  const raw=captureOwnDataObject(value,['status','dispatched','verified','evidence']);
  if(!raw||typeof raw.status!=='string'||!['completed','rejected','unsupported','failed'].includes(raw.status)||typeof raw.dispatched!=='boolean') return undefined;
  if(raw.verified!==undefined&&typeof raw.verified!=='boolean') return undefined;
  if(raw.dispatched===false&&raw.verified===true) return undefined;
  const evidence=captureEvidence(raw.evidence);
  if(raw.evidence!==undefined&&evidence===undefined) return undefined;
  return Object.freeze({
    status:raw.status as DesktopBackendActionResult['status'],dispatched:raw.dispatched,
    ...(raw.verified!==undefined?{verified:raw.verified as boolean}:{}),...(evidence?{evidence}:{}),
  });
}

export function validateWindowsUiaWindowRef(ref:WindowsUiaWindowRef):boolean { return captureWindowsUiaWindowRef(ref)!==undefined; }
export function validateWindowsUiaControlRef(ref:WindowsUiaControlRef):boolean { return captureWindowsUiaControlRef(ref)!==undefined; }
export function sameWindowsUiaWindow(a:WindowsUiaWindowRef,b:WindowsUiaWindowRef):boolean {
  return a.hwnd===b.hwnd&&a.desktopSessionId===b.desktopSessionId&&a.process.processId===b.process.processId&&a.process.startIdentity===b.process.startIdentity&&a.generation===b.generation;
}
export function sameWindowsUiaControl(a:WindowsUiaControlRef,b:WindowsUiaControlRef):boolean {
  return sameWindowsUiaWindow(a.window,b.window)&&a.generation===b.generation&&a.controlType===b.controlType&&a.runtimeId.length===b.runtimeId.length&&a.runtimeId.every((part,index)=>part===b.runtimeId[index]);
}
export function requiredWindowsUiaPattern(action:WindowsUiaSemanticAction):WindowsUiaPattern {
  switch(action.kind){case'invoke':return'invoke';case'set-value':return'value';case'toggle':return'toggle';case'select':return'selection-item';case'expand-collapse':return'expand-collapse';case'scroll':return'scroll';case'set-range-value':return'range-value';case'window':return'window';}
}
export function validateWindowsUiaSemanticAction(action:WindowsUiaSemanticAction):boolean { return captureWindowsUiaSemanticAction(action)!==undefined; }

function captureLimits(input?:ComputerObservationLimits):Required<ComputerObservationLimits>|undefined {
  if(input===undefined) return Object.freeze({maxItems:256,maxTextBytes:16_384,maxDepth:16});
  const raw=captureOwnDataObject(input,['maxItems','maxTextBytes','maxDepth']);
  if(!raw) return undefined;
  const item=raw.maxItems??256,text=raw.maxTextBytes??16_384,depth=raw.maxDepth??16;
  if(!Number.isSafeInteger(item)||(item as number)<1||!Number.isSafeInteger(text)||(text as number)<1||!Number.isSafeInteger(depth)||(depth as number)<1) return undefined;
  return Object.freeze({maxItems:Math.min(MAX_ITEMS,item as number),maxTextBytes:Math.min(MAX_TEXT_BYTES,text as number),maxDepth:Math.min(MAX_DEPTH,depth as number)});
}
function mapBackendResult(result:DesktopBackendActionResult):ComputerActionResult {
  if(result.dispatched)return{
    status:result.status==='completed'?'completed':result.status==='rejected'?'rejected':result.status==='unsupported'?'unsupported':'failed',
    dispatch:'dispatched-once',verification:result.verified===true?'verified':result.verified===false?'mismatch':'unverified',
    ...(result.evidence?{evidence:Object.freeze([...result.evidence])}:{}),
  };
  return{status:result.status==='completed'?'failed':result.status,dispatch:'not-dispatched',verification:'unverified',...(result.evidence?{evidence:Object.freeze([...result.evidence])}:{})};
}

export class WindowsUiaSemanticRuntime {
  constructor(readonly provider:WindowsUiaProvider){}
  async observe(window:WindowsUiaWindowRef,inputLimits?:ComputerObservationLimits):Promise<WindowsUiaCachedObservation>{
    const authority=captureWindowsUiaWindowRef(window);
    const limits=captureLimits(inputLimits);
    if(!authority) throw new Error('invalid-windows-uia-window-ref');
    if(!limits) throw new Error('invalid-windows-uia-observation-limits');
    const raw=await this.provider.observeCached(authority,limits);
    const captured=captureWindowsUiaCachedObservation(raw,authority,limits);
    if(!captured) throw new Error('windows-uia-observation-invalid');
    return captured;
  }
  async act(ref:WindowsUiaControlRef,action:WindowsUiaSemanticAction,effect:ComputerEffectClass):Promise<ComputerActionResult>{
    const authorityRef=captureWindowsUiaControlRef(ref);
    const authorityAction=captureWindowsUiaSemanticAction(action);
    if(!authorityRef||!authorityAction||!COMPUTER_EFFECT_CLASSES.includes(effect)) return{status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['windows-uia-request-invalid']};
    if(effect==='observe-only') return{status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['windows-uia-effect-invalid']};
    let currentRaw:WindowsUiaRevalidation;
    try{currentRaw=await this.provider.revalidateControl(authorityRef);}catch{return{status:'failed',dispatch:'not-dispatched',verification:'unverified',evidence:['windows-uia-revalidation-failed']};}
    const current=captureWindowsUiaRevalidation(currentRaw);
    if(!current)return{status:'failed',dispatch:'not-dispatched',verification:'unverified',evidence:['windows-uia-revalidation-invalid']};
    if(current.status!=='current')return{
      status:current.status==='inaccessible'?'unsupported':'rejected',dispatch:'not-dispatched',verification:'unverified',
      evidence:Object.freeze([`windows-uia-${current.status}`,...(current.evidence??[])]),
    };
    if(!sameWindowsUiaControl(authorityRef,current.control.ref))return{status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['windows-uia-control-replaced']};
    if(current.control.enabled===false)return{status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['windows-uia-control-disabled']};
    if(!current.control.patterns.includes(requiredWindowsUiaPattern(authorityAction)))return{status:'unsupported',dispatch:'not-dispatched',verification:'unverified',evidence:['windows-uia-pattern-unsupported']};
    try{
      const rawResult=await this.provider.performSemanticAction(authorityRef,authorityAction,effect);
      const capturedResult=captureDesktopBackendActionResult(rawResult);
      if(!capturedResult)return{status:'unknown',dispatch:'unknown',verification:'unverified',evidence:['windows-uia-dispatch-result-invalid']};
      return mapBackendResult(capturedResult);
    }catch{return{status:'unknown',dispatch:'unknown',verification:'unverified',evidence:['windows-uia-dispatch-uncertain']};}
  }
}
