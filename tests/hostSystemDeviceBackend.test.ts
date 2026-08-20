import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UnsupportedHostSystemDeviceBackend,
  createHostSystemDeviceBackend,
  createHostSystemDeviceEnvironmentAdapter,
} from '../src/computer/hostSystemDeviceBackend.js';
import { ScopeBoundLinuxSystemDeviceBackend } from '../src/computer/scopeBoundLinuxSystemDeviceBackend.js';

test('host backend selects only the reviewed scope-bound Linux implementation', () => {
  assert.ok(createHostSystemDeviceBackend({ platformFamily: 'linux' }) instanceof ScopeBoundLinuxSystemDeviceBackend);
  assert.ok(createHostSystemDeviceBackend({ platformFamily: 'darwin' }) instanceof UnsupportedHostSystemDeviceBackend);
  assert.ok(createHostSystemDeviceBackend({ platformFamily: 'win32' }) instanceof UnsupportedHostSystemDeviceBackend);
});

test('unsupported host backends preserve explicit unsupported platform state', async () => {
  const backend = new UnsupportedHostSystemDeviceBackend('darwin');
  assert.deepEqual(await backend.privilegeState(), {
    state: 'unsupported-platform', reason: 'host-platform-backend-unsupported',
  });
  assert.deepEqual(await backend.enumerateDevices({ maxItems: 1, maxTextBytes: 8 }), {
    state: 'unsupported-platform', evidence: 'host-platform-backend-unsupported',
  });
  assert.deepEqual(await backend.enumerateVolumes({ maxItems: 1, maxTextBytes: 8 }), {
    state: 'unsupported-platform', evidence: 'host-platform-backend-unsupported',
  });
});

test('host adapter factory cannot accidentally advertise mutation capabilities', () => {
  for (const platformFamily of ['linux', 'darwin', 'win32'] as const) {
    const adapter = createHostSystemDeviceEnvironmentAdapter(`host-system-device-${platformFamily}`, { platformFamily });
    assert.deepEqual(adapter.descriptor.capabilities, ['device.observe', 'system.observe']);
  }
});

test('unsupported host mutation seam remains non-dispatching', async () => {
  const backend = new UnsupportedHostSystemDeviceBackend('win32');
  const target = { id: 'opaque-target', kind: 'system-setting-scope' as const, generation: 1 };
  assert.deepEqual(await backend.freshMutationBaseline(target, 'system.setting'), {
    state: 'unsupported-privilege', evidence: 'read-only-backend',
  });
});

test('Linux setting reads require backend-issued generation-aware scopes', async () => {
  const backend = createHostSystemDeviceBackend({ platformFamily: 'linux' });
  assert.ok(backend instanceof ScopeBoundLinuxSystemDeviceBackend);
  if (!(backend instanceof ScopeBoundLinuxSystemDeviceBackend)) return;

  const systemScope = backend.systemSettingScope();
  const securityScope = backend.securitySettingScope();
  assert.deepEqual(
    await backend.observeSystemSetting({ ...systemScope, generation: systemScope.generation + 1 }, 'system.efi.present'),
    { state: 'unsupported-privilege', evidence: 'system-setting-scope-stale' },
  );
  assert.deepEqual(
    await backend.observeSecuritySetting({ ...securityScope, id: 'fabricated-scope' }, 'security.apparmor'),
    { state: 'unsupported-privilege', evidence: 'security-setting-scope-stale' },
  );
});
