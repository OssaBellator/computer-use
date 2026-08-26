export const WINDOWS_NATIVE_HOST_PROTOCOL_VERSION = 1 as const;

export const WINDOWS_NATIVE_HOST_OPERATIONS = [
  'hello',
  'uia.resolve-window',
  'uia.build-cache',
  'uia.resolve-control',
  'uia.compare-elements',
  'uia.snapshot-control',
  'uia.perform-pattern',
  'capture.next-frame',
  'artifact.release',
  'integrity.current',
  'integrity.process',
  'input.send',
] as const;
export type WindowsNativeHostOperation = typeof WINDOWS_NATIVE_HOST_OPERATIONS[number];

export interface WindowsNativeHostRequest {
  readonly protocol:typeof WINDOWS_NATIVE_HOST_PROTOCOL_VERSION;
  readonly id:string;
  readonly operation:WindowsNativeHostOperation;
  readonly body:unknown;
}
export type WindowsNativeHostResponse =
  | {readonly protocol:typeof WINDOWS_NATIVE_HOST_PROTOCOL_VERSION;readonly id:string;readonly status:'ok';readonly body:unknown}
  | {readonly protocol:typeof WINDOWS_NATIVE_HOST_PROTOCOL_VERSION;readonly id:string;readonly status:'error';readonly error:string};

export interface WindowsNativeHostTransport {
  /** Hard transport-level message bound, including framing overhead. */
  readonly maxMessageBytes:number;
  exchange(request:WindowsNativeHostRequest):Promise<unknown>;
  close():Promise<void>;
}
export interface WindowsNativeHostRequestIdSource { next():string; }

const MAX_MESSAGE_BYTES=1_048_576;
const ID_PATTERN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const ERROR_PATTERN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;

function captureOwnDataObject(value:unknown,allowed:readonly string[]):Readonly<Record<string,unknown>>|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  try{
    const prototype=Object.getPrototypeOf(value);
    if(prototype!==Object.prototype&&prototype!==null)return undefined;
    const captured:Record<string,unknown>=Object.create(null);
    for(const key of allowed){
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(descriptor===undefined)continue;
      if(!('value' in descriptor)||descriptor.get!==undefined||descriptor.set!==undefined||!descriptor.enumerable)return undefined;
      captured[key]=descriptor.value;
    }
    return Object.freeze(captured);
  }catch{return undefined;}
}

export class WindowsNativeHostError extends Error {
  constructor(readonly code:string){super(code);this.name='WindowsNativeHostError';}
}

/**
 * Correlates each request to exactly one bounded native-host response. The host
 * protocol intentionally contains no shell/command operation; only typed UIA,
 * capture, integrity, artifact, and SendInput primitives cross this boundary.
 */
export class WindowsNativeHostProtocolClient {
  private closed=false;
  constructor(readonly transport:WindowsNativeHostTransport,readonly ids:WindowsNativeHostRequestIdSource){
    if(!Number.isSafeInteger(transport.maxMessageBytes)||transport.maxMessageBytes<1||transport.maxMessageBytes>MAX_MESSAGE_BYTES){
      throw new Error('windows-native-host-message-bound-invalid');
    }
  }

  async call(operation:WindowsNativeHostOperation,body:unknown):Promise<unknown>{
    if(this.closed)throw new Error('windows-native-host-closed');
    if(!WINDOWS_NATIVE_HOST_OPERATIONS.includes(operation))throw new Error('windows-native-host-operation-invalid');
    const id=this.ids.next();
    if(!ID_PATTERN.test(id))throw new Error('windows-native-host-request-id-invalid');
    const request=Object.freeze({protocol:WINDOWS_NATIVE_HOST_PROTOCOL_VERSION,id,operation,body});
    const responseRaw=await this.transport.exchange(request);
    const response=captureOwnDataObject(responseRaw,['protocol','id','status','body','error']);
    if(!response||response.protocol!==WINDOWS_NATIVE_HOST_PROTOCOL_VERSION||response.id!==id||
        (response.status!=='ok'&&response.status!=='error')){
      throw new Error('windows-native-host-response-invalid');
    }
    if(response.status==='error'){
      if(typeof response.error!=='string'||!ERROR_PATTERN.test(response.error))throw new Error('windows-native-host-error-invalid');
      throw new WindowsNativeHostError(response.error);
    }
    if(!Object.prototype.hasOwnProperty.call(response,'body'))throw new Error('windows-native-host-response-body-missing');
    return response.body;
  }

  async close():Promise<void>{
    if(this.closed)return;
    this.closed=true;
    await this.transport.close();
  }
}
