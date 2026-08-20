import test from 'node:test';
import assert from 'node:assert/strict';
import * as packageApi from '../src/index.js';

test('curated package API exposes local compute execution descriptors without concrete adapter authority', () => {
  assert.equal(packageApi.LOCAL_COMPUTE_EXECUTION_MODEL, 'trusted-in-process-cooperative');
  assert.equal(packageApi.ISOLATED_LOCAL_COMPUTE_EXECUTION_MODEL, 'isolated-child-process-enforceable-timeout');
  assert.notEqual(packageApi.LOCAL_COMPUTE_EXECUTION_MODEL, packageApi.ISOLATED_LOCAL_COMPUTE_EXECUTION_MODEL);

  assert.equal('LocalComputeAdapter' in packageApi, false);
  assert.equal('IsolatedLocalComputeAdapter' in packageApi, false);
  assert.equal('createIsolatedLocalComputeAdapter' in packageApi, false);
});
