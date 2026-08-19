import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplanningExecutor } from '../src/controller/replanningExecutor.js';
import { InteractionModel } from '../src/model/interactionModel.js';
import type { InteractionNode } from '../src/types.js';

function node(id: string, focused: boolean): InteractionNode {
  return {
    id, frameId: 'main', focused, disabled: false,
    rect: { x: id === 'a' ? 0 : 50, y: 0, width: 20, height: 20 },
    focusable: true, clickable: true, editable: false, scrollable: false,
    capabilities: ['focus'], interactionConfidence: 1,
  };
}

test('replanner reuses a fresh dispatcher snapshot after a verified keyboard edge', async () => {
  const model = new InteractionModel();
  for (let i = 0; i < 10; i += 1) {
    model.focusTopology.observe({ fromId: 'a', toId: 'b', direction: 'forward', observedAtMs: i });
  }
  let snapshotCalls = 0;
  const before = [node('a', true), node('b', false)];
  const after = [node('a', false), node('b', true)];
  const runner = new ReplanningExecutor(
    model,
    async () => {
      snapshotCalls += 1;
      return before;
    },
    async () => ({
      succeeded: true,
      arrivedNodeId: 'b',
      observedSnapshot: after,
    }),
  );

  const result = await runner.execute('a', 'b', {
    includeDirectional: false,
    includePointer: false,
  });
  assert.equal(result.status, 'reached');
  assert.equal(snapshotCalls, 1);
  assert.equal(model.getNode('b')?.focused, true);
});

test('replanning still performs a new pre-plan observation on the next loop', async () => {
  const model = new InteractionModel();
  for (let i = 0; i < 10; i += 1) {
    model.focusTopology.observe({ fromId: 'a', toId: 'b', direction: 'forward', observedAtMs: i });
  }
  let snapshotCalls = 0;
  const before = [node('a', true), node('b', false)];
  const runner = new ReplanningExecutor(
    model,
    async () => {
      snapshotCalls += 1;
      return before;
    },
    async () => ({
      succeeded: false,
      arrivedNodeId: 'a',
      observedSnapshot: before,
    }),
  );

  const result = await runner.execute('a', 'b', {
    includeDirectional: false,
    includePointer: false,
    maxReplans: 1,
  });
  assert.equal(result.status, 'replan-exhausted');
  assert.equal(snapshotCalls, 2);
});
