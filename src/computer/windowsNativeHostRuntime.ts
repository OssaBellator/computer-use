import { WindowsComApartmentExecutor } from './windowsComApartment.js';
import { WindowsNativeHostIntegrityReader, WindowsNativeHostSendInputBridge, WindowsNativeHostUiaClient } from './windowsNativeHostAdapters.js';
import { WindowsNativeHostComApartmentHost } from './windowsNativeHostComApartment.js';
import { WindowsNativeHostProtocolClient, type WindowsNativeHostOperation, type WindowsNativeHostRequestIdSource } from './windowsNativeHostProtocol.js';
import { WindowsNativeHostStdioTransport } from './windowsNativeHostStdioTransport.js';
import { WindowsNativeHostSystemObserver } from './windowsNativeHostSystem.js';
import { WindowsNativeHostUiaEventBridge } from './windowsNativeHostUiaEventBridge.js';
import type { WindowsProviderCapabilityProfile, WindowsProviderCapabilitySupport } from './windowsProviderCapabilities.js';
import { WindowsUiaEventRouter } from './windowsUiaEventRouter.js';
import { WindowsUiaMtaBridge } from './windowsUiaMtaBridge.js';
import { WindowsUiaProviderRuntime } from './windowsUiaProviderRuntime.js';

const IMPLEMENTED_OPERATION_SET = new Set<WindowsNativeHostOperation>();

class SequentialWindowsNativeHostRequestIds implements WindowsNativeHostRequestIdSource {
  private sequence=0;
  next():string {
    this.sequence+=1;
    if(!Number.isSafeInteger(this.sequence))throw new Error('windows-native-host-request-id-exhausted');
    return `host-${this.sequence.toString(36)}`;
  }
}

function capability(support:WindowsProviderCapabilitySupport,reason?:string){
  return reason===undefined?support:Object.freeze({support,reason});
}

function has(implemented:ReadonlySet<WindowsNativeHostOperation>,...operations:WindowsNativeHostOperation[]):boolean {
  return operations.every(operation=>implemented.has(operation));
}

function profile(implemented:ReadonlySet<WindowsNativeHostOperation>):WindowsProviderCapabilityProfile {
  const uiaObserve=has(implemented,'uia.resolve-window','uia.build-cache','uia.resolve-control','uia.compare-elements','uia.snapshot-control');
  const uiaAct=has(implemented,'uia.perform-pattern');
  const input=has(implemented,'input.send');
  const integrity=has(implemented,'integrity.current','integrity.process');
  const capture=has(implemented,'capture.next-frame','artifact.release');
  return Object.freeze({
    id:'windows-native-host',
    capabilities:Object.freeze({
      'uia-observation':capability(uiaObserve?'supported':'unsupported',uiaObserve?undefined:'native UIA observation operations unavailable'),
      'uia-invoke':capability(uiaAct?'supported':'unsupported'),
      'uia-value':capability(uiaAct?'supported':'unsupported'),
      'uia-toggle':capability(uiaAct?'supported':'unsupported'),
      'uia-selection-item':capability(uiaAct?'supported':'unsupported'),
      'uia-expand-collapse':capability(uiaAct?'supported':'unsupported'),
      'uia-scroll':capability(uiaAct?'supported':'unsupported'),
      'uia-range-value':capability(uiaAct?'supported':'unsupported'),
      'uia-window':capability(uiaAct?'supported':'unsupported'),
      'window-modal-authority':capability(uiaObserve?'partial':'unsupported','authority model exists; native modal snapshot composition remains incomplete'),
      'wgc-hwnd-capture':capability(capture?'supported':'unsupported','native Windows.Graphics.Capture is not implemented by this host build'),
      'visual-frame-binding':capability(capture?'supported':'partial','frame/generation validation exists without a native capture producer'),
      'visual-grounding':capability(capture?'partial':'unsupported','grounding runtime exists but requires native frame production'),
      'keyboard-input':capability(input?'supported':'unsupported'),
      'pointer-input':capability(input?'supported':'unsupported'),
      'input-integrity-gating':capability(integrity&&input?'supported':'unsupported'),
      'foreground-interaction-lease':capability(input?'partial':'unsupported','lease model exists; production foreground ownership acquisition is not yet composed here'),
      'human-interference-detection':capability(input?'partial':'unsupported','lease model exists; native human-input sequence observer is not yet exposed by the host'),
      'transient-capture-retention':capability(capture?'supported':'unsupported','no native artifact producer exists yet'),
      'side-effect-verification':capability('partial','verification remains a separate post-action observation/reconciliation layer'),
    }),
  });
}

