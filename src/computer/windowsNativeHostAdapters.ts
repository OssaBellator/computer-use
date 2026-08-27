import type { ComputerEffectClass } from './environmentAdapter.js';
import type { DesktopVisualAcquisitionLimits, DesktopBackendActionResult } from './desktopUiBackend.js';
import type { WindowsComApartmentContext } from './windowsComApartment.js';
import type { WindowsCredentialBroker, WindowsCredentialBrokerRequest, WindowsCredentialBrokerResult } from './windowsCredentialMediator.js';
import type { WindowsAuthenticationFactorBroker, WindowsAuthenticationFactorBrokerRequest, WindowsAuthenticationFactorBrokerResult } from './windowsAuthenticationFactorMediator.js';
import type { WindowsGraphicsCaptureNativeBridge, WindowsGraphicsCaptureNativeFrame } from './windowsGraphicsCaptureRuntime.js';
import { WindowsNativeHostProtocolClient } from './windowsNativeHostProtocol.js';
import type { WindowsNativeInputDispatchAuthority } from './windowsNativeInputGate.js';
import type { WindowsProcessTokenIntegrityReader } from './windowsProcessIntegrity.js';
import type { WindowsSendInputEvent, WindowsSendInputNativeBridge, WindowsSendInputNativeResult } from './windowsSendInputPlan.js';
import type { WindowsUiaCacheRequestPlan } from './windowsUiaCacheRequestPlan.js';
import {
  captureDesktopBackendActionResult,
  captureWindowsUiaCachedObservation,
  captureWindowsUiaControlRef,
  captureWindowsUiaRevalidation,
  captureWindowsUiaWindowRef,
  type WindowsProcessGeneration,
  type WindowsUiaCachedObservation,
  type WindowsUiaControlRef,
  type WindowsUiaRevalidation,
  type WindowsUiaSemanticAction,
  type WindowsUiaWindowRef,
} from './windowsUiaContract.js';
import type { WindowsUiaMtaNativeClient } from './windowsUiaMtaBridge.js';
import type { WindowsUiaNativeElementHandle } from './windowsUiaProviderRuntime.js';

