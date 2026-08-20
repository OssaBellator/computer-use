import test from 'node:test';
import assert from 'node:assert/strict';
import {
  productionLinuxAtSpiBridge,
  productionMacOsAccessibilityBridge,
  productionWindowsUiAutomationBridge,
} from '../src/computer/nativeDesktopProductionBridge.js';
import type { DesktopBridgeExecutor } from '../src/computer/nativeDesktopJsonBridge.js';

class FactoryExecutor implements DesktopBridgeExecutor {
  calls: string[] = [];
  constructor(private readonly platform: 'windows-uia'|'macos-accessibility'|'linux-atspi', private readonly relative = false) {}
  async invoke(operation: string, payload: unknown): Promise<unknown> {
    this.calls.push(operation);
    if (operation === 'describe') return {
      protocolVersion: 1,
      platform: this.platform,
      operations: ['enumerate-windows','accessibility','visual','dispatch'],
      capabilities: this.relative ? ['relative-pointer'] : [],
    };
    if (operation === 'enumerate-windows') return { windows: [], truncated: false };
    if (operation === 'dispatch') return { status:'completed', dispatched:true, verified:true, evidence:['native-dispatch-completed'] };
    const request = payload as { window:{ instanceToken:string } };
    return { status:'unsupported', windowInstanceToken:request.window.instanceToken, reason:'not-configured' };
  }
}

const command = { executable: '/trusted/helper' };

test('production factories bind the expected platform and contract gate', async () => {
  const windowsExecutor = new FactoryExecutor('windows-uia');
  const macExecutor = new FactoryExecutor('macos-accessibility');
  const linuxExecutor = new FactoryExecutor('linux-atspi');
  const windows = productionWindowsUiAutomationBridge(command, windowsExecutor);
  const mac = productionMacOsAccessibilityBridge(command, macExecutor);
  const linux = productionLinuxAtSpiBridge(command, linuxExecutor);
  assert.equal(windows.platform,'windows-uia');
  assert.equal(mac.platform,'macos-accessibility');
  assert.equal(linux.platform,'linux-atspi');
  await windows.enumerateWindows({maxItems:1,maxTextBytes:64,maxDepth:1});
  await mac.enumerateWindows({maxItems:1,maxTextBytes:64,maxDepth:1});
  await linux.enumerateWindows({maxItems:1,maxTextBytes:64,maxDepth:1});
  assert.deepEqual(windowsExecutor.calls,['describe','enumerate-windows']);
  assert.deepEqual(macExecutor.calls,['describe','enumerate-windows']);
  assert.deepEqual(linuxExecutor.calls,['describe','enumerate-windows']);
});

test('production factory relative pointer claim must agree with helper descriptor', async () => {
  const executor = new FactoryExecutor('linux-atspi',false);
  const bridge = productionLinuxAtSpiBridge({ executable:'/trusted/helper', supportsRelativePointer:true },executor);
  assert.equal(bridge.supportsRelativePointer,true);
  const result = await bridge.dispatch({
    kind:'pointer-relative',
    target:{nativeWindowId:'w',expectedWindowInstanceToken:'wi'},
    input:{dx:1,dy:1},
  },'local-reversible');
  assert.equal(result.dispatched,false);
  assert.deepEqual(executor.calls,['describe']);
});

test('production factory permits relative pointer only when both sides advertise it', async () => {
  const executor = new FactoryExecutor('windows-uia',true);
  const bridge = productionWindowsUiAutomationBridge({ executable:'/trusted/helper', supportsRelativePointer:true },executor);
  const result = await bridge.dispatch({
    kind:'pointer-relative',
    target:{nativeWindowId:'w',expectedWindowInstanceToken:'wi'},
    input:{dx:1,dy:-1},
  },'local-reversible');
  assert.equal(result.dispatched,true);
  assert.deepEqual(executor.calls,['describe','dispatch']);
});
