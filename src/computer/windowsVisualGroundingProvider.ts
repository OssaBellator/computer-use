import { TextEncoder } from 'node:util';
import type { WindowsGraphicsCaptureObservation } from './windowsGraphicsCaptureRuntime.js';
import type { WindowsRetainedGraphicsCapture, WindowsVisualArtifactRetentionManager } from './windowsVisualArtifactRetention.js';
import type { WindowsVisualFrameRef, WindowsVisualPointBinding } from './windowsVisualFrame.js';

const MAX_QUERY_BYTES=8_192;
const MAX_CANDIDATES=64;
const MAX_LABEL_BYTES=1_024;
const MAX_EVIDENCE=16;
const ID_PATTERN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const EVIDENCE_PATTERN=/^[a-z0-9][a-z0-9._:-]{0,191}$/i;
const encoder=new TextEncoder();

export interface WindowsVisualGroundingQuery {
  readonly id:string;
  readonly text:string;
  readonly maxCandidates:number;
}

export interface WindowsVisualGroundingBackendRequest {
  readonly artifact:WindowsGraphicsCaptureObservation['artifact'];
  readonly frame:WindowsVisualFrameRef;
  readonly query:WindowsVisualGroundingQuery;
  /** Ephemeral one-shot bytes. Backends must not retain or reinterpret them as identity. */
  readonly artifactBytes?:Uint8Array;
}

export interface WindowsVisualGroundingBackend {
  /**
   * Backend-specific implementation may dereference the artifact token inside the
   * capture trust boundary. It must not treat screenshot-derived labels/points as
   * durable control identity.
   */
  ground(request:WindowsVisualGroundingBackendRequest):Promise<unknown>;
}

export interface WindowsVisualGroundedRegion {
  readonly x:number;
  readonly y:number;
  readonly width:number;
  readonly height:number;
}

export interface WindowsVisualGroundedCandidate {
  readonly id:string;
  readonly confidence:number;
  readonly point:WindowsVisualPointBinding;
  readonly region?:WindowsVisualGroundedRegion;
  readonly label?:string;
  readonly evidence?:readonly string[];
}

