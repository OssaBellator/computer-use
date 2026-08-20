import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEnvironmentAdapter,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
  ComputerSurfaceRef,
} from './environmentAdapter.js';

export const REMOTE_PROTOCOL_KINDS = ['ssh', 'rdp', 'vnc'] as const;
export type RemoteProtocolKind = typeof REMOTE_PROTOCOL_KINDS[number];
export type RemoteConnectionLifecycle = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface RemoteEndpointIdentity { endpointId: string; protocol: RemoteProtocolKind; host: string; port: number; }
export interface RemoteSecretHandle { readonly kind: 'secret-handle'; readonly handleId: string; }
export interface RemoteSessionConnection { sessionId: string; remoteHostId: string; capabilities: readonly string[]; }
export interface RemoteSessionAuthority { endpointId: string; remoteHostId: string; sessionId: string; generation: number; }
export interface RemoteMetadataItem { key: string; value: string; }
export interface RemoteDisplayFrame { width: number; height: number; format: 'synthetic-rgba' | 'synthetic-png'; bytes?: Uint8Array; frameId?: string; }
export interface RemoteVisualInput { kind: 'pointer' | 'key' | 'text'; x?: number; y?: number; key?: string; text?: string; }
/** argv-style invocation: command/args are distinct strings; no shell parsing is implied. */
export interface RemoteCommandInvocation { command: string; args?: readonly string[]; }
export interface RemoteCommandResult { exitCode: number | null; stdout?: string; stderr?: string; stdoutTruncated?: boolean; stderrTruncated?: boolean; }

export class RemoteDispatchError extends Error {
  constructor(readonly dispatch: 'not-dispatched' | 'unknown', readonly evidence: string) { super(evidence); this.name = 'RemoteDispatchError'; }
}
export type RemoteDispatchOutcome<T> =
  | { dispatch: 'not-dispatched'; status: 'failed'; evidence: string }
  | { dispatch: 'dispatched-once'; status: 'completed'; value?: T; evidence?: string }
  | { dispatch: 'unknown'; status: 'unknown'; evidence: string };

export interface RemoteSessionBackend {
  readonly protocol: RemoteProtocolKind;
  connect(endpoint: RemoteEndpointIdentity, credential?: RemoteSecretHandle): Promise<RemoteSessionConnection>;
  disconnect(connection: RemoteSessionConnection): Promise<void>;
  observeMetadata(connection: RemoteSessionConnection, limits: { maxItems: number; maxTextBytes: number }): Promise<readonly RemoteMetadataItem[]>;
  captureDisplay?(connection: RemoteSessionConnection): Promise<RemoteDisplayFrame>;
  sendVisualInput?(connection: RemoteSessionConnection, input: RemoteVisualInput): Promise<RemoteDispatchOutcome<void>>;
  executeRemoteCommand?(connection: RemoteSessionConnection, invocation: RemoteCommandInvocation): Promise<RemoteDispatchOutcome<RemoteCommandResult>>;
}

const MAX_CAPABILITIES = 64, MAX_METADATA_ITEMS = 64, MAX_METADATA_TEXT_BYTES = 16_384;
const MAX_ID_BYTES = 256, MAX_HOST_BYTES = 512, MAX_DISPLAY_DIMENSION = 16_384, MAX_DISPLAY_PIXELS = 4_194_304, MAX_DISPLAY_BYTES = 16_777_216;
const MAX_COMMAND_BYTES = 4_096, MAX_COMMAND_ARGS = 128, MAX_COMMAND_ARG_BYTES = 4_096, MAX_COMMAND_TOTAL_BYTES = 65_536, MAX_COMMAND_OUTPUT_BYTES = 65_536;
const MAX_VISUAL_COORDINATE = 1_000_000, MAX_VISUAL_KEY_BYTES = 128, MAX_VISUAL_TEXT_BYTES = 4_096;
const MACHINE_EVIDENCE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const REMOTE_CAPABILITY_PATTERN = /^remote\.(session\.observe|metadata\.observe|display\.observe|visual\.input|ssh\.execute)$/;

