import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PointerCaptureLifecycle,
  PointerLockLifecycle,
  pointerLockOwnerMatches,
} from '../src/browser/pointerLockState.js';

test('lock state moves through request, pending, locked, and unexpected loss', () => {
  const lifecycle = new PointerLockLifecycle();
  assert.equal(lifecycle.current().phase, 'unlocked');

  lifecycle.beginRequest({ frameId: 'frame-a', backendNodeId: 42 });
  assert.equal(lifecycle.current().phase, 'requested');

  lifecycle.observe({ supported: true, locked: false, focused: true });
  assert.equal(lifecycle.current().phase, 'requested');

  const locked = lifecycle.observe({
    supported: true,
    locked: true,
    focused: true,
    owner: { frameId: 'frame-a', backendNodeId: 42, elementId: 'game' },
  });
  assert.equal(locked.phase, 'locked');
  assert.equal(locked.generation, 1);

  const lost = lifecycle.observe({ supported: true, locked: false, focused: true }, 'escape');
  assert.equal(lost.phase, 'lost');
  assert.equal(lost.lossReason, 'escape');
  assert.equal(lost.owner?.backendNodeId, 42);
});

test('focus loss is inferred and explicit context-loss hooks retain ownership', () => {
  const lifecycle = new PointerLockLifecycle();
  lifecycle.beginRequest({ targetId: 'target-a' });
  lifecycle.observe({ supported: true, locked: true, owner: { targetId: 'target-a' } });
  assert.equal(
    lifecycle.observe({ supported: true, locked: false, focused: false }).lossReason,
    'focus-lost',
  );

  lifecycle.beginRequest({ targetId: 'target-b' });
  lifecycle.observe({ supported: true, locked: true, owner: { targetId: 'target-b' } });
  assert.equal(lifecycle.markLoss('navigation').lossReason, 'navigation');

  lifecycle.beginRequest({ gameRegionBackendNodeId: 7, gameRegionGeneration: 2 });
  lifecycle.observe({
    supported: true,
    locked: true,
    owner: { gameRegionBackendNodeId: 7, gameRegionGeneration: 2 },
  });
  const replaced = lifecycle.markLoss('renderer-replaced');
  assert.equal(replaced.lossReason, 'renderer-replaced');
  assert.equal(replaced.owner?.gameRegionGeneration, 2);
});

test('partial owner matching binds lock to supplied frame and renderer identity', () => {
  assert.equal(pointerLockOwnerMatches(
    { frameId: 'f', gameRegionGeneration: 3 },
    { frameId: 'f', backendNodeId: 9, gameRegionGeneration: 3, elementId: 'game' },
  ), true);
  assert.equal(pointerLockOwnerMatches(
    { frameId: 'f', gameRegionGeneration: 4 },
    { frameId: 'f', backendNodeId: 9, gameRegionGeneration: 3 },
  ), false);
});

test('pointer capture distinguishes expected release from unexpected loss', () => {
  const lifecycle = new PointerCaptureLifecycle();
  const captured = lifecycle.observe({
    pointerId: 1,
    supported: true,
    captured: true,
    owner: { backendNodeId: 55 },
  });
  assert.equal(captured.phase, 'captured');
  assert.equal(captured.generation, 1);

  const lost = lifecycle.observe({ pointerId: 1, supported: true, captured: false });
  assert.equal(lost.phase, 'lost');
  assert.equal(lost.lossReason, 'unknown');

  lifecycle.observe({
    pointerId: 2,
    supported: true,
    captured: true,
    owner: { backendNodeId: 55 },
  });
  const released = lifecycle.release(2);
  assert.equal(released.phase, 'uncaptured');
  assert.equal(released.lossReason, undefined);
});
