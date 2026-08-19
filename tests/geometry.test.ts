import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseSafeTargetPoint, effectiveTargetWidth, intersectRect, rectContainsPoint } from '../src/geometry.js';

test('rectangle intersection clips to viewport', () => {
  assert.deepEqual(
    intersectRect({ x: -5, y: 5, width: 20, height: 10 }, { x: 0, y: 0, width: 10, height: 10 }),
    { x: 0, y: 5, width: 10, height: 5 },
  );
});

test('touching rectangles have no positive-area intersection', () => {
  assert.equal(
    intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }),
    null,
  );
});

test('safe target avoids an occluded center deterministically', () => {
  const point = chooseSafeTargetPoint(
    { x: 0, y: 0, width: 100, height: 40 },
    { x: 0, y: 0, width: 100, height: 40 },
    [{ x: 40, y: 10, width: 20, height: 20 }],
  );
  assert.deepEqual(point, { x: 27, y: 20 });
});

test('safe target returns null when inset consumes visible area', () => {
  assert.equal(
    chooseSafeTargetPoint({ x: 0, y: 0, width: 8, height: 8 }, { x: 0, y: 0, width: 8, height: 8 }, [], 4),
    null,
  );
});

test('rectangle boundaries count as contained', () => {
  assert.equal(rectContainsPoint({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 10 }), true);
});

test('effective width follows movement axis', () => {
  assert.equal(effectiveTargetWidth({ x: 0, y: 0, width: 100, height: 20 }, { x: 10, y: 0 }), 100);
  assert.equal(effectiveTargetWidth({ x: 0, y: 0, width: 100, height: 20 }, { x: 0, y: 10 }), 20);
});