const TOKEN_PATTERN=/^[a-z0-9][a-z0-9._:-]{0,191}$/i;
const MEDIA_PATTERN=/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/i;
const EVIDENCE_PATTERN=/^[a-z0-9][a-z0-9._:-]{0,191}$/i;
const MAX_DIMENSION=32_768;
const CREDENTIAL_ID_PATTERN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;

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
function boundedInt(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):value is number {
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
}
function boundedFinite(value:unknown,max=1_000_000):value is number {
  return typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=max;
}
function handle(value:unknown):WindowsUiaNativeElementHandle|undefined {
  const raw=captureOwnDataObject(value,['token']);
  return raw&&typeof raw.token==='string'&&TOKEN_PATTERN.test(raw.token)?Object.freeze({token:raw.token}):undefined;
}
function resolveWindowResult(value:unknown):Awaited<ReturnType<WindowsUiaMtaNativeClient['resolveWindow']>>|undefined {
  const raw=captureOwnDataObject(value,['status','root']);
  if(!raw||typeof raw.status!=='string') return undefined;
  if(raw.status==='current'){
    const root=handle(raw.root);
    return root?Object.freeze({status:'current',root}):undefined;
  }
  return raw.status==='missing'||raw.status==='stale'||raw.status==='inaccessible'?Object.freeze({status:raw.status}):undefined;
}
function resolveControlResult(value:unknown):Awaited<ReturnType<WindowsUiaMtaNativeClient['resolveControl']>>|undefined {
  const raw=captureOwnDataObject(value,['status','element']);
  if(!raw||typeof raw.status!=='string') return undefined;
  if(raw.status==='candidate'){
    const element=handle(raw.element);
    return element?Object.freeze({status:'candidate',element}):undefined;
  }
  return raw.status==='missing'||raw.status==='ambiguous'||raw.status==='inaccessible'?Object.freeze({status:raw.status}):undefined;
}
function captureArtifact(value:unknown):WindowsGraphicsCaptureNativeFrame['artifact']|undefined {
  const raw=captureOwnDataObject(value,['token','mediaType','byteLength']);
  if(!raw||typeof raw.token!=='string'||!TOKEN_PATTERN.test(raw.token)||!boundedInt(raw.byteLength)) return undefined;
  if(raw.mediaType!==undefined&&(typeof raw.mediaType!=='string'||!MEDIA_PATTERN.test(raw.mediaType))) return undefined;
  return Object.freeze({token:raw.token,...(raw.mediaType!==undefined?{mediaType:raw.mediaType as string}:{}),byteLength:raw.byteLength});
}
function captureGeometry(value:unknown):WindowsGraphicsCaptureNativeFrame['geometry']|undefined {
  const raw=captureOwnDataObject(value,['left','top','width','height','dpi']);
  if(!raw||!boundedFinite(raw.left)||!boundedFinite(raw.top)||!boundedInt(raw.width,1,MAX_DIMENSION)||!boundedInt(raw.height,1,MAX_DIMENSION)||
      typeof raw.dpi!=='number'||!Number.isFinite(raw.dpi)||raw.dpi<48||raw.dpi>960) return undefined;
  return Object.freeze({left:raw.left,top:raw.top,width:raw.width,height:raw.height,dpi:raw.dpi});
}
function captureNativeFrame(value:unknown):WindowsGraphicsCaptureNativeFrame|undefined {
  const raw=captureOwnDataObject(value,['window','captureGeneration','frameSequence','capturedAtMs','systemRelativeTime100ns','contentWidth','contentHeight','geometry','artifact']);
  if(!raw) return undefined;
  const window=captureWindowsUiaWindowRef(raw.window);
  const geometry=captureGeometry(raw.geometry);
  const artifact=captureArtifact(raw.artifact);
  if(!window||!geometry||!artifact||!boundedInt(raw.captureGeneration)||!boundedInt(raw.frameSequence)||!boundedInt(raw.capturedAtMs)||
      !boundedInt(raw.contentWidth,1,MAX_DIMENSION)||!boundedInt(raw.contentHeight,1,MAX_DIMENSION)) return undefined;
  if(raw.systemRelativeTime100ns!==undefined&&!boundedInt(raw.systemRelativeTime100ns)) return undefined;
  return Object.freeze({
    window,captureGeneration:raw.captureGeneration,frameSequence:raw.frameSequence,capturedAtMs:raw.capturedAtMs,
    ...(raw.systemRelativeTime100ns!==undefined?{systemRelativeTime100ns:raw.systemRelativeTime100ns as number}:{}),
    contentWidth:raw.contentWidth,contentHeight:raw.contentHeight,geometry,artifact,
  });
}
function rid(value:unknown):number {
  const raw=captureOwnDataObject(value,['rid']);
  if(!raw||!boundedInt(raw.rid,0,0xffff)) throw new Error('windows-native-host-integrity-response-invalid');
  return raw.rid;
}
function captureInputResult(value:unknown):WindowsSendInputNativeResult|undefined {
  const raw=captureOwnDataObject(value,['insertedEventCount','preDispatchFailure']);
  if(!raw||!boundedInt(raw.insertedEventCount,0,4_096))return undefined;
  if(raw.preDispatchFailure!==undefined&&(typeof raw.preDispatchFailure!=='string'||!EVIDENCE_PATTERN.test(raw.preDispatchFailure)))return undefined;
  if(raw.preDispatchFailure!==undefined&&raw.insertedEventCount!==0)return undefined;
  return Object.freeze({
    insertedEventCount:raw.insertedEventCount,
    ...(raw.preDispatchFailure!==undefined?{preDispatchFailure:raw.preDispatchFailure}:{}),
  });
}

/** UIA operations scoped to the same serialized MTA executor as their handles. */
export class WindowsNativeHostUiaClient implements WindowsUiaMtaNativeClient {
  constructor(readonly protocol:WindowsNativeHostProtocolClient) {}

