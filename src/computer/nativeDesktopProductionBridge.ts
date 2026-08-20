import { ContractCheckedDesktopPlatformBridge } from './nativeDesktopHelperContract.js';
import type { DesktopBridgeExecutor } from './nativeDesktopJsonBridge.js';
import { StdioDesktopBridgeExecutor, type NativeDesktopStdioCommand } from './nativeDesktopStdioExecutor.js';

function options(command: NativeDesktopStdioCommand) {
  return Object.freeze({
    supportsRelativePointer: command.supportsRelativePointer === true,
    maxResponseBytes: command.maxResponseBytes,
    timeoutMs: command.timeoutMs,
  });
}

/**
 * Preferred production factory for a Windows UI Automation native helper.
 * Defaults to stdin request transport and helper contract checking.
 */
export function productionWindowsUiAutomationBridge(
  command: NativeDesktopStdioCommand,
  executor: DesktopBridgeExecutor = new StdioDesktopBridgeExecutor(command),
) {
  return new ContractCheckedDesktopPlatformBridge('windows-uia', 'windows-uia', executor, options(command));
}

/**
 * Preferred production factory for a macOS Accessibility native helper.
 * Normal Accessibility/Screen Recording permission remains host policy.
 */
export function productionMacOsAccessibilityBridge(
  command: NativeDesktopStdioCommand,
  executor: DesktopBridgeExecutor = new StdioDesktopBridgeExecutor(command),
) {
  return new ContractCheckedDesktopPlatformBridge('macos-accessibility', 'macos-accessibility', executor, options(command));
}

/**
 * Preferred production factory for a Linux AT-SPI/native desktop helper.
 * Wayland/X11/portal input and capture authority remains helper/host policy.
 */
export function productionLinuxAtSpiBridge(
  command: NativeDesktopStdioCommand,
  executor: DesktopBridgeExecutor = new StdioDesktopBridgeExecutor(command),
) {
  return new ContractCheckedDesktopPlatformBridge('linux-atspi', 'linux-atspi', executor, options(command));
}
