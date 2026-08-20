import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LinuxSystemDeviceBackend,
  createLinuxSystemDeviceEnvironmentAdapter,
} from '../src/computer/linuxSystemDeviceBackend.js';

async function fixture(): Promise<{
  root: string;
  sysClassRoot: string;
  procRoot: string;
  sysRoot: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'linux-system-device-'));
  const sysClassRoot = join(root, 'class');
  const procRoot = join(root, 'proc');
  const sysRoot = join(root, 'sys');
  await mkdir(sysClassRoot, { recursive: true });
  await mkdir(join(procRoot, 'self'), { recursive: true });
  await mkdir(sysRoot, { recursive: true });
  return {
    root,
    sysClassRoot,
    procRoot,
    sysRoot,
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

test('linux backend reports bounded host system information without host identity text', async () => {
  const backend = new LinuxSystemDeviceBackend({ platformFamily: 'linux' });
  const result = await backend.systemInformation();
  assert.equal(result.state, 'ok');
  if (result.state !== 'ok') return;
  assert.equal(result.value.platformFamily, 'linux');
  assert.ok(result.value.logicalProcessorCount === undefined || result.value.logicalProcessorCount >= 0);
  assert.ok(result.value.totalMemoryBytes === undefined || result.value.totalMemoryBytes >= 0);
  const encoded = JSON.stringify(result.value);
  assert.equal(encoded.includes('hostname'), false);
  assert.equal(encoded.includes('username'), false);
});

test('device enumeration honors producer acquisition budgets and keeps native names out of neutral IDs', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.sysClassRoot, 'input'), { recursive: true });
    await writeFile(join(f.sysClassRoot, 'input', 'SERIAL-user-host-secret-a'), 'a');
    await writeFile(join(f.sysClassRoot, 'input', 'SERIAL-user-host-secret-b'), 'b');
    await writeFile(join(f.sysClassRoot, 'input', 'SERIAL-user-host-secret-c'), 'c');
    const backend = new LinuxSystemDeviceBackend({
      platformFamily: 'linux', sysClassRoot: f.sysClassRoot, procRoot: f.procRoot, sysRoot: f.sysRoot,
    });

    const bounded = await backend.enumerateDevices({ maxItems: 1, maxTextBytes: 1024 });
    assert.equal(bounded.state, 'ok');
    if (bounded.state !== 'ok') return;
    assert.equal(bounded.value.length, 1);
    assert.equal(Object.isFrozen(bounded.value), true);
    assert.equal(Object.isFrozen(bounded.value[0]), true);
    assert.equal(Object.isFrozen(bounded.value[0]?.identity), true);
    assert.doesNotMatch(JSON.stringify(bounded.value), /SERIAL|user|host|secret/i);

    const textStarved = await backend.enumerateDevices({ maxItems: 16, maxTextBytes: 1 });
    assert.equal(textStarved.state, 'ok');
    if (textStarved.state === 'ok') assert.equal(textStarved.value.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('device locator replacement preserves opaque identity and advances generation', async () => {
  const f = await fixture();
  try {
    const inputDir = join(f.sysClassRoot, 'input');
    await mkdir(inputDir, { recursive: true });
    const locator = join(inputDir, 'event-secret-native-id');
    await writeFile(locator, 'first');
    const backend = new LinuxSystemDeviceBackend({
      platformFamily: 'linux', sysClassRoot: f.sysClassRoot, procRoot: f.procRoot, sysRoot: f.sysRoot,
    });

    const first = await backend.enumerateDevices({ maxItems: 8, maxTextBytes: 1024 });
    assert.equal(first.state, 'ok');
    if (first.state !== 'ok' || first.value.length !== 1) return;
    const before = first.value[0]!.identity;

    await rm(locator, { force: true });
    await writeFile(locator, 'replacement-with-different-size');
    const second = await backend.enumerateDevices({ maxItems: 8, maxTextBytes: 1024 });
    assert.equal(second.state, 'ok');
    if (second.state !== 'ok' || second.value.length !== 1) return;
    const after = second.value[0]!.identity;

    assert.equal(after.id, before.id);
    assert.ok(after.generation > before.generation);
    assert.doesNotMatch(after.id, /event|secret|native/i);
  } finally {
    await f.cleanup();
  }
});

test('volume enumeration reads only the supplied prefix budget and never exposes mount source or mount path', async () => {
  const f = await fixture();
  try {
    const sensitiveSource = '/dev/disk/by-id/SERIAL-DO-NOT-EXPOSE';
    const mountInfo = `42 31 8:1 / / rw,relatime - ext4 ${sensitiveSource} rw\n` +
      '43 31 0:5 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw\n';
    await writeFile(join(f.procRoot, 'self', 'mountinfo'), mountInfo);
    const backend = new LinuxSystemDeviceBackend({
      platformFamily: 'linux', sysClassRoot: f.sysClassRoot, procRoot: f.procRoot, sysRoot: f.sysRoot,
    });

    const tiny = await backend.enumerateVolumes({ maxItems: 8, maxTextBytes: 12 });
    assert.equal(tiny.state, 'ok');
    if (tiny.state === 'ok') assert.equal(tiny.value.length, 0);

    const result = await backend.enumerateVolumes({ maxItems: 1, maxTextBytes: 1024 });
    assert.equal(result.state, 'ok');
    if (result.state !== 'ok') return;
    assert.equal(result.value.length, 1);
    assert.equal(result.value[0]?.filesystemType, 'ext4');
    assert.doesNotMatch(JSON.stringify(result.value), /SERIAL-DO-NOT-EXPOSE|\/dev\/disk|mount/i);
  } finally {
    await f.cleanup();
  }
});

test('coarse system and security observations expose posture enums rather than configuration text', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.procRoot, 'swaps'), 'Filename\tType\tSize\tUsed\tPriority\n/dev/zram0 partition 1024 0 100\n');
    await mkdir(join(f.sysRoot, 'firmware', 'efi'), { recursive: true });
    await mkdir(join(f.sysRoot, 'module', 'apparmor', 'parameters'), { recursive: true });
    await writeFile(join(f.sysRoot, 'module', 'apparmor', 'parameters', 'enabled'), 'Y\nraw-policy-must-not-leak');
    await mkdir(join(f.sysRoot, 'fs', 'selinux'), { recursive: true });
    await writeFile(join(f.sysRoot, 'fs', 'selinux', 'enforce'), '1\n');
    await mkdir(join(f.sysRoot, 'kernel', 'security'), { recursive: true });
    await writeFile(join(f.sysRoot, 'kernel', 'security', 'lockdown'), 'none [integrity] confidentiality\n');

    const backend = new LinuxSystemDeviceBackend({
      platformFamily: 'linux', sysClassRoot: f.sysClassRoot, procRoot: f.procRoot, sysRoot: f.sysRoot,
    });
    const systemScope = backend.systemSettingScope();
    const securityScope = backend.securitySettingScope();

    const swap = await backend.observeSystemSetting(systemScope, 'system.swap.enabled');
    assert.equal(swap.state, 'ok');
    if (swap.state === 'ok') assert.equal(swap.value.value, true);
    const efi = await backend.observeSystemSetting(systemScope, 'system.efi.present');
    assert.equal(efi.state, 'ok');
    if (efi.state === 'ok') assert.equal(efi.value.value, true);

    for (const setting of ['security.apparmor', 'security.selinux', 'security.lockdown']) {
      const result = await backend.observeSecuritySetting(securityScope, setting);
      assert.equal(result.state, 'ok');
      if (result.state === 'ok') {
        assert.equal(result.value.state, 'known');
        assert.ok(['enabled', 'disabled', 'managed', 'not-configured', 'unknown'].includes(result.value.value ?? 'unknown'));
        assert.doesNotMatch(JSON.stringify(result.value), /raw-policy|confidentiality/);
      }
    }
  } finally {
    await f.cleanup();
  }
});

