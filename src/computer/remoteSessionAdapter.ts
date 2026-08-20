import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEnvironmentAdapter,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
  ComputerSurfaceRef,
} from './environmentAdapter.js';
import { validateComputerActionRequest, validateComputerObservationRequest } from './environmentAdapter.js';

export const REMOTE_PROTOCOL_KINDS = ['ssh', 'rdp', 'vnc'] as const;
export type RemoteProtocolKind = typeof REMOTE_PROTOCOL_KINDS[number];
export type RemoteConnectionLifecycle = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface RemoteEndpointIdentity { endpointId: string; protocol: RemoteProtocolKind; host: string; port: number; }
export interface RemoteSecretHandle { readonly kind: 'secret-handle'; readonly handleId: string; }
export interface RemoteSessionConnection { sessionId: string; remoteHostId: string; capabilities: readonly string[]; }
export interface RemoteSessionAuthority { endpointId: string; remoteHostId: string; sessionId: string; generation: number; }
export interface RemoteMetadataItem { key: string; value: string; }
export interface RemoteDisplayCaptureLimits { readonly maxPixels: number; readonly maxBytes: number; }
export interface RemoteDisplayFrame { width: number; height: number; format: 'synthetic-rgba' | 'synthetic-png'; bytes?: Uint8Array; frameId?: string; truncated?: boolean; }
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
  /** Cleanup for a post-connect result whose semantic identity cannot be trusted/snapshotted. Implementations must use backend-private ownership, not semantic fields on candidate. */
  cleanupFailedConnection(candidate: unknown): Promise<void>;
  disconnect(connection: RemoteSessionConnection): Promise<void>;
  observeMetadata(connection: RemoteSessionConnection, limits: { maxItems: number; maxTextBytes: number }): Promise<readonly RemoteMetadataItem[]>;
  captureDisplay?(connection: RemoteSessionConnection, limits: RemoteDisplayCaptureLimits): Promise<RemoteDisplayFrame>;
  sendVisualInput?(connection: RemoteSessionConnection, input: RemoteVisualInput): Promise<RemoteDispatchOutcome<void>>;
  executeRemoteCommand?(connection: RemoteSessionConnection, invocation: RemoteCommandInvocation): Promise<RemoteDispatchOutcome<RemoteCommandResult>>;
}

const MAX_CAPABILITIES = 64, MAX_METADATA_ITEMS = 64, MAX_METADATA_TEXT_BYTES = 16_384, MAX_METADATA_RESULT_ITEMS = 256;
const MAX_ID_BYTES = 256, MAX_HOST_BYTES = 512, MAX_DISPLAY_DIMENSION = 16_384, MAX_DISPLAY_PIXELS = 4_194_304, MAX_DISPLAY_BYTES = 16_777_216;
const MAX_COMMAND_BYTES = 4_096, MAX_COMMAND_ARGS = 128, MAX_COMMAND_ARG_BYTES = 4_096, MAX_COMMAND_TOTAL_BYTES = 65_536, MAX_COMMAND_OUTPUT_BYTES = 65_536;
const MAX_VISUAL_COORDINATE = 1_000_000, MAX_VISUAL_KEY_BYTES = 128, MAX_VISUAL_TEXT_BYTES = 4_096;
const MACHINE_EVIDENCE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const REMOTE_CAPABILITY_PATTERN = /^remote\.(session\.observe|metadata\.observe|display\.observe|visual\.input|ssh\.execute)$/;

type ObservationLease = Readonly<{ connection: Readonly<RemoteSessionConnection>; generation: number; surface: Readonly<ComputerSurfaceRef> }>;

