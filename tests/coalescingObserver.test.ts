import test from 'node:test';
import assert from 'node:assert/strict';
import { CoalescingInteractionObserver } from '../src/browser/coalescingObserver.js';
import type { BrowserInteractionObserver } from '../src/browser/cdpObserver.js';
import type { InteractionNode, Point } from '../src/types.js';

const snapshot: InteractionNode[] = [{
  id: 'n',
  frameId: 'main',
  focused: false,
  disabled: false,
  focusable: false,
  clickable: false,
  editable: false,
  scrollable: false,
  capabilities: [],
  interactionConfidence: 1,
}];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('concurrent snapshot requests share exactly one source observation', async () => {
  const pending = deferred<readonly InteractionNode[]>();
  let calls = 0;
  const source: BrowserInteractionObserver = {
    async snapshot() { calls += 1; return pending.promise; },
    async targetPoint() { return null; },
    async pointStillTargets() { return false; },
  };
  const observer = new CoalescingInteractionObserver(source);

  const a = observer.snapshot();
  const b = observer.snapshot();
  const c = observer.snapshot();
  assert.equal(calls, 1);
  pending.resolve(snapshot);
  assert.deepEqual(await Promise.all([a, b, c]), [snapshot, snapshot, snapshot]);
  assert.deepEqual(observer.stats(), {
    snapshotRequests: 3,
    sourceSnapshotCalls: 1,
    coalescedSnapshotRequests: 2,
  });
});

test('a request after completion always refreshes the source observer', async () => {
  let version = 0;
  const source: BrowserInteractionObserver = {
    async snapshot() {
      version += 1;
      return [{ ...snapshot[0], value: String(version) }];
    },
    async targetPoint() { return null; },
    async pointStillTargets() { return false; },
  };
  const observer = new CoalescingInteractionObserver(source);
  assert.equal((await observer.snapshot())[0].value, '1');
  assert.equal((await observer.snapshot())[0].value, '2');
  assert.equal(observer.stats().sourceSnapshotCalls, 2);
});

test('delegated point and viewport methods preserve source semantics', async () => {
  const point: Point = { x: 5, y: 7 };
  const source: BrowserInteractionObserver = {
    async snapshot() { return snapshot; },
    async targetPoint() { return point; },
    async pointStillTargets(_node, candidate) { return candidate.x === 5 && candidate.y === 7; },
    async viewportRect() { return { x: 0, y: 0, width: 100, height: 80 }; },
  };
  const observer = new CoalescingInteractionObserver(source);
  assert.deepEqual(await observer.targetPoint(snapshot[0]), point);
  assert.equal(await observer.pointStillTargets(snapshot[0], point), true);
  assert.deepEqual(await observer.viewportRect(), { x: 0, y: 0, width: 100, height: 80 });
});

test('failed source observation is not retained as stale in-flight state', async () => {
  let calls = 0;
  const source: BrowserInteractionObserver = {
    async snapshot() {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return snapshot;
    },
    async targetPoint() { return null; },
    async pointStillTargets() { return false; },
  };
  const observer = new CoalescingInteractionObserver(source);
  await assert.rejects(observer.snapshot(), /boom/);
  assert.deepEqual(await observer.snapshot(), snapshot);
  assert.equal(calls, 2);
});
