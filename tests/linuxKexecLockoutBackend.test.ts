import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KexecLockoutLinuxSystemDeviceBackend } from '../src/computer/kexecLockoutLinuxSystemDeviceBackend.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'linux-kexec-lockout-'));
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

function backendFor(f: Awaited<ReturnType<typeof fixture>>) {
  return new KexecLockoutLinuxSystemDeviceBackend({
    platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
  });
}

test('kexec loading lockout is exposed only as coarse enabled posture', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.procRoot, 'sys', 'kernel', 'kexec_load_disabled'), '1\n');
    const backend = backendFor(f);
    const scope = backend.securitySettingScope();
    const observed = await backend.observeSecuritySetting(scope, 'security.kexec-loading-disabled');
    assert.equal(observed.state, 'ok');
    if (observed.state === 'ok') {
      assert.equal(observed.value.value, 'enabled');
      assert.equal(Object.isFrozen(observed.value), true);
      assert.equal(Object.isFrozen(observed.value.scope), true);
      assert.doesNotMatch(JSON.stringify(observed.value), /kexec_load_disabled|\/proc\//);
    }
  } finally {
    await f.cleanup();
  }
});

test('zero kexec lockout maps to disabled and unexpected values remain unknown', async () => {
  const f = await fixture();
  try {
    const path = join(f.procRoot, 'sys', 'kernel', 'kexec_load_disabled');
    await writeFile(path, '0\n');
    const backend = backendFor(f);
    const scope = backend.securitySettingScope();
    const disabled = await backend.observeSecuritySetting(scope, 'security.kexec-loading-disabled');
    assert.equal(disabled.state, 'ok');
    if (disabled.state === 'ok') assert.equal(disabled.value.value, 'disabled');

    await writeFile(path, '2\nprivate-policy-material');
    const unknown = await backend.observeSecuritySetting(scope, 'security.kexec-loading-disabled');
    assert.equal(unknown.state, 'ok');
    if (unknown.state === 'ok') {
      assert.equal(unknown.value.value, 'unknown');
      assert.doesNotMatch(JSON.stringify(unknown.value), /private-policy-material/);
    }
  } finally {
    await f.cleanup();
  }
});

test('missing kexec lockout source and stale scopes remain explicit', async () => {
  const f = await fixture();
  try {
    const backend = backendFor(f);
    const scope = backend.securitySettingScope();
    const missing = await backend.observeSecuritySetting(scope, 'security.kexec-loading-disabled');
    assert.equal(missing.state, 'ok');
    if (missing.state === 'ok') assert.equal(missing.value.value, 'not-configured');

    assert.deepEqual(
      await backend.observeSecuritySetting({ ...scope, generation: scope.generation + 1 }, 'security.kexec-loading-disabled'),
      { state: 'unsupported-privilege', evidence: 'security-setting-scope-stale' },
    );
  } finally {
    await f.cleanup();
  }
});