function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function bounded(value: string, max = MAX_ID_BYTES): boolean { return value.length > 0 && utf8Bytes(value) <= max && !/[\r\n\0]/.test(value); }
function clampLimit(value: number | undefined, fallback: number, max: number): number { return value === undefined ? fallback : Math.min(value, max); }
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
function snapshotWhitelistedRecord(value: unknown, allowed: readonly string[], required: readonly string[] = []): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  let proto: object | null;
  try { proto = Object.getPrototypeOf(value); } catch { return undefined; }
  if (proto !== Object.prototype && proto !== null) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return undefined; }
    if (!descriptor) { if (required.includes(key)) return undefined; continue; }
    if (!('value' in descriptor)) return undefined;
    out[key] = descriptor.value;
  }
  return Object.freeze(out);
}
function snapshotObservationRequest(value: unknown): Readonly<ComputerObservationRequest> | undefined {
  const record = snapshotWhitelistedRecord(value, ['adapterId','channel','surface','target','limits'], ['adapterId','channel']); if (!record) return undefined;
  const rawSurface = record.surface, rawTarget = record.target, rawLimits = record.limits;
  const surface = rawSurface === undefined ? undefined : snapshotWhitelistedRecord(rawSurface, ['adapterId','environment','surfaceId','generation','parentSurfaceId'], ['adapterId','environment','surfaceId']);
  const target = rawTarget === undefined ? undefined : snapshotWhitelistedRecord(rawTarget, ['adapterId','environment','kind','entityId','surfaceId','generation'], ['adapterId','environment','kind','entityId']);
  const limits = rawLimits === undefined ? undefined : snapshotWhitelistedRecord(rawLimits, ['maxItems','maxTextBytes','maxDepth']);
  if ((rawSurface !== undefined && !surface) || (rawTarget !== undefined && !target) || (rawLimits !== undefined && !limits)) return undefined;
  return Object.freeze({adapterId:record.adapterId,channel:record.channel,...(surface?{surface}:{}),...(target?{target}:{}),...(limits?{limits}:{})}) as unknown as Readonly<ComputerObservationRequest>;
}
function snapshotActionRequest(value: unknown): Readonly<ComputerActionRequest> | undefined {
  const record = snapshotWhitelistedRecord(value, ['adapterId','actionId','capability','effect','idempotency','target','payload'], ['adapterId','actionId','capability','effect','idempotency']); if (!record) return undefined;
  const rawTarget = record.target, rawPayload = record.payload;
  const target = rawTarget === undefined ? undefined : snapshotWhitelistedRecord(rawTarget, ['adapterId','environment','kind','entityId','surfaceId','generation'], ['adapterId','environment','kind','entityId']);
  const payload = rawPayload === undefined ? undefined : snapshotWhitelistedRecord(rawPayload, ['authority','invocation','input']);
  if ((rawTarget !== undefined && !target) || (rawPayload !== undefined && !payload)) return undefined;
  return Object.freeze({adapterId:record.adapterId,actionId:record.actionId,capability:record.capability,effect:record.effect,idempotency:record.idempotency,...(target?{target}:{}),...(payload?{payload}:{})}) as unknown as Readonly<ComputerActionRequest>;
}
function snapshotEndpoint(value: unknown): Readonly<RemoteEndpointIdentity> | undefined {
  const record = snapshotWhitelistedRecord(value, ['endpointId','protocol','host','port'], ['endpointId','protocol','host','port']);
  if (!record) return undefined;
  const endpointId = record.endpointId, protocol = record.protocol, host = record.host, port = record.port;
  if (typeof endpointId !== 'string' || typeof protocol !== 'string' || typeof host !== 'string' || typeof port !== 'number' || !bounded(endpointId) || !REMOTE_PROTOCOL_KINDS.includes(protocol as RemoteProtocolKind) || !bounded(host,MAX_HOST_BYTES) || !Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;
  return Object.freeze({ endpointId, protocol: protocol as RemoteProtocolKind, host, port });
}
function snapshotSecretHandle(value: unknown): Readonly<RemoteSecretHandle> | undefined {
  const record = snapshotWhitelistedRecord(value, ['kind','handleId'], ['kind','handleId']);
  if (!record) return undefined;
  const kind = record.kind, handleId = record.handleId;
  if (kind !== 'secret-handle' || typeof handleId !== 'string' || !bounded(handleId)) return undefined;
  return Object.freeze({ kind, handleId });
}
function snapshotAuthority(value: unknown): Readonly<RemoteSessionAuthority> | undefined {
  const record = snapshotWhitelistedRecord(value, ['endpointId','remoteHostId','sessionId','generation'], ['endpointId','remoteHostId','sessionId','generation']);
  if (!record) return undefined;
  const endpointId = record.endpointId, remoteHostId = record.remoteHostId, sessionId = record.sessionId, generation = record.generation;
  if (typeof endpointId !== 'string' || typeof remoteHostId !== 'string' || typeof sessionId !== 'string' || typeof generation !== 'number' || !bounded(endpointId) || !bounded(remoteHostId) || !bounded(sessionId) || !Number.isSafeInteger(generation) || generation < 0) return undefined;
  return Object.freeze({ endpointId, remoteHostId, sessionId, generation });
}
function snapshotConnectionCapabilities(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  let proto: object | null, lengthDescriptor: PropertyDescriptor | undefined;
  try { proto = Object.getPrototypeOf(value); lengthDescriptor = Object.getOwnPropertyDescriptor(value,'length'); } catch { return undefined; }
  if (proto !== Array.prototype || !lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > MAX_CAPABILITIES) return undefined;
  const length = lengthDescriptor.value as number, out:string[]=[];
  for(let i=0;i<length;i++){
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value,String(i)); } catch { return undefined; }
    if(!descriptor||!('value' in descriptor)||typeof descriptor.value!=='string')return undefined;
    out.push(descriptor.value);
  }
  return Object.freeze(out);
}
function snapshotConnectionCandidate(value: unknown): Readonly<RemoteSessionConnection> | undefined {
  const record=snapshotWhitelistedRecord(value,['sessionId','remoteHostId','capabilities'],['sessionId','remoteHostId','capabilities']);
  if(!record)return undefined;
  const sessionId=record.sessionId,remoteHostId=record.remoteHostId,capabilities=snapshotConnectionCapabilities(record.capabilities);
  if(typeof sessionId!=='string'||typeof remoteHostId!=='string'||!capabilities)return undefined;
  return Object.freeze({sessionId,remoteHostId,capabilities});
}
function validatedConnectionCandidate(candidate: Readonly<RemoteSessionConnection>): Readonly<RemoteSessionConnection> | undefined {
  if(!bounded(candidate.sessionId)||!bounded(candidate.remoteHostId))return undefined;
  return Object.freeze({sessionId:candidate.sessionId,remoteHostId:candidate.remoteHostId,capabilities:safeCapabilities(candidate.capabilities)});
}
function snapshotStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  let proto: object | null, lengthDescriptor: PropertyDescriptor | undefined;
  try { proto = Object.getPrototypeOf(value); lengthDescriptor = Object.getOwnPropertyDescriptor(value,'length'); } catch { return undefined; }
  if (proto !== Array.prototype || !lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > MAX_COMMAND_ARGS) return undefined;
  const length = lengthDescriptor.value as number, out: string[] = [];
  for (let i=0;i<length;i++) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value,String(i)); } catch { return undefined; }
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string' || utf8Bytes(descriptor.value) > MAX_COMMAND_ARG_BYTES || /\0/.test(descriptor.value)) return undefined;
    out.push(descriptor.value);
  }
  return Object.freeze(out);
}
function snapshotCommandInvocation(value: unknown): Readonly<RemoteCommandInvocation> | undefined {
  const record = snapshotWhitelistedRecord(value, ['command','args'], ['command']);
  if (!record) return undefined;
  const command = record.command, rawArgs = record.args;
  if (typeof command !== 'string' || !bounded(command, MAX_COMMAND_BYTES)) return undefined;
  const args = rawArgs === undefined ? undefined : snapshotStringArray(rawArgs);
  if (rawArgs !== undefined && !args) return undefined;
  let total = utf8Bytes(command);
  for (const arg of args ?? []) { total += utf8Bytes(arg); if (total > MAX_COMMAND_TOTAL_BYTES) return undefined; }
  return Object.freeze({ command, ...(args ? { args } : {}) });
}
function snapshotVisualInput(value: unknown): Readonly<RemoteVisualInput> | undefined {
  const record = snapshotWhitelistedRecord(value, ['kind','x','y','key','text'], ['kind']); if (!record) return undefined;
  const kind = record.kind;
  const has = (key:string) => Object.prototype.hasOwnProperty.call(record,key);
  if (kind === 'pointer') {
    if (!has('x') || !has('y') || has('key') || has('text')) return undefined;
    const x = record.x, y = record.y;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > MAX_VISUAL_COORDINATE || y > MAX_VISUAL_COORDINATE) return undefined;
    return Object.freeze({ kind, x, y });
  }
  if (kind === 'key') {
    if (!has('key') || has('x') || has('y') || has('text')) return undefined;
    const key = record.key; if (typeof key !== 'string' || !bounded(key, MAX_VISUAL_KEY_BYTES)) return undefined;
    return Object.freeze({ kind, key });
  }
  if (kind === 'text') {
    if (!has('text') || has('x') || has('y') || has('key')) return undefined;
    const text = record.text; if (typeof text !== 'string' || utf8Bytes(text) > MAX_VISUAL_TEXT_BYTES || /\0/.test(text)) return undefined;
    return Object.freeze({ kind, text });
  }
  return undefined;
}
function snapshotMetadataBatch(value: unknown): readonly Readonly<RemoteMetadataItem>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  let proto: object | null, lengthDescriptor: PropertyDescriptor | undefined;
  try { proto = Object.getPrototypeOf(value); lengthDescriptor = Object.getOwnPropertyDescriptor(value,'length'); } catch { return undefined; }
  if (proto !== Array.prototype || !lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > MAX_METADATA_RESULT_ITEMS) return undefined;
  const length = lengthDescriptor.value as number, out: Readonly<RemoteMetadataItem>[] = [];
  for (let i=0;i<length;i++) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value,String(i)); } catch { return undefined; }
    if (!descriptor || !('value' in descriptor)) return undefined;
    const item = snapshotWhitelistedRecord(descriptor.value,['key','value'],['key','value']);
    if (!item || typeof item.key !== 'string' || typeof item.value !== 'string') return undefined;
    out.push(Object.freeze({key:item.key,value:item.value}));
  }
  return Object.freeze(out);
}
function snapshotDisplayFrame(value: unknown): Readonly<RemoteDisplayFrame> | undefined {
  const record = snapshotWhitelistedRecord(value,['width','height','format','bytes','frameId','truncated'],['width','height','format']);
  if (!record) return undefined;
  const width=record.width,height=record.height,format=record.format,frameId=record.frameId,truncated=record.truncated,rawBytes=record.bytes;
  if (typeof width!=='number'||typeof height!=='number'||(format!=='synthetic-rgba'&&format!=='synthetic-png')||(frameId!==undefined&&typeof frameId!=='string')||(truncated!==undefined&&typeof truncated!=='boolean')) return undefined;
  let bytes:Uint8Array|undefined;
  if(rawBytes!==undefined){
    if(!(rawBytes instanceof Uint8Array)||!ArrayBuffer.isView(rawBytes))return undefined;
    try{bytes=Uint8Array.prototype.slice.call(rawBytes) as Uint8Array;}catch{return undefined;}
  }
  return Object.freeze({width,height,format,...(bytes?{bytes}:{}),...(frameId!==undefined?{frameId:frameId as string}:{}),...(truncated!==undefined?{truncated:truncated as boolean}:{})});
}
function safeCapabilities(values: readonly string[]): readonly string[] { const out:string[]=[]; for (const value of values) { if (out.length >= MAX_CAPABILITIES) break; if (typeof value === 'string' && REMOTE_CAPABILITY_PATTERN.test(value) && !out.includes(value)) out.push(value); } return Object.freeze(out); }
function safeMetadata(items: readonly Readonly<RemoteMetadataItem>[], maxItems:number, maxTextBytes:number): {items:RemoteMetadataItem[];truncated:boolean} { const out:RemoteMetadataItem[]=[]; let bytes=0,truncated=items.length>maxItems; for(const item of items.slice(0,maxItems)){ if(!bounded(item.key,128)){truncated=true;continue;} const n=utf8Bytes(item.key)+utf8Bytes(item.value); if(bytes+n>maxTextBytes){truncated=true;break;} out.push({key:item.key,value:item.value});bytes+=n;} return {items:out,truncated}; }
function safeDisplayFrame(frame:Readonly<RemoteDisplayFrame>,maxPixels:number,maxBytes:number):{frame:RemoteDisplayFrame;truncated:boolean}{ if(!Number.isSafeInteger(frame.width)||!Number.isSafeInteger(frame.height)||frame.width<1||frame.height<1||frame.width>MAX_DISPLAY_DIMENSION||frame.height>MAX_DISPLAY_DIMENSION||(frame.format!=='synthetic-rgba'&&frame.format!=='synthetic-png')||(frame.frameId!==undefined&&(!bounded(frame.frameId)))||(frame.truncated!==undefined&&typeof frame.truncated!=='boolean')) throw new Error('invalid remote display frame'); const pixels=frame.width*frame.height; const pixelLimit=Math.min(maxPixels,MAX_DISPLAY_PIXELS),byteLimit=Math.min(maxBytes,MAX_DISPLAY_BYTES); if(!Number.isSafeInteger(pixels)||pixels>pixelLimit) throw new Error('remote display frame exceeds acquisition pixel bound'); const bytes=frame.bytes; if(bytes!==undefined){ if(bytes.byteLength>byteLimit) throw new Error('remote display frame exceeds acquisition byte bound'); if(frame.format==='synthetic-rgba'&&bytes.byteLength!==pixels*4) throw new Error('invalid synthetic rgba byte length'); } return {frame:{width:frame.width,height:frame.height,format:frame.format,frameId:frame.frameId,...(bytes?{bytes}:{})},truncated:frame.truncated===true}; }
function safeEvidenceCode(value: unknown): string { return typeof value === 'string' && MACHINE_EVIDENCE_PATTERN.test(value) ? value : 'remote-backend-evidence-invalid'; }
function truncateUtf8(value:string,maxBytes:number):{value:string;truncated:boolean}{let used=0,out='';for(const ch of value){const n=utf8Bytes(ch);if(used+n>maxBytes)return{value:out,truncated:true};out+=ch;used+=n;}return{value:out,truncated:false};}
function snapshotCommandResult(value: unknown): Readonly<RemoteCommandResult> | undefined {
  const record=plainRecord(value);if(!record||!exactOwnKeys(record,['exitCode','stdout','stderr','stdoutTruncated','stderrTruncated'],['exitCode']))return undefined;
  const exitCode=ownData(record,'exitCode'),rawStdout=ownData(record,'stdout'),rawStderr=ownData(record,'stderr'),rawStdoutTruncated=ownData(record,'stdoutTruncated'),rawStderrTruncated=ownData(record,'stderrTruncated');
  if(exitCode!==null&&(!Number.isSafeInteger(exitCode)))return undefined;
  if(rawStdout!==undefined&&typeof rawStdout!=='string')return undefined;if(rawStderr!==undefined&&typeof rawStderr!=='string')return undefined;
  if(rawStdoutTruncated!==undefined&&typeof rawStdoutTruncated!=='boolean')return undefined;if(rawStderrTruncated!==undefined&&typeof rawStderrTruncated!=='boolean')return undefined;
  const stdout=typeof rawStdout==='string'?truncateUtf8(rawStdout,MAX_COMMAND_OUTPUT_BYTES):undefined,stderr=typeof rawStderr==='string'?truncateUtf8(rawStderr,MAX_COMMAND_OUTPUT_BYTES):undefined;
  return Object.freeze({exitCode:exitCode as number|null,...(stdout?{stdout:stdout.value,stdoutTruncated:stdout.truncated||rawStdoutTruncated===true}:{}),...(stderr?{stderr:stderr.value,stderrTruncated:stderr.truncated||rawStderrTruncated===true}:{})});
}
function snapshotDispatchOutcome<T>(value: unknown, snapshotValue?: (value: unknown)=>T|undefined): Readonly<RemoteDispatchOutcome<T>> | undefined {
  const record=plainRecord(value);if(!record)return undefined;const dispatch=ownData(record,'dispatch'),status=ownData(record,'status'),evidence=ownData(record,'evidence'),rawValue=ownData(record,'value');
  if(dispatch==='not-dispatched'){
    if(status!=='failed'||!exactOwnKeys(record,['dispatch','status','evidence'],['dispatch','status','evidence'])||typeof evidence!=='string')return undefined;
    return Object.freeze({dispatch,status,evidence});
  }
  if(dispatch==='unknown'){
    if(status!=='unknown'||!exactOwnKeys(record,['dispatch','status','evidence'],['dispatch','status','evidence'])||typeof evidence!=='string')return undefined;
    return Object.freeze({dispatch,status,evidence});
  }
  if(dispatch==='dispatched-once'){
    if(status!=='completed'||!exactOwnKeys(record,['dispatch','status','value','evidence'],['dispatch','status'])||(evidence!==undefined&&typeof evidence!=='string'))return undefined;
    let snappedValue:T|undefined;if(rawValue!==undefined){if(!snapshotValue)return undefined;snappedValue=snapshotValue(rawValue);if(snappedValue===undefined)return undefined;}
    return Object.freeze({dispatch,status,...(snappedValue!==undefined?{value:snappedValue}:{}),...(evidence!==undefined?{evidence:evidence as string}:{})});
  }
  return undefined;
}