  async resolveWindow(context:WindowsComApartmentContext,window:WindowsUiaWindowRef) {
    const result=resolveWindowResult(await this.protocol.call('uia.resolve-window',Object.freeze({threadToken:context.threadToken,window})));
    if(!result) throw new Error('windows-native-host-uia-resolve-window-invalid');
    return result;
  }
  async buildCache(context:WindowsComApartmentContext,root:WindowsUiaNativeElementHandle,plan:WindowsUiaCacheRequestPlan,invalidationEpoch:number):Promise<WindowsUiaCachedObservation> {
    const result=captureWindowsUiaCachedObservation(await this.protocol.call('uia.build-cache',Object.freeze({threadToken:context.threadToken,root,plan,invalidationEpoch})));
    if(!result) throw new Error('windows-native-host-uia-cache-invalid');
    return result;
  }
  async resolveControl(context:WindowsComApartmentContext,ref:WindowsUiaControlRef) {
    const result=resolveControlResult(await this.protocol.call('uia.resolve-control',Object.freeze({threadToken:context.threadToken,ref})));
    if(!result) throw new Error('windows-native-host-uia-resolve-control-invalid');
    return result;
  }
  async compareElements(context:WindowsComApartmentContext,a:WindowsUiaNativeElementHandle,b:WindowsUiaNativeElementHandle):Promise<boolean> {
    const raw=captureOwnDataObject(await this.protocol.call('uia.compare-elements',Object.freeze({threadToken:context.threadToken,a,b})),['same']);
    if(!raw||typeof raw.same!=='boolean') throw new Error('windows-native-host-uia-compare-invalid');
    return raw.same;
  }
  async snapshotControl(context:WindowsComApartmentContext,element:WindowsUiaNativeElementHandle,ref:WindowsUiaControlRef):Promise<WindowsUiaRevalidation> {
    const result=captureWindowsUiaRevalidation(await this.protocol.call('uia.snapshot-control',Object.freeze({threadToken:context.threadToken,element,ref})));
    if(!result) throw new Error('windows-native-host-uia-snapshot-invalid');
    return result;
  }
  async performPattern(context:WindowsComApartmentContext,element:WindowsUiaNativeElementHandle,ref:WindowsUiaControlRef,action:WindowsUiaSemanticAction,effect:ComputerEffectClass):Promise<DesktopBackendActionResult> {
    const result=captureDesktopBackendActionResult(await this.protocol.call('uia.perform-pattern',Object.freeze({threadToken:context.threadToken,element,ref,action,effect})));
    if(!result) throw new Error('windows-native-host-uia-pattern-result-invalid');
    return result;
  }
}

export class WindowsNativeHostCaptureBridge implements WindowsGraphicsCaptureNativeBridge {
  constructor(readonly protocol:WindowsNativeHostProtocolClient) {}
  async captureNextFrame(window:WindowsUiaWindowRef,limits:DesktopVisualAcquisitionLimits):Promise<WindowsGraphicsCaptureNativeFrame> {
    const result=captureNativeFrame(await this.protocol.call('capture.next-frame',Object.freeze({window,limits})));
    if(!result) throw new Error('windows-native-host-capture-response-invalid');
    return result;
  }
  async releaseArtifact(token:string):Promise<void> {
    if(!TOKEN_PATTERN.test(token)) throw new Error('windows-native-host-artifact-token-invalid');
    const raw=captureOwnDataObject(await this.protocol.call('artifact.release',Object.freeze({token})),['released']);
    if(!raw||raw.released!==true) throw new Error('windows-native-host-artifact-release-invalid');
  }
  async consumeArtifact(token:string,maxBytes:number):Promise<Readonly<{mediaType:string;bytes:Uint8Array}>> {
    if(!TOKEN_PATTERN.test(token)||!boundedInt(maxBytes,1,512*1024))throw new Error('windows-native-host-artifact-consume-invalid');
    const raw=captureOwnDataObject(await this.protocol.call('artifact.consume',Object.freeze({token,maxBytes})),['mediaType','byteLength','dataBase64']);
    if(!raw||raw.mediaType!=='image/png'||!boundedInt(raw.byteLength,0,maxBytes)||typeof raw.dataBase64!=='string'){
      throw new Error('windows-native-host-artifact-consume-response-invalid');
    }
    let bytes:Buffer;
    try{bytes=Buffer.from(raw.dataBase64,'base64');}catch{throw new Error('windows-native-host-artifact-consume-response-invalid');}
    const pngSignature=[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a] as const;
    if(bytes.byteLength!==raw.byteLength||bytes.toString('base64')!==raw.dataBase64||bytes.byteLength<pngSignature.length||
       pngSignature.some((value,index)=>bytes[index]!==value)){
      bytes.fill(0);
      throw new Error('windows-native-host-artifact-consume-response-invalid');
    }
    return Object.freeze({mediaType:raw.mediaType,bytes:new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength)});
  }
}