function captureOwnDataObject(value:unknown,allowed:readonly string[]):Readonly<Record<string,unknown>>|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  try{
    const prototype=Object.getPrototypeOf(value);
    if(prototype!==Object.prototype&&prototype!==null)return undefined;
    const result:Record<string,unknown>=Object.create(null);
    for(const key of allowed){
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(descriptor===undefined)continue;
      if(!('value' in descriptor)||descriptor.get!==undefined||descriptor.set!==undefined||!descriptor.enumerable)return undefined;
      result[key]=descriptor.value;
    }
    return Object.freeze(result);
  }catch{return undefined;}
}
function captureArray(value:unknown,max:number):readonly unknown[]|undefined {
  if(!Array.isArray(value))return undefined;
  try{
    if(Object.getPrototypeOf(value)!==Array.prototype||value.length>max)return undefined;
    const result:unknown[]=[];
    for(let index=0;index<value.length;index+=1){
      const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
      if(!descriptor||!('value' in descriptor)||descriptor.get!==undefined||descriptor.set!==undefined||!descriptor.enumerable)return undefined;
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  }catch{return undefined;}
}
function boundedInt(value:unknown,min:number,max:number):value is number {
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
}
function confidence(value:unknown):value is number {
  return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
}
function captureEvidence(value:unknown):readonly string[]|undefined {
  if(value===undefined)return undefined;
  const values=captureArray(value,MAX_EVIDENCE);
  if(!values)return undefined;
  const result:string[]=[];
  for(const item of values){
    if(typeof item!=='string'||!EVIDENCE_PATTERN.test(item))return undefined;
    result.push(item);
  }
  return Object.freeze(result);
}
function sameFrame(raw:Readonly<Record<string,unknown>>,observation:WindowsGraphicsCaptureObservation):boolean {
  return raw.artifactToken===observation.artifact.token&&
    raw.captureGeneration===observation.frame.captureGeneration&&
    raw.frameSequence===observation.frame.frameSequence;
}

/**
 * Validates multimodal grounding as transient evidence for exactly one WGC frame.
 * The output intentionally contains only frame-bound points/regions, never a
 * stable semantic control reference.
 */
export class WindowsVisualGroundingProvider {
  constructor(readonly backend:WindowsVisualGroundingBackend) {}

  async ground(
    observation:WindowsGraphicsCaptureObservation,
    query:WindowsVisualGroundingQuery,
    artifactBytes?:Uint8Array,
  ):Promise<readonly WindowsVisualGroundedCandidate[]> {
    if(!ID_PATTERN.test(query.id)||query.text.includes('\0')||encoder.encode(query.text).byteLength<1||encoder.encode(query.text).byteLength>MAX_QUERY_BYTES||
       !boundedInt(query.maxCandidates,1,MAX_CANDIDATES)){
      throw new Error('windows-visual-grounding-query-invalid');
    }
    if(artifactBytes!==undefined&&artifactBytes.byteLength!==observation.artifact.byteLength){
      throw new Error('windows-visual-grounding-artifact-bytes-invalid');
    }
    const immutableQuery=Object.freeze({id:query.id,text:query.text,maxCandidates:query.maxCandidates});
    const request=Object.freeze({artifact:observation.artifact,frame:observation.frame,query:immutableQuery,...(artifactBytes?{artifactBytes}:{})});
    const response=captureOwnDataObject(await this.backend.ground(request),[
      'artifactToken','captureGeneration','frameSequence','candidates',
    ]);
    if(!response||!sameFrame(response,observation))throw new Error('windows-visual-grounding-frame-mismatch');
    const values=captureArray(response.candidates,query.maxCandidates);
    if(!values)throw new Error('windows-visual-grounding-response-invalid');

    const result:WindowsVisualGroundedCandidate[]=[];
    const seen=new Set<string>();
    for(const value of values){
      const raw=captureOwnDataObject(value,['id','confidence','x','y','region','label','evidence']);
      if(!raw||typeof raw.id!=='string'||!ID_PATTERN.test(raw.id)||seen.has(raw.id)||!confidence(raw.confidence)||
         !boundedInt(raw.x,0,observation.frame.contentWidth-1)||!boundedInt(raw.y,0,observation.frame.contentHeight-1)){
        throw new Error('windows-visual-grounding-response-invalid');
      }
      seen.add(raw.id);

      let region:WindowsVisualGroundedRegion|undefined;
      if(raw.region!==undefined){
        const box=captureOwnDataObject(raw.region,['x','y','width','height']);
        if(!box||!boundedInt(box.x,0,observation.frame.contentWidth-1)||!boundedInt(box.y,0,observation.frame.contentHeight-1)||
           !boundedInt(box.width,1,observation.frame.contentWidth)||!boundedInt(box.height,1,observation.frame.contentHeight)||
           box.x+box.width>observation.frame.contentWidth||box.y+box.height>observation.frame.contentHeight){
          throw new Error('windows-visual-grounding-response-invalid');
        }
        region=Object.freeze({x:box.x,y:box.y,width:box.width,height:box.height});
      }
      if(raw.label!==undefined&&(typeof raw.label!=='string'||raw.label.includes('\0')||encoder.encode(raw.label).byteLength>MAX_LABEL_BYTES)){
        throw new Error('windows-visual-grounding-response-invalid');
      }
      const evidence=captureEvidence(raw.evidence);
      if(raw.evidence!==undefined&&!evidence)throw new Error('windows-visual-grounding-response-invalid');

      result.push(Object.freeze({
        id:raw.id,
        confidence:raw.confidence,
        point:Object.freeze({frame:observation.frame,x:raw.x,y:raw.y}),
        ...(region?{region}:{}),
        ...(raw.label!==undefined?{label:raw.label}:{}),
        ...(evidence?{evidence}:{}),
      }));
    }
    return Object.freeze(result);
  }
}

/**
 * Production-safe grounding path for retained WGC artifacts. Consumption revokes
 * the screenshot lease/token before bytes reach the backend, and the local byte
 * buffer is zeroed after the grounding call returns or throws.
 */
export class WindowsRetainedVisualGroundingRuntime {
  constructor(
    readonly grounding:WindowsVisualGroundingProvider,
    readonly retention:WindowsVisualArtifactRetentionManager,
  ) {}

  async ground(
    retained:WindowsRetainedGraphicsCapture,
    query:WindowsVisualGroundingQuery,
    maxBytes=512*1024,
  ):Promise<readonly WindowsVisualGroundedCandidate[]> {
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>512*1024||retained.lease.byteLength>maxBytes){
      throw new Error('windows-visual-grounding-consume-limit');
    }
    const payload=await this.retention.consume(retained.lease,maxBytes);
    try{
      if(payload.mediaType!==(retained.observation.artifact.mediaType??'image/png')){
        throw new Error('windows-visual-grounding-media-type-mismatch');
      }
      return await this.grounding.ground(retained.observation,query,payload.bytes);
    }finally{
      payload.bytes.fill(0);
    }
  }
}
