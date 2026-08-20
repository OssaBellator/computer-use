import test from 'node:test';
import assert from 'node:assert/strict';
import { arch, availableParallelism, totalmem } from 'node:os';
import { createHostSystemDeviceBackend } from '../src/computer/hostSystemDeviceBackend.js';
import { MinimalSystemInfoLinuxSystemDeviceBackend } from '../src/computer/minimalSystemInfoLinuxSystemDeviceBackend.js';

test('production Linux host information retains only scalar neutral system metadata', async () => {
  const backend = createHostSystemDeviceBackend({ platformFamily: 'linux' });
  assert.ok(backend instanceof MinimalSystemInfoLinuxSystemDeviceBackend);
  if (!(backend instanceof MinimalSystemInfoLinuxSystemDeviceBackend)) return;

  const observed = await backend.systemInformation();
  assert.equal(observed.state, 'ok');
  if (observed.state !== 'ok') return;
  assert.deepEqual(observed.value, {
    platformFamily: 'linux',
    architecture: arch(),
    logicalProcessorCount: availableParallelism(),
    totalMemoryBytes: totalmem(),
  });
  assert.equal(Object.isFrozen(observed.value), true);
  assert.deepEqual(Object.keys(observed.value).sort(), [
    'architecture', 'logicalProcessorCount', 'platformFamily', 'totalMemoryBytes',
  ]);
  assert.doesNotMatch(JSON.stringify(observed.value), /model|speed|times|hostname|username/i);
});

test('minimal system-information backend preserves explicit unsupported platform state', async () => {
  const backend = new MinimalSystemInfoLinuxSystemDeviceBackend({ platformFamily: 'darwin' });
  assert.deepEqual(await backend.systemInformation(), {
    state: 'unsupported-platform', evidence: 'linux-backend-on-non-linux',
  });
});