function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function bounded(value: string, max = MAX_ID_BYTES): boolean { return value.length > 0 && utf8Bytes(value) <= max && !/[\r\n\0]/.test(value); }
function clampLimit(value: number | undefined, fallback: number, max: number): number { return value === undefined || !Number.isSafeInteger(value) || value < 1 ? fallback : Math.min(value, max); }
function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) if (!('value' in descriptor)) return undefined;
  return value as Record<string, unknown>;
}
function ownData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function exactOwnKeys(record: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  const keys = Reflect.ownKeys(record);
  return keys.every((key) => typeof key === 'string' && allowed.includes(key)) && required.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}
function snapshotEndpoint(value: unknown): Readonly<RemoteEndpointIdentity> | undefined {
  const record = plainRecord(value);
  if (!record || !exactOwnKeys(record, ['endpointId','protocol','host','port'], ['endpointId','protocol','host','port'])) return undefined;
  const endpointId = ownData(record,'endpointId'), protocol = ownData(record,'protocol'), host = ownData(record,'host'), port = ownData(record,'port');
  if (typeof endpointId !== 'string' || typeof protocol !== 'string' || typeof host !== 'string' || typeof port !== 'number' ||
      !bounded(endpointId) || !REMOTE_PROTOCOL_KINDS.includes(protocol as RemoteProtocolKind) || !bounded(host,MAX_HOST_BYTES) ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;
  return Object.freeze({ endpointId, protocol: protocol as RemoteProtocolKind, host, port });
}
function snapshotSecretHandle(value: unknown): Readonly<RemoteSecretHandle> | undefined {
  const record = plainRecord(value);
  if (!record || !exactOwnKeys(record, ['kind','handleId'], ['kind','handleId'])) return undefined;
  const kind = ownData(record,'kind'), handleId = ownData(record,'handleId');
  if (kind !== 'secret-handle' || typeof handleId !== 'string' || !bounded(handleId)) return undefined;
  return Object.freeze({ kind, handleId });
}
function snapshotAuthority(value: unknown): Readonly<RemoteSessionAuthority> | undefined {
  const record = plainRecord(value);
  if (!record || !exactOwnKeys(record, ['endpointId','remoteHostId','sessionId','generation'], ['endpointId','remoteHostId','sessionId','generation'])) return undefined;
  const endpointId = ownData(record, 'endpointId'), remoteHostId = ownData(record, 'remoteHostId'), sessionId = ownData(record, 'sessionId'), generation = ownData(record, 'generation');
  if (typeof endpointId !== 'string' || typeof remoteHostId !== 'string' || typeof sessionId !== 'string' || typeof generation !== 'number' || !bounded(endpointId) || !bounded(remoteHostId) || !bounded(sessionId) || !Number.isSafeInteger(generation) || generation < 0) return undefined;
  return Object.freeze({ endpointId, remoteHostId, sessionId, generation });
}
function snapshotStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_COMMAND_ARGS) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(['length', ...Array.from({length:value.length}, (_,i)=>String(i))]);
  for (const [key, descriptor] of Object.entries(descriptors)) if (!allowed.has(key) || !('value' in descriptor)) return undefined;
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string' || utf8Bytes(descriptor.value) > MAX_COMMAND_ARG_BYTES || /\0/.test(descriptor.value)) return undefined;
    out.push(descriptor.value);
  }
  return Object.freeze(out);
}
function snapshotCommandInvocation(value: unknown): Readonly<RemoteCommandInvocation> | undefined {
  const record = plainRecord(value);
  if (!record || !exactOwnKeys(record, ['command','args'], ['command'])) return undefined;
  const command = ownData(record, 'command'), rawArgs = ownData(record, 'args');
  if (typeof command !== 'string' || !bounded(command, MAX_COMMAND_BYTES)) return undefined;
  const args = rawArgs === undefined ? undefined : snapshotStringArray(rawArgs);
  if (rawArgs !== undefined && !args) return undefined;
  let total = utf8Bytes(command);
  for (const arg of args ?? []) { total += utf8Bytes(arg); if (total > MAX_COMMAND_TOTAL_BYTES) return undefined; }
  return Object.freeze({ command, ...(args ? { args } : {}) });
}
function snapshotVisualInput(value: unknown): Readonly<RemoteVisualInput> | undefined {
  const record = plainRecord(value); if (!record) return undefined;
  const kind = ownData(record, 'kind');
  if (kind === 'pointer') {
    if (!exactOwnKeys(record, ['kind','x','y'], ['kind','x','y'])) return undefined;
    const x = ownData(record,'x'), y = ownData(record,'y');
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > MAX_VISUAL_COORDINATE || y > MAX_VISUAL_COORDINATE) return undefined;
    return Object.freeze({ kind, x, y });
  }
  if (kind === 'key') {
    if (!exactOwnKeys(record, ['kind','key'], ['kind','key'])) return undefined;
    const key = ownData(record,'key'); if (typeof key !== 'string' || !bounded(key, MAX_VISUAL_KEY_BYTES)) return undefined;
    return Object.freeze({ kind, key });
  }
  if (kind === 'text') {
    if (!exactOwnKeys(record, ['kind','text'], ['kind','text'])) return undefined;
    const text = ownData(record,'text'); if (typeof text !== 'string' || utf8Bytes(text) > MAX_VISUAL_TEXT_BYTES || /\0/.test(text)) return undefined;
    return Object.freeze({ kind, text });
  }
  return undefined;
}
function safeCapabilities(values: readonly string[]): readonly string[] { const out:string[]=[]; for (const value of values) { if (out.length >= MAX_CAPABILITIES) break; if (typeof value === 'string' && REMOTE_CAPABILITY_PATTERN.test(value) && !out.includes(value)) out.push(value); } return Object.freeze(out); }
function safeMetadata(items: readonly RemoteMetadataItem[], maxItems:number, maxTextBytes:number): {items:RemoteMetadataItem[];truncated:boolean} { const out:RemoteMetadataItem[]=[]; let bytes=0,truncated=items.length>maxItems; for(const item of items.slice(0,maxItems)){ if(!item || typeof item.key!=='string'||typeof item.value!=='string'||!bounded(item.key,128)){truncated=true;continue;} const n=utf8Bytes(item.key)+utf8Bytes(item.value); if(bytes+n>maxTextBytes){truncated=true;break;} out.push({key:item.key,value:item.value});bytes+=n;} return {items:out,truncated}; }
function safeDisplayFrame(frame:RemoteDisplayFrame,maxPixels:number,maxBytes:number):{frame:RemoteDisplayFrame;truncated:boolean}{ if(!Number.isSafeInteger(frame.width)||!Number.isSafeInteger(frame.height)||frame.width<1||frame.height<1||frame.width>MAX_DISPLAY_DIMENSION||frame.height>MAX_DISPLAY_DIMENSION||(frame.format!=='synthetic-rgba'&&frame.format!=='synthetic-png')||(frame.frameId!==undefined&&(!bounded(frame.frameId)))) throw new Error('invalid remote display frame'); const pixels=frame.width*frame.height; if(!Number.isSafeInteger(pixels)||pixels>MAX_DISPLAY_PIXELS) throw new Error('remote display frame exceeds hard pixel bound'); const byteLimit=Math.min(maxBytes,MAX_DISPLAY_BYTES),pixelLimit=Math.min(maxPixels,MAX_DISPLAY_PIXELS); let truncated=pixels>pixelLimit,bytes:Uint8Array|undefined; if(frame.bytes!==undefined){ if(!(frame.bytes instanceof Uint8Array)) throw new Error('invalid remote display bytes'); if(frame.format==='synthetic-rgba'&&frame.bytes.byteLength!==pixels*4) throw new Error('invalid synthetic rgba byte length'); if(frame.bytes.byteLength<=byteLimit&&pixels<=pixelLimit) bytes=frame.bytes.slice(); else truncated=true;} return {frame:{width:frame.width,height:frame.height,format:frame.format,frameId:frame.frameId,...(bytes?{bytes}:{})},truncated}; }
function safeEvidenceCode(value: unknown): string { return typeof value === 'string' && MACHINE_EVIDENCE_PATTERN.test(value) ? value : 'remote-backend-evidence-invalid'; }
function truncateUtf8(value:string,maxBytes:number):{value:string;truncated:boolean}{let used=0,out='';for(const ch of value){const n=utf8Bytes(ch);if(used+n>maxBytes)return{value:out,truncated:true};out+=ch;used+=n;}return{value:out,truncated:false};}
function safeCommandResult(value:RemoteCommandResult):RemoteCommandResult{if(!value||typeof value!=='object'||(value.exitCode!==null&&!Number.isSafeInteger(value.exitCode)))return{exitCode:null,stdoutTruncated:true,stderrTruncated:true};const stdout=typeof value.stdout==='string'?truncateUtf8(value.stdout,MAX_COMMAND_OUTPUT_BYTES):undefined;const stderr=typeof value.stderr==='string'?truncateUtf8(value.stderr,MAX_COMMAND_OUTPUT_BYTES):undefined;return{exitCode:value.exitCode,...(stdout?{stdout:stdout.value,stdoutTruncated:stdout.truncated||value.stdoutTruncated===true}:{}),...(stderr?{stderr:stderr.value,stderrTruncated:stderr.truncated||value.stderrTruncated===true}:{})};}

