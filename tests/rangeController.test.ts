import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpRangeController } from '../src/browser/rangeController.js';
import type { InteractionNode } from '../src/types.js';

function target(overrides: Partial<InteractionNode> = {}): InteractionNode {
  return {
    id: 'range-1', frameId: 'frame-1', backendNodeId: 19,
    role: 'input', name: 'Volume', value: '25', focused: false, disabled: false,
    focusable: true, clickable: true, editable: false, scrollable: false,
    capabilities: ['focus', 'activate', 'set-range'], interactionConfidence: 1,
    ...overrides,
  };
}

class Session {
  readonly calls: Array<[string, Record<string, unknown>]> = [];
  mutationValue: unknown = { status: 'set' };
  verificationValue: unknown = true;
  callCount = 0;

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    this.calls.push([method, params]);
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 77 };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'range-object' } };
    if (method === 'Runtime.callFunctionOn') {
      this.callCount += 1;
      return this.callCount === 1
        ? { result: { value: this.mutationValue } }
        : { result: { value: this.verificationValue } };
    }
    return {};
  }
}

test('native range mutation uses exact backend node and keeps desired value out of result', async () => {
  const session = new Session();
  const desired = '75';
  const result = await new CdpRangeController(session).set(target(), desired);

  assert.equal(result.status, 'set');
  assert.equal(JSON.stringify(result).includes(desired), false);
  assert.equal(session.calls.find(([method]) => method === 'Page.createIsolatedWorld')?.[1].frameId, 'frame-1');
  assert.equal(session.calls.find(([method]) => method === 'DOM.resolveNode')?.[1].backendNodeId, 19);
  assert.deepEqual(
    session.calls.filter(([method]) => method === 'Runtime.callFunctionOn')[0]?.[1].arguments,
    [{ value: desired }],
  );
  assert.equal(session.calls.at(-1)?.[0], 'Runtime.releaseObject');
});

test('native range surfaces coarse browser-side failure statuses', async () => {
  for (const status of ['not-range', 'disabled', 'invalid-value', 'value-rejected', 'unverified'] as const) {
    const session = new Session();
    session.mutationValue = { status };
    const result = await new CdpRangeController(session).set(target(), '50');
    assert.equal(result.status, status);
    assert.equal(session.callCount, 1);
  }
});

test('native range second read catches synchronous or microtask reversion', async () => {
  const session = new Session();
  session.verificationValue = false;
  const result = await new CdpRangeController(session).set(target(), '50');
  assert.equal(result.status, 'unverified');
  assert.equal(session.callCount, 2);
});

test('already-set range values are independently verified', async () => {
  const session = new Session();
  session.mutationValue = { status: 'already-set' };
  const result = await new CdpRangeController(session).set(target(), '25');
  assert.equal(result.status, 'already-set');
  assert.equal(session.callCount, 2);
});

test('invalid range targets are rejected before CDP commands', async () => {
  const session = new Session();
  const controller = new CdpRangeController(session);
  assert.equal((await controller.set(target({ backendNodeId: undefined }), '50')).status, 'invalid-target');
  assert.equal((await controller.set(target({ capabilities: ['focus', 'activate'] }), '50')).status, 'not-range');
  assert.deepEqual(session.calls, []);
});
