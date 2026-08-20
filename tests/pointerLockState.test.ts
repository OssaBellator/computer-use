import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PointerCaptureLifecycle,
  PointerLockLifecycle,
  pointerLockOwnerMatches,
} from '../src/browser/pointerLockState.js';

test('lock state moves through requested, pending, locked, and unexpected loss', () => {
  const lifecycle = new PointerLockLifecycle();
  assert.equal(lifecycle.current().phase, 'unlocked');

  lifecycle.beginRequest({ frameId: 'frame-a', backendNodeId: 42 });
  assert.equal(lifecycle.current().phase, 'requested');

  lifecycle.observe({ supported: true, locked: false, focused: true });
  assert.equal(lifecycle.current().phase, 'pending');

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

test('pending request becomes explicitly unsupported without being mislabeled as loss', () => {
  const lifecycle = new PointerLockLifecycle();
  lifecycle.beginRequest({ backendNodeId: 42 });
  lifecycle.observe({ supported: true, locked: false, focused: true });
  const unsupported = lifecycle.observe({ supported: false, locked: false });
  assert.equal(unsupported.phase, 'unlocked');
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.requestFailure, 'unsupported');
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

test('browser lock on a stale game surface is classified as renderer replacement', () => {
  const lifecycle = new PointerLockLifecycle();
  lifecycle.beginRequest({ backendNodeId: 7, gameRegionBackendNodeId: 7, gameRegionGeneration: 1 });
  lifecycle.observe({
    supported: true,
    locked: true,
    gameRegionMatch: true,
    owner: { backendNodeId: 7, gameRegionBackendNodeId: 7, gameRegionGeneration: 1 },
  });

  const drifted = lifecycle.observe({
    supported: true,
    locked: true,
    gameRegionMatch: false,
    owner: { backendNodeId: 7 },
  });
  assert.equal(drifted.phase, 'lost');
  assert.equal(drifted.lossReason, 'renderer-replaced');
  assert.equal(drifted.owner?.gameRegionGeneration, 1);
});

test('known owner drift while browser still reports lock fails closed', () => {
  const lifecycle = new PointerLockLifecycle();
  lifecycle.beginRequest({ targetId: 'a', backendNodeId: 4 });
  lifecycle.observe({ supported: true, locked: true, owner: { targetId: 'a', backendNodeId: 4 } });

  const targetChanged = lifecycle.observe({
    supported: true,
    locked: true,
    owner: { targetId: 'b', backendNodeId: 4 },
  });
  assert.equal(targetChanged.phase, 'lost');
  assert.equal(targetChanged.lossReason, 'target-changed');

  lifecycle.beginRequest({ targetId: 'b', backendNodeId: 5 });
  lifecycle.observe({ supported: true, locked: true, owner: { targetId: 'b', backendNodeId: 5 } });
  const elementChanged = lifecycle.observe({
    supported: true,
    locked: true,
    owner: { targetId: 'b', backendNodeId: 6 },
  });
  assert.equal(elementChanged.phase, 'lost');
  assert.equal(elementChanged.lossReason, 'element-detached');
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

test('pointer capture preserves observer-provided element detachment reason', () => {
  const lifecycle = new PointerCaptureLifecycle();
  lifecycle.observe({ pointerId: 3, supported: true, captured: true, owner: { backendNodeId: 55 } });
  const lost = lifecycle.observe({
    pointerId: 3,
    supported: true,
    captured: false,
    owner: { backendNodeId: 55 },
    lossReason: 'element-detached',
  });
  assert.equal(lost.phase, 'lost');
  assert.equal(lost.lossReason, 'element-detached');
});
