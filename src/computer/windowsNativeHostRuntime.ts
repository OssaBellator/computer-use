import { DesktopInteractionLeaseManager } from './desktopInteractionLease.js';
import { WindowsComApartmentExecutor } from './windowsComApartment.js';
import { WindowsGraphicsCaptureRuntime } from './windowsGraphicsCaptureRuntime.js';
import { WindowsInteractiveHostLeaseService } from './windowsInteractiveHostLease.js';
import { WindowsNativeHostCaptureBridge, WindowsNativeHostCredentialBroker, WindowsNativeHostIntegrityReader, WindowsNativeHostSendInputBridge, WindowsNativeHostUiaClient } from './windowsNativeHostAdapters.js';
import { WindowsNativeHostComApartmentHost } from './windowsNativeHostComApartment.js';
import { WindowsNativeHostHumanInputObserver } from './windowsNativeHostHumanInput.js';
import { WINDOWS_NATIVE_HOST_OPERATIONS, WindowsNativeHostProtocolClient, type WindowsNativeHostOperation, type WindowsNativeHostRequestIdSource } from './windowsNativeHostProtocol.js';
import { WindowsNativeHostStdioTransport } from './windowsNativeHostStdioTransport.js';
import { WindowsNativeHostSystemObserver } from './windowsNativeHostSystem.js';
import { WindowsNativeHostUiaEventBridge } from './windowsNativeHostUiaEventBridge.js';
import { WindowsNativeHostWindowAuthority } from './windowsNativeHostWindowAuthority.js';
import type { WindowsProviderCapabilityProfile, WindowsProviderCapabilityState, WindowsProviderCapabilitySupport } from './windowsProviderCapabilities.js';
import { WindowsUiaEventRouter } from './windowsUiaEventRouter.js';
import { WindowsUiaMtaBridge } from './windowsUiaMtaBridge.js';
import { WindowsUiaProviderRuntime } from './windowsUiaProviderRuntime.js';
import { WindowsRetainedGraphicsCaptureRuntime, WindowsVisualArtifactRetentionManager } from './windowsVisualArtifactRetention.js';
import { WindowsAuthenticationFactorMediator, type WindowsAuthenticationFactorBroker } from './windowsAuthenticationFactorMediator.js';
import { WindowsCredentialMediator, type WindowsCredentialBroker } from './windowsCredentialMediator.js';
import { WindowsRetainedVisualGroundingRuntime, WindowsVisualGroundingProvider, type WindowsVisualGroundingBackend } from './windowsVisualGroundingProvider.js';

const VALID_OPERATIONS=new Set<WindowsNativeHostOperation>(WINDOWS_NATIVE_HOST_OPERATIONS);

class SequentialWindowsNativeHostRequestIds implements WindowsNativeHostRequestIdSource {
  private sequence=0;
  next():string {
    this.sequence+=1;
    if(!Number.isSafeInteger(this.sequence))throw new Error('windows-native-host-request-id-exhausted');
    return `host-${this.sequence.toString(36)}`;
  }
}

function capability(support:WindowsProviderCapabilitySupport,reason?:string):WindowsProviderCapabilitySupport|WindowsProviderCapabilityState {
  // A reason explains degraded/unavailable support. Never attach an unavailable
  // explanation to a capability that the live handshake proves is supported.
  return reason===undefined||support==='supported'?support:Object.freeze({support,reason});
}
function has(implemented:ReadonlySet<WindowsNativeHostOperation>,...operations:WindowsNativeHostOperation[]):boolean {
  return operations.every(operation=>implemented.has(operation));
}
function captureOperations(values:readonly string[]):readonly WindowsNativeHostOperation[]{
  const seen=new Set<WindowsNativeHostOperation>();
  const result:WindowsNativeHostOperation[]=[];
  for(const value of values){
    if(!VALID_OPERATIONS.has(value as WindowsNativeHostOperation))continue;
    const operation=value as WindowsNativeHostOperation;
    if(seen.has(operation))continue;
    seen.add(operation);
    result.push(operation);
  }
  return Object.freeze(result);
}