export class RemoteSessionAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  readonly endpoint: Readonly<RemoteEndpointIdentity>;
  private lifecycle: RemoteConnectionLifecycle='disconnected'; private connection?:Readonly<RemoteSessionConnection>; private generation=0; private sequence=0; private discoveredCapabilities:readonly string[]=[];
  private lifecycleTail: Promise<void> = Promise.resolve();
  constructor(readonly adapterId:string, endpoint:RemoteEndpointIdentity, private readonly backend:RemoteSessionBackend){const endpointSnapshot=snapshotEndpoint(endpoint);if(!bounded(adapterId)||!endpointSnapshot||backend.protocol!==endpointSnapshot.protocol)throw new Error('invalid remote-session adapter configuration');this.endpoint=endpointSnapshot;this.descriptor=Object.freeze({id:adapterId,kind:'remote-session' as const,version:'0.1.0',capabilities:Object.freeze(['remote.session.observe','remote.metadata.observe',...(endpointSnapshot.protocol==='ssh'?['remote.ssh.execute']:['remote.display.observe','remote.visual.input'])])});}
  state():Readonly<{lifecycle:RemoteConnectionLifecycle;endpoint:RemoteEndpointIdentity;authority?:RemoteSessionAuthority;capabilities:readonly string[]}>{return Object.freeze({lifecycle:this.lifecycle,endpoint:this.endpoint,authority:this.connection?Object.freeze(this.currentAuthority()):undefined,capabilities:this.discoveredCapabilities});}
  connect(credential?:RemoteSecretHandle):Promise<RemoteSessionAuthority>{const credentialSnapshot=credential===undefined?undefined:snapshotSecretHandle(credential);if(credential!==undefined&&!credentialSnapshot)return Promise.reject(new Error('invalid secret handle'));return this.enqueueLifecycle(()=>this.connectTransition(credentialSnapshot));}
  reconnect(credential?:RemoteSecretHandle):Promise<RemoteSessionAuthority>{return this.connect(credential);}
  disconnect():Promise<void>{return this.enqueueLifecycle(()=>this.disconnectTransition());}
  async observe(rawRequest:ComputerObservationRequest):Promise<ComputerObservationEnvelope>{const request=snapshotObservationRequest(rawRequest);if(!request||validateComputerObservationRequest(request,this.descriptor).length>0)throw new Error('invalid remote observation request');this.assertRequestAdapter(request.adapterId);const base={adapterId:this.adapterId,environment:'remote-session' as const,channel:request.channel,sequence:++this.sequence};if(request.channel==='network')return{...base,complete:true,truncated:false,data:this.state()};const lease=this.observationLease();this.assertSurfaceAuthority(request.surface,lease.surface);if(request.channel==='terminal'&&this.endpoint.protocol==='ssh'){const maxItems=clampLimit(request.limits?.maxItems,16,MAX_METADATA_ITEMS),maxTextBytes=clampLimit(request.limits?.maxTextBytes,4096,MAX_METADATA_TEXT_BYTES);const rawMetadata=await this.backend.observeMetadata(lease.connection,{maxItems,maxTextBytes});this.assertObservationLease(lease);const metadata=snapshotMetadataBatch(rawMetadata);if(!metadata)throw new Error('invalid remote metadata batch');const boundedMetadata=safeMetadata(metadata,maxItems,maxTextBytes);return{...base,complete:!boundedMetadata.truncated,truncated:boundedMetadata.truncated,surface:lease.surface,data:{metadata:boundedMetadata.items}};}if(request.channel==='visual'&&(this.endpoint.protocol==='rdp'||this.endpoint.protocol==='vnc')&&this.backend.captureDisplay){const maxPixels=clampLimit(request.limits?.maxItems,MAX_DISPLAY_PIXELS,MAX_DISPLAY_PIXELS),maxBytes=clampLimit(request.limits?.maxTextBytes,MAX_DISPLAY_BYTES,MAX_DISPLAY_BYTES),captureLimits=Object.freeze({maxPixels,maxBytes});const rawFrame=await this.backend.captureDisplay(lease.connection,captureLimits);this.assertObservationLease(lease);const frame=snapshotDisplayFrame(rawFrame);if(!frame)throw new Error('invalid remote display frame');const boundedFrame=safeDisplayFrame(frame,maxPixels,maxBytes);return{...base,complete:!boundedFrame.truncated,truncated:boundedFrame.truncated,surface:lease.surface,data:boundedFrame.frame};}throw new Error('observation channel unsupported for remote protocol');}
  async act(rawRequest:ComputerActionRequest):Promise<ComputerActionResult>{const request=snapshotActionRequest(rawRequest);if(!request||validateComputerActionRequest(request,this.descriptor).length>0)return this.reject('remote-action-request-invalid');if(request.adapterId!==this.adapterId)return this.reject('remote-adapter-mismatch');if(!this.descriptor.capabilities.includes(request.capability))return this.unsupported('remote-capability-unsupported');if(request.effect!=='remote-execution')return this.reject('remote-effect-required');const connection=this.connection;if(!connection||this.lifecycle!=='connected')return this.reject('remote-session-not-connected');const payload=request.payload as Readonly<Record<string, unknown>>|undefined;if(!payload)return this.reject('remote-payload-invalid');const authority=snapshotAuthority(ownData(payload as Record<string, unknown>,'authority'));if(!authority)return this.reject('remote-authority-required');const authorityError=this.authorityError(authority);if(authorityError)return this.reject(authorityError);
    if(request.capability==='remote.ssh.execute'){if(this.endpoint.protocol!=='ssh'||!this.backend.executeRemoteCommand)return this.unsupported('remote-ssh-unavailable');const invocation=snapshotCommandInvocation(ownData(payload as Record<string, unknown>,'invocation'));if(!invocation)return this.reject('remote-command-invalid');try{return this.fromDispatch(await this.backend.executeRemoteCommand(connection,invocation),snapshotCommandResult);}catch(error){return this.transportFailure(error);}}
    if(request.capability==='remote.visual.input'){if((this.endpoint.protocol!=='rdp'&&this.endpoint.protocol!=='vnc')||!this.backend.sendVisualInput)return this.unsupported('remote-visual-input-unavailable');const input=snapshotVisualInput(ownData(payload as Record<string, unknown>,'input'));if(!input)return this.reject('remote-input-invalid');let mapped:ComputerActionResult;try{mapped=this.fromDispatch(await this.backend.sendVisualInput(connection,input));}catch(error){mapped=this.transportFailure(error);}if(mapped.status==='completed')return{...mapped,status:'unknown',verification:'unverified',evidence:[...(mapped.evidence??[]),'remote-visual-effect-unverified']};return mapped;}
    return this.unsupported('remote-capability-unsupported');}
  private enqueueLifecycle<T>(operation:()=>Promise<T>):Promise<T>{const result=this.lifecycleTail.then(operation,operation);this.lifecycleTail=result.then(()=>undefined,()=>undefined);return result;}
  private async connectTransition(credential?:Readonly<RemoteSecretHandle>):Promise<RemoteSessionAuthority>{const prior=this.connection;this.lifecycle=prior?'reconnecting':'connecting';let rawCandidate:unknown;try{rawCandidate=await this.backend.connect(this.endpoint,credential);}catch(error){if(prior){this.connection=prior;this.discoveredCapabilities=prior.capabilities;this.lifecycle='connected';}else this.failClosed();throw error;}
    const candidate=snapshotConnectionCandidate(rawCandidate);if(!candidate){const cleaned=await this.cleanupUntrustedCandidate(rawCandidate);if(cleaned&&prior){this.connection=prior;this.discoveredCapabilities=prior.capabilities;this.lifecycle='connected';}else this.failClosed();if(!cleaned)throw new Error('remote candidate cleanup failed');throw new Error('invalid remote identity');}
    const committed=validatedConnectionCandidate(candidate);if(!committed){const cleaned=await this.cleanupCandidate(candidate);if(cleaned&&prior){this.connection=prior;this.discoveredCapabilities=prior.capabilities;this.lifecycle='connected';}else if(cleaned)this.failClosed();if(!cleaned)throw new Error('remote candidate cleanup failed');throw new Error('invalid remote identity');}
    if(prior){try{await this.backend.disconnect(prior);}catch(error){const cleaned=await this.cleanupCandidate(committed);this.failClosed();if(!cleaned)throw new Error('remote candidate cleanup failed');throw error;}}
    this.connection=committed;this.generation+=1;this.discoveredCapabilities=committed.capabilities;this.lifecycle='connected';return Object.freeze(this.currentAuthority());}
  private async disconnectTransition():Promise<void>{const connection=this.connection;if(!connection){this.discoveredCapabilities=[];this.lifecycle='disconnected';return;}this.lifecycle='reconnecting';try{await this.backend.disconnect(connection);}catch(error){this.failClosed();throw error;}this.connection=undefined;this.discoveredCapabilities=[];this.lifecycle='disconnected';}
  private async cleanupUntrustedCandidate(candidate:unknown):Promise<boolean>{try{await this.backend.cleanupFailedConnection(candidate);return true;}catch{this.failClosed();return false;}}
  private async cleanupCandidate(candidate:Readonly<RemoteSessionConnection>):Promise<boolean>{try{await this.backend.disconnect(candidate);return true;}catch{this.failClosed();return false;}}
  private failClosed():void{this.connection=undefined;this.discoveredCapabilities=[];this.lifecycle='failed';}
  private currentAuthority():RemoteSessionAuthority{const c=this.requireConnection();return{endpointId:this.endpoint.endpointId,remoteHostId:c.remoteHostId,sessionId:c.sessionId,generation:this.generation};}
  private surfaceFor(connection:Readonly<RemoteSessionConnection>,generation:number):Readonly<ComputerSurfaceRef>{return Object.freeze({adapterId:this.adapterId,environment:'remote-session',surfaceId:connection.sessionId,generation,parentSurfaceId:connection.remoteHostId});}
  private surfaceRef():ComputerSurfaceRef{const c=this.requireConnection();return this.surfaceFor(c,this.generation);}
  private observationLease():ObservationLease{const connection=this.requireConnection(),generation=this.generation;return Object.freeze({connection,generation,surface:this.surfaceFor(connection,generation)});}
  private assertObservationLease(lease:ObservationLease):void{if(this.lifecycle!=='connected'||this.connection!==lease.connection||this.generation!==lease.generation)throw new Error('remote observation lifecycle changed');}
  private requireConnection():Readonly<RemoteSessionConnection>{if(!this.connection||this.lifecycle!=='connected')throw new Error('remote session is not connected');return this.connection;}
  private assertRequestAdapter(adapterId:string):void{if(adapterId!==this.adapterId)throw new Error('remote adapter mismatch');}
  private assertSurfaceAuthority(surface:ComputerSurfaceRef|undefined,current:Readonly<ComputerSurfaceRef>=this.surfaceRef()):void{if(!surface)return;if(surface.adapterId!==current.adapterId||surface.environment!==current.environment||surface.surfaceId!==current.surfaceId||surface.generation!==current.generation||surface.parentSurfaceId!==current.parentSurfaceId)throw new Error('stale or mismatched remote surface');}
  private authorityError(authority:RemoteSessionAuthority):string|undefined{const current=this.currentAuthority();if(authority.endpointId!==current.endpointId||authority.remoteHostId!==current.remoteHostId)return'remote-host-mismatch';if(authority.sessionId!==current.sessionId)return'remote-session-replaced';if(authority.generation!==current.generation)return'remote-session-stale-generation';return undefined;}
  private reject(evidence:string):ComputerActionResult{return{status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:[evidence]};}
  private unsupported(evidence:string):ComputerActionResult{return{status:'unsupported',dispatch:'not-dispatched',verification:'unverified',evidence:[evidence]};}
  private transportFailure(error:unknown):ComputerActionResult{if(error instanceof RemoteDispatchError&&error.dispatch==='not-dispatched')return{status:'failed',dispatch:'not-dispatched',verification:'unverified',evidence:[safeEvidenceCode(error.evidence)]};const evidence=error instanceof RemoteDispatchError?safeEvidenceCode(error.evidence):'remote-transport-failure-ambiguous';return{status:'unknown',dispatch:'unknown',verification:'unverified',evidence:[evidence]};}
  private fromDispatch<T>(rawResult:unknown,snapshotValue?:(value:unknown)=>T|undefined):ComputerActionResult{const result=snapshotDispatchOutcome<T>(rawResult,snapshotValue);if(!result)return{status:'unknown',dispatch:'unknown',verification:'unverified',evidence:['remote-backend-outcome-invalid']};if(result.dispatch==='not-dispatched')return{status:'failed',dispatch:'not-dispatched',verification:'unverified',evidence:[safeEvidenceCode(result.evidence)]};if(result.dispatch==='unknown')return{status:'unknown',dispatch:'unknown',verification:'unverified',evidence:[safeEvidenceCode(result.evidence)]};return{status:'completed',dispatch:'dispatched-once',verification:'not-applicable',evidence:result.evidence?[safeEvidenceCode(result.evidence)]:undefined,details:result.value};}
}
