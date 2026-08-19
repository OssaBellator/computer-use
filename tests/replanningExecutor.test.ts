import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplanningExecutor } from '../src/controller/replanningExecutor.js';
import { InteractionModel } from '../src/model/interactionModel.js';
import type { InteractionNode } from '../src/types.js';

const node = (id: string, focused = false): InteractionNode => ({
  id,
  frameId: 'main',
  focused,
  disabled: false,
  rect: { x: id.charCodeAt(0), y: 0, width: 10, height: 10 },
  focusable: true,
  clickable: true,
  editable: false,
  scrollable: false,
  capabilities: ['focus'],
  interactionConfidence: 1,
});

function observeMany(model: InteractionModel, fromId: string, toId: string): void {
  for (let i = 0; i < 20; i += 1) {
    model.focusTopology.observe({ fromId, toId, direction: 'forward', observedAtMs: i });
  }
}

test('closed-loop executor replans when a dispatched edge fails and topology changes', async () => {
  const model = new InteractionModel();
  observeMany(model, 'a', 'b');
  observeMany(model, 'b', 'c');
  observeMany(model, 'a', 'd');
  observeMany(model, 'd', 'c');

  let nodes = [node('a', true), node('b'), node('c'), node('d')];
  const dispatched: string[] = [];
  const runner = new ReplanningExecutor(
    model,
    async () => nodes,
    async (edge) => {
      dispatched.push(`${edge.from}->${edge.to}`);
      if (edge.from === 'a' && edge.to === 'b') {
        nodes = [node('a', true), node('c'), node('d')];
        return { succeeded: false, reason: 'target disappeared' };
      }
      return { succeeded: true };
    },
  );

  const result = await runner.execute('a', 'c', {
    includeDirectional: false,
    includePointer: false,
  });
  assert.equal(result.status, 'reached');
  assert.equal(result.replans, 1);
  assert.deepEqual(dispatched, ['a->b', 'a->d', 'd->c']);
});

test('closed-loop executor reports no-plan without dispatching', async () => {
  const model = new InteractionModel();
  const runner = new ReplanningExecutor(
    model,
    async () => [node('a'), node('b')],
    async () => { throw new Error('should not dispatch'); },
  );
  const result = await runner.execute('a', 'b', {
    includeDirectional: false,
    includePointer: false,
  });
  assert.equal(result.status, 'no-plan');
  assert.equal(result.executed.length, 0);
});

test('closed-loop executor enforces the executed-edge budget', async () => {
  const model = new InteractionModel();
  observeMany(model, 'a', 'b');
  observeMany(model, 'b', 'c');
  let current = 'a';
  const runner = new ReplanningExecutor(
    model,
    async () => [node('a', current === 'a'), node('b', current === 'b'), node('c')],
    async (edge) => {
      current = edge.to;
      return { succeeded: true, arrivedNodeId: edge.from };
    },
  );
  const result = await runner.execute('a', 'c', {
    includeDirectional: false,
    includePointer: false,
    maxExecutedEdges: 1,
  });
  assert.equal(result.status, 'budget-exhausted');
  assert.equal(result.executed.length, 1);
});

test('successful dispatch to an unexpected confirmed anchor triggers replanning', async () => {
  const model = new InteractionModel();
  observeMany(model, 'a', 'b');
  observeMany(model, 'b', 'c');
  observeMany(model, 'd', 'c');
  const nodes = [node('a', true), node('b'), node('c'), node('d')];
  const dispatched: string[] = [];
  const runner = new ReplanningExecutor(
    model,
    async () => nodes,
    async (edge) => {
      dispatched.push(`${edge.from}->${edge.to}`);
      if (edge.from === 'a') return { succeeded: true, arrivedNodeId: 'd' };
      return { succeeded: true };
    },
  );
  const result = await runner.execute('a', 'c', {
    includeDirectional: false,
    includePointer: false,
  });
  assert.equal(result.status, 'reached');
  assert.equal(result.replans, 1);
  assert.deepEqual(dispatched, ['a->b', 'd->c']);
  assert.equal(result.finalModality, 'keyboard');
});