export function deriveWindowsNativeHostCapabilityProfile(
  operations:readonly WindowsNativeHostOperation[],
):WindowsProviderCapabilityProfile {
  const implemented=new Set(captureOperations(operations));
  const uiaObserve=has(implemented,'uia.resolve-window','uia.build-cache','uia.resolve-control','uia.compare-elements','uia.snapshot-control');
  const uiaAct=has(implemented,'uia.perform-pattern');
  const modal=has(implemented,'uia.window-states');
  const input=has(implemented,'input.send');
  const integrity=has(implemented,'integrity.current','integrity.process');
  const capture=has(implemented,'capture.next-frame','artifact.release');
  const human=has(implemented,'input.human-sequence');
  const foregroundLease=has(implemented,'system.windows')&&input&&human;
  const credentialRevalidation=has(implemented,'uia.resolve-control','uia.compare-elements','uia.snapshot-control');
  const credentialNative=credentialRevalidation&&implemented.has('credential.apply');
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
      'window-modal-authority':capability(uiaObserve&&modal?'supported':uiaObserve?'partial':'unsupported',uiaObserve&&modal?undefined:'native modal/window-state observation unavailable'),
      'wgc-hwnd-capture':capability(capture?'supported':'unsupported','native Windows.Graphics.Capture unavailable in this host/session'),
      'visual-frame-binding':capability(capture?'supported':'partial','frame/generation validation exists without a live native capture producer'),
      'visual-grounding':capability(capture?'partial':'unsupported','capture is available but a production grounding provider remains separate'),
      'keyboard-input':capability(input?'supported':'unsupported'),
      'pointer-input':capability(input?'supported':'unsupported'),
      'input-integrity-gating':capability(integrity&&input?'supported':'unsupported'),
      'foreground-interaction-lease':capability(foregroundLease?'supported':'unsupported',foregroundLease?undefined:'exact foreground observation + human monitor + guarded native input unavailable'),
      'human-interference-detection':capability(human?'supported':'unsupported','native non-injected input monitor is unavailable'),
      'transient-capture-retention':capability(capture?'supported':'unsupported','no live native artifact producer exists in this host/session'),
      'side-effect-verification':capability('partial','verification runtime exists; an authoritative action-specific observation predicate remains caller-supplied'),
      'credential-brokered-use':capability(credentialNative?'supported':credentialRevalidation?'partial':'unsupported',credentialNative?undefined:credentialRevalidation?'password-field revalidation exists but no trusted credential application verb is available':'UIA password-field revalidation surface unavailable'),
      'authentication-factor-brokered-use':capability('unsupported','no trusted authentication factor broker is attached to this runtime'),
    }),
  });
}

function composeCapabilityProfile(
  operations:readonly WindowsNativeHostOperation[],
  visualGrounding:boolean,
  credentialBroker:boolean,
  authenticationFactorBroker:boolean,
):WindowsProviderCapabilityProfile {
  const base=deriveWindowsNativeHostCapabilityProfile(operations);
  const implemented=new Set(operations);
  const capabilities={...base.capabilities};
  if(visualGrounding&&implemented.has('artifact.consume'))capabilities['visual-grounding']='supported';
  if(credentialBroker&&has(implemented,'uia.resolve-control','uia.compare-elements','uia.snapshot-control')){
    capabilities['credential-brokered-use']='supported';
  }
  if(authenticationFactorBroker)capabilities['authentication-factor-brokered-use']='supported';
  return Object.freeze({id:base.id,capabilities:Object.freeze(capabilities)});
}

export interface WindowsNativeHostRuntime {
  readonly protocol:WindowsNativeHostProtocolClient;
  readonly apartment:WindowsComApartmentExecutor;
  readonly uia:WindowsUiaProviderRuntime;
  readonly events:WindowsUiaEventRouter;
  readonly system:WindowsNativeHostSystemObserver;
  readonly windowAuthority?:WindowsNativeHostWindowAuthority;
  readonly integrity:WindowsNativeHostIntegrityReader;
  readonly input:WindowsNativeHostSendInputBridge;
  readonly humanInput?:WindowsNativeHostHumanInputObserver;
  readonly leases?:DesktopInteractionLeaseManager;
  readonly interactiveLeases?:WindowsInteractiveHostLeaseService;
  readonly capture?:WindowsGraphicsCaptureRuntime;
  readonly retention?:WindowsVisualArtifactRetentionManager;
  readonly retainedCapture?:WindowsRetainedGraphicsCaptureRuntime;
  readonly visualGrounding?:WindowsVisualGroundingProvider;
  readonly retainedVisualGrounding?:WindowsRetainedVisualGroundingRuntime;
  readonly credentials?:WindowsCredentialMediator;
  readonly authenticationFactors?:WindowsAuthenticationFactorMediator;
  readonly capabilities:WindowsProviderCapabilityProfile;
  /** Immutable snapshot from hello. Reserved protocol verbs are not implied supported. */
  readonly implementedOperations:readonly WindowsNativeHostOperation[];
  close():Promise<void>;
}

export interface WindowsNativeHostRuntimeOptions {
  readonly maxMessageBytes?:number;
  readonly cwd?:string;
  readonly eventPollIntervalMs?:number;
  readonly visualGroundingBackend?:WindowsVisualGroundingBackend;
  /** Trusted secret-owning boundary. Computer-use receives opaque refs only. */
  readonly credentialBroker?:WindowsCredentialBroker;
  /** Trusted factor-owning boundary. Factor material never enters computer-use. */
  readonly authenticationFactorBroker?:WindowsAuthenticationFactorBroker;
}

/**
 * Opens the production Windows native sidecar and composes its validated semantic,
 * input, and optional visual services into one runtime. Capability support is
 * derived from the host's hello handshake rather than assumed from reserved verbs.
 */
