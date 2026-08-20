import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KernelPostureLinuxSystemDeviceBackend } from '../src/computer/kernelPostureLinuxSystemDeviceBackend.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'linux-kernel-posture-'));
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

test('kernel module loading lock and unprivileged BPF are exposed as coarse posture', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.procRoot, 'sys', 'kernel', 'modules_disabled'), '1\n');
    await writeFile(join(f.procRoot, 'sys', 'kernel', 'unprivileged_bpf_disabled'), '2\n');
    const backend = new KernelPostureLinuxSystemDeviceBackend({
      platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
    });
    const scope = backend.securitySettingScope();

    for (const setting of ['security.module-loading-locked', 'security.unprivileged-bpf-disabled']) {
      const observed = await backend.observeSecuritySetting(scope, setting);
      assert.equal(observed.state, 'ok');
      if (observed.state === 'ok') {
        assert.equal(observed.value.value, 'enabled');
        assert.equal(Object.isFrozen(observed.value), true);
        assert.equal(Object.isFrozen(observed.value.scope), true);
        assert.doesNotMatch(JSON.stringify(observed.value), /modules_disabled|unprivileged_bpf_disabled|\/proc\//);
      }
    }
  } finally {
    await f.cleanup();
  }
});

test('zero kernel posture scalars map to disabled without exposing raw values', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.procRoot, 'sys', 'kernel', 'modules_disabled'), '0\n');
    await writeFile(join(f.procRoot, 'sys', 'kernel', 'unprivileged_bpf_disabled'), '0\n');
    const backend = new KernelPostureLinuxSystemDeviceBackend({
      platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
    });
    const scope = backend.securitySettingScope();

    const modules = await backend.observeSecuritySetting(scope, 'security.module-loading-locked');
    assert.equal(modules.state, 'ok');
    if (modules.state === 'ok') assert.equal(modules.value.value, 'disabled');
    const bpf = await backend.observeSecuritySetting(scope, 'security.unprivileged-bpf-disabled');
    assert.equal(bpf.state, 'ok');
    if (bpf.state === 'ok') assert.equal(bpf.value.value, 'disabled');
  } finally {
    await f.cleanup();
  }
});

test('missing kernel posture sources and stale scope states remain explicit', async () => {
  const f = await fixture();
  try {
    const backend = new KernelPostureLinuxSystemDeviceBackend({
      platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
    });
    const scope = backend.securitySettingScope();
    const missing = await backend.observeSecuritySetting(scope, 'security.module-loading-locked');
    assert.equal(missing.state, 'ok');
    if (missing.state === 'ok') assert.equal(missing.value.value, 'not-configured');

    assert.deepEqual(
      await backend.observeSecuritySetting({ ...scope, id: 'fabricated-kernel-scope' }, 'security.unprivileged-bpf-disabled'),
      { state: 'unsupported-privilege', evidence: 'security-setting-scope-stale' },
    );
  } finally {
    await f.cleanup();
  }
});
