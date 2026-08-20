import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ISOLATED_LOCAL_COMPUTE_GUARANTEES,
  LOCAL_COMPUTE_GUARANTEES,
} from '../src/index.js';

test('local compute guarantee profiles distinguish enforceable timeout and termination', () => {
  assert.equal(LOCAL_COMPUTE_GUARANTEES.isolationBoundary, 'trusted-same-process');
  assert.equal(LOCAL_COMPUTE_GUARANTEES.deadline, 'cooperative-abort-with-post-return-check');
  assert.equal(LOCAL_COMPUTE_GUARANTEES.timeoutTermination, 'not-enforceable');

  assert.equal(ISOLATED_LOCAL_COMPUTE_GUARANTEES.isolationBoundary, 'separate-child-process');
  assert.equal(ISOLATED_LOCAL_COMPUTE_GUARANTEES.deadline, 'parent-wall-clock-enforced');
  assert.equal(ISOLATED_LOCAL_COMPUTE_GUARANTEES.timeoutTermination, 'forced-child-termination-with-confirmation');
});

test('resource non-guarantees remain explicit for both local compute modes', () => {
  for (const profile of [LOCAL_COMPUTE_GUARANTEES, ISOLATED_LOCAL_COMPUTE_GUARANTEES]) {
    assert.equal(profile.memory, 'hint-only-not-enforced');
    assert.equal(profile.filesystem, 'trusted-operation-authority-not-sandboxed');
    assert.equal(profile.network, 'trusted-operation-authority-not-sandboxed');
    assert.equal(profile.serializedInputOutput, 'canonical-json-bounded');
    assert.equal(profile.dispatchLedger, 'non-evicted-adapter-lifetime-capacity-fails-closed');
    assert.ok(Object.isFrozen(profile));
  }
});