export async function openWindowsNativeHostRuntime(
  executablePath:string,
  options?:WindowsNativeHostRuntimeOptions,
):Promise<WindowsNativeHostRuntime>{
  const spawnOptions={
    ...(options?.maxMessageBytes!==undefined?{maxMessageBytes:options.maxMessageBytes}:{}),
    ...(options?.cwd!==undefined?{cwd:options.cwd}:{}),
  };
  const transport=WindowsNativeHostStdioTransport.spawn(executablePath,spawnOptions);
  const protocol=new WindowsNativeHostProtocolClient(transport,new SequentialWindowsNativeHostRequestIds());
  try{
    const host=await WindowsNativeHostComApartmentHost.create(protocol);
    const apartment=new WindowsComApartmentExecutor(host);
    const implemented=captureOperations(host.implementedOperations);
    const implementedSet=new Set(implemented);
    const nativeUia=new WindowsNativeHostUiaClient(protocol);
    const bridge=new WindowsUiaMtaBridge(apartment,nativeUia);
    const uia=new WindowsUiaProviderRuntime(bridge);
    const eventBridge=new WindowsNativeHostUiaEventBridge(protocol,host.threadToken,options?.eventPollIntervalMs??50);
    const events=new WindowsUiaEventRouter(eventBridge,uia);
    const system=new WindowsNativeHostSystemObserver(protocol);
    const windowAuthority=implementedSet.has('uia.window-states')?new WindowsNativeHostWindowAuthority(protocol):undefined;
    const integrity=new WindowsNativeHostIntegrityReader(protocol);
    const input=new WindowsNativeHostSendInputBridge(protocol);

    const humanInput=implementedSet.has('input.human-sequence')?new WindowsNativeHostHumanInputObserver(protocol):undefined;
    const leases=humanInput?new DesktopInteractionLeaseManager(humanInput):undefined;
    const interactiveLeases=leases&&implementedSet.has('system.windows')&&implementedSet.has('input.send')
      ?new WindowsInteractiveHostLeaseService(system,leases)
      :undefined;

    let capture:WindowsGraphicsCaptureRuntime|undefined;
    let retention:WindowsVisualArtifactRetentionManager|undefined;
    let retainedCapture:WindowsRetainedGraphicsCaptureRuntime|undefined;
    if(implementedSet.has('capture.next-frame')&&implementedSet.has('artifact.release')){
      const captureBridge=new WindowsNativeHostCaptureBridge(protocol);
      capture=new WindowsGraphicsCaptureRuntime(captureBridge);
      retention=new WindowsVisualArtifactRetentionManager(captureBridge);
      retainedCapture=new WindowsRetainedGraphicsCaptureRuntime(capture,retention);
    }
    const visualGrounding=capture&&options?.visualGroundingBackend
      ?new WindowsVisualGroundingProvider(options.visualGroundingBackend)
      :undefined;
    const retainedVisualGrounding=visualGrounding&&retention&&implementedSet.has('artifact.consume')
      ?new WindowsRetainedVisualGroundingRuntime(visualGrounding,retention)
      :undefined;
    const credentialBroker=options?.credentialBroker??(implementedSet.has('credential.apply')?new WindowsNativeHostCredentialBroker(protocol,host.threadToken):undefined);
    const credentialRevalidation=has(implementedSet,'uia.resolve-control','uia.compare-elements','uia.snapshot-control');
    const credentials=credentialBroker&&credentialRevalidation
      ?new WindowsCredentialMediator(uia,credentialBroker)
      :undefined;
    const authenticationFactors=options?.authenticationFactorBroker
      ?new WindowsAuthenticationFactorMediator(options.authenticationFactorBroker)
      :undefined;

    let closed=false;
    return Object.freeze({
      protocol,apartment,uia,events,system,
      ...(windowAuthority?{windowAuthority}:{}),
      integrity,input,
      ...(humanInput?{humanInput}:{}),
      ...(leases?{leases}:{}),
      ...(interactiveLeases?{interactiveLeases}:{}),
      ...(capture?{capture}:{}),
      ...(retention?{retention}:{}),
      ...(retainedCapture?{retainedCapture}:{}),
      ...(visualGrounding?{visualGrounding}:{}),
      ...(retainedVisualGrounding?{retainedVisualGrounding}:{}),
      ...(credentials?{credentials}:{}),
      ...(authenticationFactors?{authenticationFactors}:{}),
      capabilities:composeCapabilityProfile(implemented,retainedVisualGrounding!==undefined,credentials!==undefined,authenticationFactors!==undefined),
      implementedOperations:implemented,
      close:async()=>{
        if(closed)return;
        closed=true;
        leases?.releaseAll();
        if(retention)await retention.releaseAll().catch(()=>undefined);
        await apartment.dispose();
      },
    });
  }catch(error){
    await protocol.close().catch(()=>undefined);
    throw error;
  }
}