export class WindowsNativeHostCredentialBroker implements WindowsCredentialBroker {
  constructor(readonly protocol:WindowsNativeHostProtocolClient,readonly threadToken:string) {}
  async applyCredential(request:WindowsCredentialBrokerRequest):Promise<WindowsCredentialBrokerResult> {
    if(!CREDENTIAL_ID_PATTERN.test(this.threadToken)||!CREDENTIAL_ID_PATTERN.test(request.credentialRef)||!CREDENTIAL_ID_PATTERN.test(request.purpose)){
      throw new Error('windows-native-host-credential-request-invalid');
    }
    const target=captureWindowsUiaControlRef(request.target);
    if(!target)throw new Error('windows-native-host-credential-target-invalid');
    const response=await this.protocol.call('credential.apply',Object.freeze({
      threadToken:this.threadToken,credentialRef:request.credentialRef,ref:target,purpose:request.purpose,
    }));
    if(!response||typeof response!=='object'||Array.isArray(response)||Object.getOwnPropertyNames(response).some((key)=>key!=='status'&&key!=='evidence')){
      throw new Error('windows-native-host-credential-response-invalid');
    }
    const raw=captureOwnDataObject(response,['status','evidence']);
    if(!raw||typeof raw.status!=='string'||!['applied','rejected','unavailable','unknown'].includes(raw.status)){
      throw new Error('windows-native-host-credential-response-invalid');
    }
    let evidence:readonly string[]|undefined;
    if(raw.evidence!==undefined){
      if(!Array.isArray(raw.evidence)||raw.evidence.length>16||raw.evidence.some((item)=>typeof item!=='string'||!EVIDENCE_PATTERN.test(item))){
        throw new Error('windows-native-host-credential-response-invalid');
      }
      evidence=Object.freeze([...raw.evidence]);
    }
    return Object.freeze({status:raw.status as WindowsCredentialBrokerResult['status'],...(evidence?{evidence}:{})});
  }
}

export class WindowsNativeHostTotpFactorBroker implements WindowsAuthenticationFactorBroker {
  constructor(readonly protocol:WindowsNativeHostProtocolClient,readonly threadToken:string) {}
  async performFactor(request:WindowsAuthenticationFactorBrokerRequest):Promise<WindowsAuthenticationFactorBrokerResult> {
    if(request.kind!=='totp'||!request.target||!CREDENTIAL_ID_PATTERN.test(this.threadToken)||!CREDENTIAL_ID_PATTERN.test(request.factorRef)||
       (request.purpose!=='authenticate'&&request.purpose!=='reauthenticate'))throw new Error('windows-native-host-totp-request-invalid');
    const target=captureWindowsUiaControlRef(request.target);
    if(!target)throw new Error('windows-native-host-totp-target-invalid');
    const response=await this.protocol.call('factor.totp.apply',Object.freeze({threadToken:this.threadToken,factorRef:request.factorRef,ref:target,purpose:request.purpose}));
    if(!response||typeof response!=='object'||Array.isArray(response)||Object.getOwnPropertyNames(response).some(key=>key!=='status'&&key!=='evidence')){
      throw new Error('windows-native-host-totp-response-invalid');
    }
    const raw=captureOwnDataObject(response,['status','evidence']);
    if(!raw||typeof raw.status!=='string'||!['completed','rejected','unavailable','unknown'].includes(raw.status))throw new Error('windows-native-host-totp-response-invalid');
    let evidence:readonly string[]|undefined;
    if(raw.evidence!==undefined){
      if(!Array.isArray(raw.evidence)||raw.evidence.length>16||raw.evidence.some(item=>typeof item!=='string'||!EVIDENCE_PATTERN.test(item)||item.includes(request.factorRef))){
        throw new Error('windows-native-host-totp-response-invalid');
      }
      evidence=Object.freeze([...raw.evidence]);
    }
    return Object.freeze({status:raw.status as WindowsAuthenticationFactorBrokerResult['status'],...(evidence?{evidence}:{})});
  }
}

export class WindowsNativeHostIntegrityReader implements WindowsProcessTokenIntegrityReader {
  constructor(readonly protocol:WindowsNativeHostProtocolClient) {}
  async currentProcessIntegrityRid():Promise<number> {
    return rid(await this.protocol.call('integrity.current',Object.freeze({})));
  }
  async processIntegrityRid(process:WindowsProcessGeneration):Promise<number> {
    return rid(await this.protocol.call('integrity.process',Object.freeze({process})));
  }
}

export class WindowsNativeHostSendInputBridge implements WindowsSendInputNativeBridge {
  constructor(readonly protocol:WindowsNativeHostProtocolClient) {}
  async sendInput(events:readonly WindowsSendInputEvent[],authority:WindowsNativeInputDispatchAuthority):Promise<WindowsSendInputNativeResult> {
    if(!Array.isArray(events)||events.length<1||events.length>4_096) throw new Error('windows-native-host-input-events-invalid');
    const targetWindow=captureWindowsUiaWindowRef(authority.targetWindow);
    if(!targetWindow||!boundedInt(authority.humanInputSequence))throw new Error('windows-native-host-input-authority-invalid');
    const result=captureInputResult(await this.protocol.call('input.send',Object.freeze({
      events:Object.freeze([...events]),
      targetWindow,
      expectedHumanInputSequence:authority.humanInputSequence,
    })));
    if(!result)throw new Error('windows-native-host-input-response-invalid');
    return result;
  }
}
