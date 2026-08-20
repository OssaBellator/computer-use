import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractCheckedDesktopPlatformBridge, type NativeDesktopHelperDescriptor } from '../src/computer/nativeDesktopHelperContract.js';
import type { DesktopBridgeExecutor } from '../src/computer/nativeDesktopJsonBridge.js';

class HelperExecutor implements DesktopBridgeExecutor {
  calls: string[] = [];
  helper: NativeDesktopHelperDescriptor = {
    protocolVersion: 1,
    platform: 'linux-atspi',
    operations: ['enumerate-windows', 'accessibility', 'visual', 'dispatch'],
    capabilities: [],
  };
  async invoke(operation: string, payload: unknown): Promise<unknown> {
    this.calls.push(operation);
    if (operation === 'describe') return this.helper;
    if (operation === 'enumerate-windows') return { windows: [], truncated: false };
    if (operation === 'dispatch') return { status: 'completed', dispatched: true, verified: true, evidence: ['native-dispatch-completed'] };
    if (operation === 'accessibility') {
      const request = payload as { window: { instanceToken: string } };
      return { status: 'unsupported', windowInstanceToken: request.window.instanceToken, reason: 'not-configured' };
    }
    if (operation === 'visual') {
      const request = payload as { window: { instanceToken: string } };
      return { status: 'unsupported', windowInstanceToken: request.window.instanceToken, reason: 'not-configured' };
    }
    throw new Error('unexpected operation');
  }
}

test('helper platform mismatch blocks native dispatch before dispatch operation', async () => {
  const executor = new HelperExecutor();
  executor.helper = { ...executor.helper, platform: 'windows-uia' };
  const bridge = new ContractCheckedDesktopPlatformBridge('linux', 'linux-atspi', executor);
  const result = await bridge.dispatch({
    kind: 'keyboard',
    target: { nativeWindowId: 'w', expectedWindowInstanceToken: 'wi' },
    input: { kind: 'key-down', key: 'Enter' },
  }, 'local-reversible');
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatched, false);
  assert.deepEqual(executor.calls, ['describe']);
});

test('missing dispatch operation blocks native dispatch', async () => {
  const executor = new HelperExecutor();
  executor.helper = { ...executor.helper, operations: ['enumerate-windows', 'accessibility', 'visual'] };
  const bridge = new ContractCheckedDesktopPlatformBridge('linux', 'linux-atspi', executor);
  const result = await bridge.dispatch({
    kind: 'pointer-absolute',
    target: { nativeWindowId: 'w', expectedWindowInstanceToken: 'wi' },
    input: { kind: 'click', x: 1, y: 2, button: 'left' },
  }, 'local-reversible');
  assert.equal(result.dispatched, false);
  assert.deepEqual(executor.calls, ['describe']);
});

test('relative pointer advertisement must match helper capability', async () => {
  const executor = new HelperExecutor();
  const bridge = new ContractCheckedDesktopPlatformBridge('linux', 'linux-atspi', executor, { supportsRelativePointer: true });
  const result = await bridge.dispatch({
    kind: 'pointer-relative',
    target: { nativeWindowId: 'w', expectedWindowInstanceToken: 'wi' },
    input: { dx: 2, dy: 3 },
  }, 'local-reversible');
  assert.equal(result.dispatched, false);
  assert.deepEqual(executor.calls, ['describe']);
});

test('conforming helper is checked before each native operation', async () => {
  const executor = new HelperExecutor();
  const bridge = new ContractCheckedDesktopPlatformBridge('linux', 'linux-atspi', executor);
  const system = await bridge.enumerateWindows({ maxItems: 1, maxTextBytes: 64, maxDepth: 1 });
  assert.deepEqual(system.windows, []);
  const result = await bridge.dispatch({
    kind: 'keyboard',
    target: { nativeWindowId: 'w', expectedWindowInstanceToken: 'wi' },
    input: { kind: 'key-up', key: 'Enter' },
  }, 'local-reversible');
  assert.equal(result.dispatched, true);
  assert.deepEqual(executor.calls, ['describe', 'enumerate-windows', 'describe', 'dispatch']);
});

test('malformed helper descriptor blocks dispatch without passing malformed data onward', async () => {
  const executor = new HelperExecutor();
  executor.helper = { protocolVersion: 1, platform: 'linux-atspi', operations: ['dispatch'], capabilities: [] };
  const original = executor.invoke.bind(executor);
  executor.invoke = async (operation, payload, limits) => operation === 'describe'
    ? { protocolVersion: 1, platform: 'linux-atspi', operations: ['dispatch', 'dispatch'], capabilities: [] }
    : original(operation, payload, limits);
  const bridge = new ContractCheckedDesktopPlatformBridge('linux', 'linux-atspi', executor);
  const result = await bridge.dispatch({
    kind: 'keyboard',
    target: { nativeWindowId: 'w', expectedWindowInstanceToken: 'wi' },
    input: { kind: 'key-down', key: 'A' },
  }, 'local-reversible');
  assert.equal(result.dispatched, false);
  assert.equal(executor.calls.includes('dispatch'), false);
});