export class RemoteSessionAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  readonly endpoint: Readonly<RemoteEndpointIdentity>;
  private lifecycle: RemoteConnectionLifecycle='disconnected'; private connection?:RemoteSessionConnection; private generation=0; private sequence=0; private discoveredCapabilities:readonly string[]=[];
  private lifecycleTail: Promise<void> = Promise.resolve();
  constructor(readonly adapterId:string, endpoint:RemoteEndpointIdentity, private readonly backend:RemoteSessionBackend){const endpointSnapshot=snapshotEndpoint(endpoint);if(!bounded(adapterId)||!endpointSnapshot||backend.protocol!==endpointSnapshot.protocol)throw new Error('invalid remote-session adapter configuration');this.endpoint=endpointSnapshot;this.descriptor=Object.freeze({id:adapterId,kind:'remote-session' as const,version:'0.1.0',capabilities:Object.freeze(['remote.session.observe','remote.metadata.observe',...(endpointSnapshot.protocol==='ssh'?['remote.ssh.execute']:['remote.display.observe','remote.visual.input'])])});}
  state():Readonly<{lifecycle:RemoteConnectionLifecycle;endpoint:RemoteEndpointIdentity;authority?:RemoteSessionAuthority;capabilities:readonly string[]}>{return Object.freeze({lifecycle:this.lifecycle,endpoint:this.endpoint,authority:this.connection?Object.freeze(this.currentAuthority()):undefined,capabilities:this.discoveredCapabilities});}
  connect(credential?:RemoteSecretHandle):Promise<RemoteSessionAuthority>{const credentialSnapshot=credential===undefined?undefined:snapshotSecretHandle(credential);if(credential!==undefined&&!credentialSnapshot)return Promise.reject(new Error('invalid secret handle'));return this.enqueueLifecycle(()=>this.connectTransition(credentialSnapshot));}
  reconnect(credential?:RemoteSecretHandle):Promise<RemoteSessionAuthority>{return this.connect(credential);}
  disconnect():Promise<void>{return this.enqueueLifecycle(()=>this.disconnectTransition());}
  async observe(request:ComputerObservationRequest):Promise<ComputerObservationEnvelope>{this.assertRequestAdapter(request.adapterId);const base={adapterId:this.adapterId,environment:'remote-session' as const,channel:request.channel,sequence:++this.sequence};if(request.channel==='network')return{...base,complete:true,truncated:false,data:this.state()};const connection=this.requireConnection();this.assertSurfaceAuthority(request.surface);if(request.channel==='terminal'&&this.endpoint.protocol==='ssh'){const maxItems=clampLimit(request.limits?.maxItems,16,MAX_METADATA_ITEMS),maxTextBytes=clampLimit(request.limits?.maxTextBytes,4096,MAX_METADATA_TEXT_BYTES);const boundedMetadata=safeMetadata(await this.backend.observeMetadata(connection,{maxItems,maxTextBytes}),maxItems,maxTextBytes);return{...base,complete:!boundedMetadata.truncated,truncated:boundedMetadata.truncated,surface:this.surfaceRef(),data:{metadata:boundedMetadata.items}};}if(request.channel==='visual'&&(this.endpoint.protocol==='rdp'||this.endpoint.protocol==='vnc')&&this.backend.captureDisplay){const maxPixels=clampLimit(request.limits?.maxItems,MAX_DISPLAY_PIXELS,MAX_DISPLAY_PIXELS),maxBytes=clampLimit(request.limits?.maxTextBytes,MAX_DISPLAY_BYTES,MAX_DISPLAY_BYTES);const boundedFrame=safeDisplayFrame(await this.backend.captureDisplay(connection),maxPixels,maxBytes);return{...base,complete:!boundedFrame.truncated,truncated:boundedFrame.truncated,surface:this.surfaceRef(),data:boundedFrame.frame};}throw new Error('observation channel unsupported for remote protocol');}
  async act(request:ComputerActionRequest):Promise<ComputerActionResult>{if(request.adapterId!==this.adapterId)return this.reject('remote-adapter-mismatch');if(request.effect!=='remote-execution')return this.reject('remote-effect-required');const connection=this.connection;if(!connection||this.lifecycle!=='connected')return this.reject('remote-session-not-connected');const payload=plainRecord(request.payload);if(!payload)return this.reject('remote-payload-invalid');const authority=snapshotAuthority(ownData(payload,'authority'));if(!authority)return this.reject('remote-authority-required');const authorityError=this.authorityError(authority);if(authorityError)return this.reject(authorityError);
    if(request.capability==='remote.ssh.execute'){if(this.endpoint.protocol!=='ssh'||!this.backend.executeRemoteCommand)return this.unsupported('remote-ssh-unavailable');const invocation=snapshotCommandInvocation(ownData(payload,'invocation'));if(!invocation)return this.reject('remote-command-invalid');try{return this.fromDispatch(await this.backend.executeRemoteCommand(connection,invocation),safeCommandResult);}catch(error){return this.transportFailure(error);}}
    if(request.capability==='remote.visual.input'){if((this.endpoint.protocol!=='rdp'&&this.endpoint.protocol!=='vnc')||!this.backend.sendVisualInput)return this.unsupported('remote-visual-input-unavailable');const input=snapshotVisualInput(ownData(payload,'input'));if(!input)return this.reject('remote-input-invalid');let mapped:ComputerActionResult;try{mapped=this.fromDispatch(await this.backend.sendVisualInput(connection,input));}catch(error){mapped=this.transportFailure(error);}if(mapped.status==='completed')return{...mapped,status:'unknown',verification:'unverified',evidence:[...(mapped.evidence??[]),'remote-visual-effect-unverified']};return mapped;}
    return this.unsupported('remote-capability-unsupported');}
  private enqueueLifecycle<T>(operation:()=>Promise<T>):Promise<T>{const result=this.lifecycleTail.then(operation,operation);this.lifecycleTail=result.then(()=>undefined,()=>undefined);return result;}
  private async connectTransition(credential?:Readonly<RemoteSecretHandle>):Promise<RemoteSessionAuthority>{const prior=this.connection;this.lifecycle=prior?'reconnecting':'connecting';let candidate:RemoteSessionConnection;try{candidate=await this.backend.connect(this.endpoint,credential);}catch(error){if(prior){this.connection=prior;this.discoveredCapabilities=safeCapabilities(prior.capabilities);this.lifecycle='connected';}else this.failClosed();throw error;}
    if(!bounded(candidate.sessionId)||!bounded(candidate.remoteHostId)||!Array.isArray(candidate.capabilities)){const cleaned=await this.cleanupCandidate(candidate);if(cleaned&&prior){this.connection=prior;this.discoveredCapabilities=safeCapabilities(prior.capabilities);this.lifecycle='connected';}else if(cleaned)this.failClosed();if(!cleaned)throw new Error('remote candidate cleanup failed');throw new Error('invalid remote identity');}
    const committed=Object.freeze({...candidate,capabilities:safeCapabilities(candidate.capabilities)});
    if(prior){try{await this.backend.disconnect(prior);}catch(error){const cleaned=await this.cleanupCandidate(committed);this.failClosed();if(!cleaned)throw new Error('remote candidate cleanup failed');throw error;}}
    this.connection=committed;this.generation+=1;this.discoveredCapabilities=committed.capabilities;this.lifecycle='connected';return Object.freeze(this.currentAuthority());}
  private async disconnectTransition():Promise<void>{const connection=this.connection;if(!connection){this.discoveredCapabilities=[];this.lifecycle='disconnected';return;}this.lifecycle='reconnecting';try{await this.backend.disconnect(connection);}catch(error){this.failClosed();throw error;}this.connection=undefined;this.discoveredCapabilities=[];this.lifecycle='disconnected';}
  private async cleanupCandidate(candidate:RemoteSessionConnection):Promise<boolean>{try{await this.backend.disconnect(candidate);return true;}catch{this.failClosed();return false;}}
  private failClosed():void{this.connection=undefined;this.discoveredCapabilities=[];this.lifecycle='failed';}
  private currentAuthority():RemoteSessionAuthority{const c=this.requireConnection();return{endpointId:this.endpoint.endpointId,remoteHostId:c.remoteHostId,sessionId:c.sessionId,generation:this.generation};}
  private surfaceRef():ComputerSurfaceRef{const c=this.requireConnection();return{adapterId:this.adapterId,environment:'remote-session',surfaceId:c.sessionId,generation:this.generation,parentSurfaceId:c.remoteHostId};}
  private requireConnection():RemoteSessionConnection{if(!this.connection||this.lifecycle!=='connected')throw new Error('remote session is not connected');return this.connection;}
  private assertRequestAdapter(adapterId:string):void{if(adapterId!==this.adapterId)throw new Error('remote adapter mismatch');}
  private assertSurfaceAuthority(surface:ComputerSurfaceRef|undefined):void{if(!surface)return;const current=this.surfaceRef();if(surface.adapterId!==current.adapterId||surface.environment!==current.environment||surface.surfaceId!==current.surfaceId||surface.generation!==current.generation||surface.parentSurfaceId!==current.parentSurfaceId)throw new Error('stale or mismatched remote surface');}
  private authorityError(authority:RemoteSessionAuthority):string|undefined{const current=this.currentAuthority();if(authority.endpointId!==current.endpointId||authority.remoteHostId!==current.remoteHostId)return'remote-host-mismatch';if(authority.sessionId!==current.sessionId)return'remote-session-replaced';if(authority.generation!==current.generation)return'remote-session-stale-generation';return undefined;}
  private reject(evidence:string):ComputerActionResult{return{status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:[evidence]};}
  private unsupported(evidence:string):ComputerActionResult{return{status:'unsupported',dispatch:'not-dispatched',verification:'unverified',evidence:[evidence]};}
  private transportFailure(error:unknown):ComputerActionResult{if(error instanceof RemoteDispatchError&&error.dispatch==='not-dispatched')return{status:'failed',dispatch:'not-dispatched',verification:'unverified',evidence:[safeEvidenceCode(error.evidence)]};const evidence=error instanceof RemoteDispatchError?safeEvidenceCode(error.evidence):'remote-transport-failure-ambiguous';return{status:'unknown',dispatch:'unknown',verification:'unverified',evidence:[evidence]};}
  private fromDispatch<T>(result:RemoteDispatchOutcome<T>,mapValue?:(value:T)=>unknown):ComputerActionResult{if(result.dispatch==='not-dispatched')return{status:'failed',dispatch:'not-dispatched',verification:'unverified',evidence:[safeEvidenceCode(result.evidence)]};if(result.dispatch==='unknown')return{status:'unknown',dispatch:'unknown',verification:'unverified',evidence:[safeEvidenceCode(result.evidence)]};const details=result.value===undefined?undefined:(mapValue?mapValue(result.value):result.value);return{status:'completed',dispatch:'dispatched-once',verification:'not-applicable',evidence:result.evidence?[safeEvidenceCode(result.evidence)]:undefined,details};}
}