test('unsupported platforms remain explicit and the production adapter advertises no mutation capability', async () => {
  const unsupported = new LinuxSystemDeviceBackend({ platformFamily: 'darwin' });
  assert.deepEqual(await unsupported.privilegeState(), {
    state: 'unsupported-platform', reason: 'linux-backend-on-non-linux',
  });
  assert.deepEqual(await unsupported.systemInformation(), {
    state: 'unsupported-platform', evidence: 'linux-backend-on-non-linux',
  });

  const adapter = createLinuxSystemDeviceEnvironmentAdapter('linux-system-device');
  assert.equal(adapter.descriptor.capabilities.includes('device.observe'), true);
  assert.equal(adapter.descriptor.capabilities.includes('system.observe'), true);
  assert.equal(adapter.descriptor.capabilities.includes('device.peripheral.configure'), false);
  assert.equal(adapter.descriptor.capabilities.includes('system.setting.change'), false);
  assert.equal(adapter.descriptor.capabilities.includes('security.setting.change'), false);
});

test('linux backend mutation methods fail closed without privileged dispatch', async () => {
  const backend = new LinuxSystemDeviceBackend({ platformFamily: 'linux' });
  const target = backend.systemSettingScope();
  const baseline = await backend.freshMutationBaseline(target, 'system.swap.enabled');
  assert.deepEqual(baseline, { state: 'unsupported-privilege', evidence: 'read-only-backend' });
  assert.equal(backend.mutationSupport, 'none');
});
