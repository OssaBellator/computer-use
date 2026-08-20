import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpPointerLockObserver } from '../src/browser/cdpPointerLockObserver.js';
import type { CdpSessionLike } from '../src/browser/cdpIdentity.js';

test('CDP observer resolves pointer-lock element identity and verified game-region generation', async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  let evaluateCount = 0;
  const session: CdpSessionLike = {
    async send(method, params) {
      calls.push([method, params]);
      if (method === 'Runtime.evaluate' && evaluateCount++ === 0) {
        return { result: { value: { supported: true, locked: true, focused: true } } };
      }
      if (method === 'Runtime.evaluate') return { result: { objectId: 'lock-object' } };
      if (method === 'DOM.describeNode') {
        return {
          node: {
            backendNodeId: 42,
            localName: 'canvas',
            frameId: 'frame-a',
            attributes: ['id', 'game'],
          },
        };
      }
      return {};
    },
  };
  const observer = new CdpPointerLockObserver(session, {
    targetId: 'target-a',
    sessionId: 'session-a',
    frameId: 'frame-a',
    executionContextId: 23,
    gameRegion: () => ({ backendNodeId: 42, generation: 3 }),
  });

  const state = await observer.observeLock();
  assert.equal(state.locked, true);
  assert.equal(state.gameRegionMatch, true);
  assert.deepEqual(state.owner, {
    targetId: 'target-a',
    sessionId: 'session-a',
    frameId: 'frame-a',
    backendNodeId: 42,
    gameRegionBackendNodeId: 42,
    gameRegionGeneration: 3,
    elementTag: 'canvas',
    elementId: 'game',
  });
  const runtimeCalls = calls.filter(([method]) => method === 'Runtime.evaluate');
  assert.ok(runtimeCalls.every(([, params]) => params?.contextId === 23));
  assert.ok(calls.some(([method]) => method === 'Runtime.releaseObject'));
});

test('CDP observer never stamps current game-region identity onto a different locking element', async () => {
  let evaluateCount = 0;
  const session: CdpSessionLike = {
    async send(method) {
      if (method === 'Runtime.evaluate' && evaluateCount++ === 0) {
        return { result: { value: { supported: true, locked: true, focused: true } } };
      }
      if (method === 'Runtime.evaluate') return { result: { objectId: 'stale-lock' } };
      if (method === 'DOM.describeNode') {
        return {
          node: {
            backendNodeId: 42,
            localName: 'canvas',
            frameId: 'frame-a',
            attributes: ['id', 'old-game'],
          },
        };
      }
      return {};
    },
  };
  const observer = new CdpPointerLockObserver(session, {
    frameId: 'frame-a',
    gameRegion: () => ({ backendNodeId: 88, generation: 4 }),
  });

  const state = await observer.observeLock();
  assert.equal(state.locked, true);
  assert.equal(state.gameRegionMatch, false);
  assert.equal(state.owner?.backendNodeId, 42);
  assert.equal(state.owner?.gameRegionBackendNodeId, undefined);
  assert.equal(state.owner?.gameRegionGeneration, undefined);
});

test('CDP observer queries actual pointer-capture ownership on an element object', async () => {
  const session: CdpSessionLike = {
    async send(method) {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'capture-object' } };
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { supported: true, captured: true } } };
      }
      if (method === 'DOM.describeNode') {
        return {
          node: {
            backendNodeId: 77,
            localName: 'canvas',
            attributes: ['id', 'capture'],
          },
        };
      }
      return {};
    },
  };
  const observer = new CdpPointerLockObserver(session, {
    frameId: 'main',
    gameRegion: () => ({ backendNodeId: 77, generation: 5 }),
  });

  const state = await observer.observeCapture(1, 77);
  assert.equal(state.supported, true);
  assert.equal(state.captured, true);
  assert.equal(state.owner?.backendNodeId, 77);
  assert.equal(state.owner?.gameRegionGeneration, 5);
  assert.equal(state.owner?.elementId, 'capture');
});

test('CDP observer identifies unresolved capture element as detached without synthesizing input', async () => {
  const calls: string[] = [];
  const session: CdpSessionLike = {
    async send(method) {
      calls.push(method);
      if (method === 'DOM.resolveNode') return { object: {} };
      return {};
    },
  };
  const observer = new CdpPointerLockObserver(session, {
    frameId: 'main',
    gameRegion: () => ({ backendNodeId: 77, generation: 9 }),
  });
  const state = await observer.observeCapture(2, 77);
  assert.equal(state.supported, true);
  assert.equal(state.captured, false);
  assert.equal(state.lossReason, 'element-detached');
  assert.equal(state.owner?.backendNodeId, 77);
  assert.equal(state.owner?.gameRegionGeneration, undefined);
  assert.deepEqual(calls, ['DOM.resolveNode']);
});
