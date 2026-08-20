import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KernelVisibilityLinuxSystemDeviceBackend } from '../src/computer/kernelVisibilityLinuxSystemDeviceBackend.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'linux-kernel-visibility-'));
  const procRoot = join(root, 'proc');
  const sysClassRoot = join(root, 'class');
  const sysRoot = join(root, 'sys');
  await mkdir(join(procRoot, 'sys', 'kernel'), { recursive: true });
  await mkdir(sysClassRoot, { recursive: true });
  await mkdir(sysRoot, { recursive: true });
  return {
    root, procRoot, sysClassRoot, sysRoot,
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

test('kernel pointer and dmesg visibility restrictions expose coarse posture only', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.procRoot, 'sys', 'kernel', 'kptr_restrict'), '2\n');
    await writeFile(join(f.procRoot, 'sys', 'kernel', 'dmesg_restrict'), '1\n');
    const backend = new KernelVisibilityLinuxSystemDeviceBackend({
      platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
    });
    const scope = backend.securitySettingScope();

    for (const setting of ['security.kernel-pointer-restricted', 'security.dmesg-restricted']) {
      const observed = await backend.observeSecuritySetting(scope, setting);
      assert.equal(observed.state, 'ok');
      if (observed.state === 'ok') {
        assert.equal(observed.value.value, 'enabled');
        assert.equal(Object.isFrozen(observed.value), true);
        assert.equal(Object.isFrozen(observed.value.scope), true);
        assert.doesNotMatch(JSON.stringify(observed.value), /kptr_restrict|dmesg_restrict|\/proc\//);
      }
    }
  } finally {
    await f.cleanup();
  }
});

test('zero and malformed visibility scalars remain conservative', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.procRoot, 'sys', 'kernel', 'kptr_restrict'), '0\n');
    await writeFile(join(f.procRoot, 'sys', 'kernel', 'dmesg_restrict'), 'sensitive-policy-text\n');
    const backend = new KernelVisibilityLinuxSystemDeviceBackend({
      platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
    });
    const scope = backend.securitySettingScope();

    const kptr = await backend.observeSecuritySetting(scope, 'security.kernel-pointer-restricted');
    assert.equal(kptr.state, 'ok');
    if (kptr.state === 'ok') assert.equal(kptr.value.value, 'disabled');

    const dmesg = await backend.observeSecuritySetting(scope, 'security.dmesg-restricted');
    assert.equal(dmesg.state, 'ok');
    if (dmesg.state === 'ok') {
      assert.equal(dmesg.value.value, 'unknown');
      assert.doesNotMatch(JSON.stringify(dmesg.value), /sensitive-policy-text/);
    }
  } finally {
    await f.cleanup();
  }
});

test('missing visibility sources and stale scopes stay explicit', async () => {
  const f = await fixture();
  try {
    const backend = new KernelVisibilityLinuxSystemDeviceBackend({
      platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
    });
    const scope = backend.securitySettingScope();
    const missing = await backend.observeSecuritySetting(scope, 'security.kernel-pointer-restricted');
    assert.equal(missing.state, 'ok');
    if (missing.state === 'ok') assert.equal(missing.value.value, 'not-configured');

    assert.deepEqual(
      await backend.observeSecuritySetting({ ...scope, generation: scope.generation + 1 }, 'security.dmesg-restricted'),
      { state: 'unsupported-privilege', evidence: 'security-setting-scope-stale' },
    );
  } finally {
    await f.cleanup();
  }
});
