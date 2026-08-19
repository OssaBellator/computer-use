import test from 'node:test';
import assert from 'node:assert/strict';
import { findHitTestedTargetPoint, pointHitsInteractionNode } from '../src/browser/hitTesting.js';
import type { HitTestFrameLike } from '../src/browser/hitTesting.js';
import type { InteractionNode } from '../src/types.js';

const target: InteractionNode = {
  id: 'main:button:nth-of-type(1)',
  frameId: 'main',
  focused: false,
  disabled: false,
  rect: { x: 0, y: 0, width: 100, height: 40 },
  visibleRect: { x: 0, y: 0, width: 100, height: 40 },
  focusable: true,
  clickable: true,
  editable: false,
  scrollable: false,
  capabilities: ['focus', 'activate'],
  interactionConfidence: 1,
};

test('hit-tested target point skips blocked candidates', async () => {
  const visited: number[] = [];
  const frame: HitTestFrameLike = {
    async evaluate<R, A>(_fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
      const request = arg as { point: { x: number; y: number } };
      visited.push(request.point.x);
      return { hit: request.point.x < 40 } as R;
    },
  };
  const point = await findHitTestedTargetPoint(
    frame,
    target,
    { x: 0, y: 0, width: 100, height: 40 },
  );
  assert.deepEqual(point, { x: 27, y: 20 });
  assert.deepEqual(visited.slice(0, 2), [50, 27]);
});

test('hit testing refuses disabled nodes before probing', async () => {
  let evaluated = false;
  const frame: HitTestFrameLike = {
    async evaluate<R, A>(_fn: (arg: A) => R | Promise<R>, _arg: A): Promise<R> {
      evaluated = true;
      return { hit: true } as R;
    },
  };
  const point = await findHitTestedTargetPoint(
    frame,
    { ...target, disabled: true },
    { x: 0, y: 0, width: 100, height: 40 },
  );
  assert.equal(point, null);
  assert.equal(evaluated, false);
});

test('point hit request strips the frame prefix from node identity', async () => {
  let request: unknown;
  const frame: HitTestFrameLike = {
    async evaluate<R, A>(_fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
      request = arg;
      return { hit: true } as R;
    },
  };
  await pointHitsInteractionNode(frame, target, { x: 10, y: 10 });
  assert.deepEqual(request, {
    point: { x: 10, y: 10 },
    targetPath: 'button:nth-of-type(1)',
  });
});