export interface WindowsNativeHostRuntime {
  readonly protocol:WindowsNativeHostProtocolClient;
  readonly apartment:WindowsComApartmentExecutor;
  readonly uia:WindowsUiaProviderRuntime;
  readonly events:WindowsUiaEventRouter;
  readonly system:WindowsNativeHostSystemObserver;
  readonly integrity:WindowsNativeHostIntegrityReader;
  readonly input:WindowsNativeHostSendInputBridge;
  readonly capabilities:WindowsProviderCapabilityProfile;
  readonly implementedOperations:ReadonlySet<WindowsNativeHostOperation>;
  close():Promise<void>;
}

function captureOperations(values:readonly string[]):ReadonlySet<WindowsNativeHostOperation>{
  const result=new Set<WindowsNativeHostOperation>();
  for(const value of values){
    if(!IMPLEMENTED_OPERATION_SET.has(value as WindowsNativeHostOperation))continue;
    result.add(value as WindowsNativeHostOperation);
  }
  return result;
}

/**
 * Opens the production Windows native sidecar and composes its validated semantic
 * services into one runtime. Capability support is derived from the host's hello
 * handshake rather than assumed from protocol verbs that may only be reserved.
 */
export async function openWindowsNativeHostRuntime(
  executablePath:string,
  options?:{readonly maxMessageBytes?:number;readonly cwd?:string;readonly eventPollIntervalMs?:number},
):Promise<WindowsNativeHostRuntime>{
  const transport=WindowsNativeHostStdioTransport.spawn(executablePath,{maxMessageBytes:options?.maxMessageBytes,cwd:options?.cwd});
  const protocol=new WindowsNativeHostProtocolClient(transport,new SequentialWindowsNativeHostRequestIds());
  try{
    const host=await WindowsNativeHostComApartmentHost.create(protocol);
    const apartment=new WindowsComApartmentExecutor(host);
    const implemented=captureOperations(host.implementedOperations);
    const nativeUia=new WindowsNativeHostUiaClient(protocol);
    const bridge=new WindowsUiaMtaBridge(apartment,nativeUia);
    const uia=new WindowsUiaProviderRuntime(bridge);
    const eventBridge=new WindowsNativeHostUiaEventBridge(protocol,host.threadToken,options?.eventPollIntervalMs??50);
    const events=new WindowsUiaEventRouter(eventBridge,uia);
    const system=new WindowsNativeHostSystemObserver(protocol);
    const integrity=new WindowsNativeHostIntegrityReader(protocol);
    const input=new WindowsNativeHostSendInputBridge(protocol);
    let closed=false;
    return Object.freeze({
      protocol,apartment,uia,events,system,integrity,input,
      capabilities:profile(implemented),
      implementedOperations:implemented,
      close:async()=>{
        if(closed)return;
        closed=true;
        await apartment.dispose();
      },
    });
  }catch(error){
    await protocol.close().catch(()=>undefined);
    throw error;
  }
}

// Filled after module initialization so the set stays tied to the protocol type.
for(const operation of [
  'hello','system.windows','system.virtual-desktop','uia.resolve-window','uia.build-cache','uia.resolve-control',
  'uia.compare-elements','uia.snapshot-control','uia.perform-pattern','uia.events.register','uia.events.unregister',
  'uia.events.poll','capture.next-frame','artifact.release','integrity.current','integrity.process','input.send',
] as const satisfies readonly WindowsNativeHostOperation[]){
  IMPLEMENTED_OPERATION_SET.add(operation);
}
