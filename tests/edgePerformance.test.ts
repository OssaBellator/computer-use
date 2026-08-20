import test from 'node:test';
import assert from 'node:assert/strict';
import { EdgePerformanceModel } from '../src/model/edgePerformance.js';
import type { InteractionEdge } from '../src/types.js';

const edge: InteractionEdge = {
  from: 'a',
  to: 'b',
  kind: 'pointer-move',
  estimatedTimeMs: 100,
  failureProbability: 0.1,
};

test('performance model blends observed duration with the edge prior', () => {
  const model = new EdgePerformanceModel({ priorStrength: 2 });
  model.observe(edge, { durationMs: 400, succeeded: true });
  const adjusted = model.adjust(edge);
  assert.equal(adjusted.estimatedTimeMs, 200);
  assert.ok(Math.abs((adjusted.failureProbability ?? 0) - (0.2 / 3)) < 1e-12);
});

test('performance model increases failure estimate after repeated failures', () => {
  const model = new EdgePerformanceModel({ priorStrength: 1 });
  for (let i = 0; i < 4; i += 1) {
    model.observe(edge, { durationMs: 100, succeeded: false });
  }
  const adjusted = model.adjust(edge);
  assert.ok((adjusted.failureProbability ?? 0) > 0.8);
  assert.deepEqual(model.stats(edge), { attempts: 4, failures: 4, totalDurationMs: 400 });
});

test('performance observations are path-specific', () => {
  const model = new EdgePerformanceModel();
  model.observe(edge, { durationMs: 1000, succeeded: false });
  const other = { ...edge, to: 'c' };
  assert.equal(model.stats(other), undefined);
  assert.deepEqual(model.adjust(other), other);
});
