import type { WindowsComApartmentContext, WindowsComApartmentHost } from './windowsComApartment.js';
import { WINDOWS_NATIVE_HOST_OPERATIONS, WindowsNativeHostProtocolClient, type WindowsNativeHostOperation } from './windowsNativeHostProtocol.js';

const TOKEN_PATTERN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;

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
function captureOperations(value:unknown):readonly WindowsNativeHostOperation[]|undefined {
  if(!Array.isArray(value))return undefined;
  try{
    if(Object.getPrototypeOf(value)!==Array.prototype||value.length>WINDOWS_NATIVE_HOST_OPERATIONS.length)return undefined;
    const result:WindowsNativeHostOperation[]=[];
    for(let index=0;index<value.length;index+=1){
      const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
      if(!descriptor||!('value' in descriptor)||descriptor.get!==undefined||descriptor.set!==undefined||!descriptor.enumerable)return undefined;
      if(typeof descriptor.value!=='string'||!WINDOWS_NATIVE_HOST_OPERATIONS.includes(descriptor.value as WindowsNativeHostOperation)||result.includes(descriptor.value as WindowsNativeHostOperation))return undefined;
      result.push(descriptor.value as WindowsNativeHostOperation);
    }
    return Object.freeze(result);
  }catch{return undefined;}
}

/**
 * `WindowsComApartmentExecutor` owns serialization on the TypeScript side; this
 * host supplies the stable native MTA token established by the sidecar's hello
 * handshake. UIA operations then carry that token into every protocol request.
 */
export class WindowsNativeHostComApartmentHost implements WindowsComApartmentHost {
  readonly apartment='mta' as const;
  private closed=false;

  private constructor(
    readonly protocol:WindowsNativeHostProtocolClient,
    readonly threadToken:string,
    readonly implementedOperations:readonly WindowsNativeHostOperation[],
  ) {}

  static async create(protocol:WindowsNativeHostProtocolClient):Promise<WindowsNativeHostComApartmentHost> {
    const raw=captureOwnDataObject(await protocol.call('hello',Object.freeze({requestedApartment:'mta'})),['apartment','threadToken','implementedOperations']);
    const implemented=raw?captureOperations(raw.implementedOperations):undefined;
    if(!raw||raw.apartment!=='mta'||typeof raw.threadToken!=='string'||!TOKEN_PATTERN.test(raw.threadToken)||!implemented||!implemented.includes('hello')){
      throw new Error('windows-native-host-hello-invalid');
    }
    return new WindowsNativeHostComApartmentHost(protocol,raw.threadToken,implemented);
  }

  supports(operation:WindowsNativeHostOperation):boolean {
    return this.implementedOperations.includes(operation);
  }

  async run<T>(operation:(context:WindowsComApartmentContext)=>Promise<T>):Promise<T>{
    if(this.closed)throw new Error('windows-native-host-apartment-closed');
    return operation(Object.freeze({apartment:'mta',threadToken:this.threadToken}));
  }

  async dispose():Promise<void>{
    if(this.closed)return;
    this.closed=true;
    await this.protocol.close();
  }
}
