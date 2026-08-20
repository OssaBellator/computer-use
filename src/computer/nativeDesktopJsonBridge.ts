import { execFile } from 'node:child_process';
import type { ComputerEffectClass, ComputerObservationLimits } from './environmentAdapter.js';
import type { DesktopBackendActionResult, DesktopVisualAcquisitionLimits } from './desktopUiBackend.js';
import type {
  DesktopPlatformBridge,
  DesktopPlatformKind,
  PlatformDesktopAccessibilityObservation,
  PlatformDesktopDispatch,
  PlatformDesktopVisualObservation,
  PlatformDesktopWindow,
} from './desktopPlatformBackend.js';

const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface NativeDesktopBridgeCommand {
  executable:string;
  args?:readonly string[];
  env?:Readonly<Record<string,string>>;
  maxResponseBytes?:number;
  timeoutMs?:number;
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

function asObject(value:unknown):Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('native desktop bridge returned non-object');
  return value as Record<string,unknown>;
}
function windowsResult(value:unknown):{windows:readonly PlatformDesktopWindow[];truncated:boolean;focusedControlNativeId?:string} {
  const object = asObject(value);
  if (!Array.isArray(object.windows) || typeof object.truncated !== 'boolean') throw new Error('native desktop window response malformed');
  return Object.freeze({windows:Object.freeze(object.windows as PlatformDesktopWindow[]),truncated:object.truncated,...(typeof object.focusedControlNativeId === 'string' ? {focusedControlNativeId:object.focusedControlNativeId} : {})});
}

/**
 * Rigorously testable production bridge boundary. The native helper owns the
 * platform call and MUST enforce instance-token freshness inside the same native
 * critical section as input dispatch. Helper exceptions after possible emission
 * deliberately propagate; the neutral adapter will classify dispatch unknown.
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
    return windowsResult(await this.invoke('enumerate-windows',{limits:{...limits}}));
  }
  async accessibility(window:PlatformDesktopWindow,limits:Required<ComputerObservationLimits>):Promise<PlatformDesktopAccessibilityObservation> {
    return asObject(await this.invoke('accessibility',{window:{nativeId:window.nativeId,instanceToken:window.instanceToken},limits:{...limits}})) as unknown as PlatformDesktopAccessibilityObservation;
  }
  async visual(window:PlatformDesktopWindow,limits:DesktopVisualAcquisitionLimits):Promise<PlatformDesktopVisualObservation> {
    return asObject(await this.invoke('visual',{window:{nativeId:window.nativeId,instanceToken:window.instanceToken},limits:{...limits}})) as unknown as PlatformDesktopVisualObservation;
  }
  async dispatch(action:PlatformDesktopDispatch,effect:ComputerEffectClass):Promise<DesktopBackendActionResult> {
    return asObject(await this.invoke('dispatch',{action,effect})) as unknown as DesktopBackendActionResult;
  }
}

export function windowsUiAutomationBridge(command:NativeDesktopBridgeCommand,executor:DesktopBridgeExecutor=new JsonProcessDesktopBridgeExecutor(command)) {
  return new NativeJsonDesktopPlatformBridge('windows-uia','windows-uia',executor,{supportsRelativePointer:true,maxResponseBytes:command.maxResponseBytes,timeoutMs:command.timeoutMs});
}
export function macOsAccessibilityBridge(command:NativeDesktopBridgeCommand,executor:DesktopBridgeExecutor=new JsonProcessDesktopBridgeExecutor(command)) {
  return new NativeJsonDesktopPlatformBridge('macos-accessibility','macos-accessibility',executor,{supportsRelativePointer:true,maxResponseBytes:command.maxResponseBytes,timeoutMs:command.timeoutMs});
}
export function linuxAtSpiBridge(command:NativeDesktopBridgeCommand,executor:DesktopBridgeExecutor=new JsonProcessDesktopBridgeExecutor(command)) {
  return new NativeJsonDesktopPlatformBridge('linux-atspi','linux-atspi',executor,{supportsRelativePointer:true,maxResponseBytes:command.maxResponseBytes,timeoutMs:command.timeoutMs});
}
