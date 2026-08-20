import { ContractCheckedDesktopPlatformBridge } from './nativeDesktopHelperContract.js';
import type { DesktopBridgeExecutor } from './nativeDesktopJsonBridge.js';
import {
  StdioDesktopBridgeExecutor,
  snapshotNativeDesktopStdioCommand,
  type NativeDesktopStdioCommand,
  type NativeDesktopStdioCommandSnapshot,
} from './nativeDesktopStdioExecutor.js';

function options(command:NativeDesktopStdioCommandSnapshot) {
  return Object.freeze({
    supportsRelativePointer:command.supportsRelativePointer,
    maxResponseBytes:command.maxResponseBytes,
    timeoutMs:command.timeoutMs,
  });
}

function productionBridge(
  id:string,
  platform:'windows-uia'|'macos-accessibility'|'linux-atspi',
  command:NativeDesktopStdioCommand,
  executor?:DesktopBridgeExecutor,
) {
  const snapshot = snapshotNativeDesktopStdioCommand(command);
  const selectedExecutor = executor ?? new StdioDesktopBridgeExecutor(command);
  return new ContractCheckedDesktopPlatformBridge(id,platform,selectedExecutor,options(snapshot));
}

/** Preferred production factory for a Windows UI Automation native helper. */
export function productionWindowsUiAutomationBridge(command:NativeDesktopStdioCommand,executor?:DesktopBridgeExecutor) {
  return productionBridge('windows-uia','windows-uia',command,executor);
}

/** Normal Accessibility/Screen Recording permission remains host policy. */
export function productionMacOsAccessibilityBridge(command:NativeDesktopStdioCommand,executor?:DesktopBridgeExecutor) {
  return productionBridge('macos-accessibility','macos-accessibility',command,executor);
}

/** Wayland/X11/portal input and capture authority remains helper/host policy. */
export function productionLinuxAtSpiBridge(command:NativeDesktopStdioCommand,executor?:DesktopBridgeExecutor) {
  return productionBridge('linux-atspi','linux-atspi',command,executor);
}
