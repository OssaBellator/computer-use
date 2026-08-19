import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpSelectController } from '../src/browser/selectController.js';
import type { InteractionNode } from '../src/types.js';

function target(overrides: Partial<InteractionNode> = {}): InteractionNode {
  return {
    id: 'select-1', frameId: 'frame-1', backendNodeId: 17,
    role: 'select', name: 'Fruit', value: 'a', focused: false, disabled: false,
    focusable: true, clickable: true, editable: false, scrollable: false,
    capabilities: ['focus', 'activate', 'select'], interactionConfidence: 1,
    ...overrides,
  };
}

class Session {
  readonly calls: Array<[string, Record<string, unknown>]> = [];
  mutationValue: unknown = { status: 'selected', index: 1 };
  verificationValue: unknown = true;
  callCount = 0;

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    this.calls.push([method, params]);
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'select-object' } };
    if (method === 'Runtime.callFunctionOn') {
      this.callCount += 1;
      return this.callCount === 1
        ? { result: { value: this.mutationValue } }
        : { result: { value: this.verificationValue } };
    }
    if (method === 'Runtime.releaseObject') return {};
    return {};
  }
}

test('native select matches inside isolated world and returns only coarse metadata', async () => {
  const session = new Session();
  const controller = new CdpSelectController(session);
  const desired = 'secret-option-label';
  const result = await controller.select(target(), desired, { by: 'label' });

  assert.deepEqual(result, {
    status: 'selected',
    target: target(),
    selectedIndex: 1,
  });
  const world = session.calls.find(([method]) => method === 'Page.createIsolatedWorld');
  assert.equal(world?.[1].frameId, 'frame-1');
  const resolve = session.calls.find(([method]) => method === 'DOM.resolveNode');
  assert.equal(resolve?.[1].backendNodeId, 17);
  const mutation = session.calls.filter(([method]) => method === 'Runtime.callFunctionOn')[0];
  assert.deepEqual(mutation[1].arguments, [{ value: desired }, { value: 'label' }]);
  assert.equal(JSON.stringify(result).includes(desired), false);
  assert.equal(session.calls.at(-1)?.[0], 'Runtime.releaseObject');
});

test('native select reports page-side option outcomes without exporting option lists', async () => {
  for (const status of [
    'option-not-found',
    'option-ambiguous',
    'option-disabled',
    'multiple-unsupported',
    'disabled',
    'not-select',
  ] as const) {
    const session = new Session();
    session.mutationValue = { status };
    const result = await new CdpSelectController(session).select(target(), 'wanted');
    assert.equal(result.status, status);
    assert.equal('selectedIndex' in result, false);
    assert.equal(session.callCount, 1);
    assert.equal(JSON.stringify(result).includes('wanted'), false);
  }
});

test('native select fails closed when post-event verification observes a reverted choice', async () => {
  const session = new Session();
  session.verificationValue = false;
  const result = await new CdpSelectController(session).select(target(), 'Banana');
  assert.equal(result.status, 'unverified');
  assert.equal(session.callCount, 2);
});

test('already-selected option is independently verified', async () => {
  const session = new Session();
  session.mutationValue = { status: 'already-selected', index: 0 };
  const result = await new CdpSelectController(session).select(target(), 'Apple');
  assert.equal(result.status, 'already-selected');
  assert.equal(result.selectedIndex, 0);
  assert.equal(session.callCount, 2);
});

test('invalid semantic target is rejected before CDP commands', async () => {
  const session = new Session();
  const controller = new CdpSelectController(session);
  const result = await controller.select(target({ backendNodeId: undefined }), 'Apple');
  assert.equal(result.status, 'invalid-target');
  assert.deepEqual(session.calls, []);

  const wrongCapability = await controller.select(target({ capabilities: ['focus', 'activate'] }), 'Apple');
  assert.equal(wrongCapability.status, 'not-select');
  assert.deepEqual(session.calls, []);
});
