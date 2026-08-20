import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IsolatedLocalComputeAdapter,
  LocalComputeAdapter,
  ISOLATED_LOCAL_COMPUTE_EXECUTION_MODEL,
  LOCAL_COMPUTE_EXECUTION_MODEL,
} from '../src/index.js';

test('package root exports both distinct local compute execution modes', () => {
  assert.equal(typeof LocalComputeAdapter, 'function');
  assert.equal(typeof IsolatedLocalComputeAdapter, 'function');
  assert.equal(LOCAL_COMPUTE_EXECUTION_MODEL, 'trusted-in-process-cooperative');
  assert.equal(ISOLATED_LOCAL_COMPUTE_EXECUTION_MODEL, 'isolated-child-process-enforceable-timeout');
  assert.notEqual(LOCAL_COMPUTE_EXECUTION_MODEL, ISOLATED_LOCAL_COMPUTE_EXECUTION_MODEL);
});
