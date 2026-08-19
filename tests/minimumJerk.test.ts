import test from 'node:test';
import assert from 'node:assert/strict';
import { fittsDurationMs, minimumJerkProgress, minimumJerkTrajectory } from '../src/motor/minimumJerk.js';

test('minimum jerk clamps progress and preserves endpoints', () => {
  assert.equal(minimumJerkProgress(-1), 0);
  assert.equal(minimumJerkProgress(2), 1);
  const trajectory = minimumJerkTrajectory(
    { x: 3, y: 4 },
    { x: 13, y: 24 },
    { durationMs: 100, sampleIntervalMs: 30 },
  );
  assert.deepEqual(trajectory[0], { x: 3, y: 4, tMs: 0 });
  assert.deepEqual(trajectory.at(-1), { x: 13, y: 24, tMs: 100 });
});

test('trajectory time and progress are monotonic', () => {
  const trajectory = minimumJerkTrajectory(
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { durationMs: 103, sampleIntervalMs: 8 },
  );
  for (let i = 1; i < trajectory.length; i += 1) {
    assert.ok(trajectory[i].tMs > trajectory[i - 1].tMs);
    assert.ok(trajectory[i].x >= trajectory[i - 1].x);
  }
});

test('fitts duration increases with distance and decreases with target width', () => {
  assert.ok(fittsDurationMs(400, 20) > fittsDurationMs(100, 20));
  assert.ok(fittsDurationMs(200, 10) > fittsDurationMs(200, 100));
});
