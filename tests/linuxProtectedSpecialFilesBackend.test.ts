import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtectedSpecialFilesLinuxSystemDeviceBackend } from '../src/computer/protectedSpecialFilesLinuxSystemDeviceBackend.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'linux-protected-special-'));
  const procRoot = join(root, 'proc');
  const sysClassRoot = join(root, 'class');
  const sysRoot = join(root, 'sys');
  await mkdir(join(procRoot, 'sys', 'fs'), { recursive: true });
  await mkdir(sysClassRoot, { recursive: true });
  await mkdir(sysRoot, { recursive: true });
  return {
    root, procRoot, sysClassRoot, sysRoot,
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

function backendFor(f: Awaited<ReturnType<typeof fixture>>) {
  return new ProtectedSpecialFilesLinuxSystemDeviceBackend({
    platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
  });
}

test('protected FIFO and regular-file levels expose enabled posture only', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.procRoot, 'sys', 'fs', 'protected_fifos'), '1\n');
    await writeFile(join(f.procRoot, 'sys', 'fs', 'protected_regular'), '2\n');
    const backend = backendFor(f);
    const scope = backend.securitySettingScope();

    for (const setting of ['security.protected-fifos', 'security.protected-regular-files']) {
      const observed = await backend.observeSecuritySetting(scope, setting);
      assert.equal(observed.state, 'ok');
      if (observed.state === 'ok') {
        assert.equal(observed.value.value, 'enabled');
        assert.equal(Object.isFrozen(observed.value), true);
        assert.equal(Object.isFrozen(observed.value.scope), true);
        assert.doesNotMatch(JSON.stringify(observed.value), /protected_fifos|protected_regular|\/proc\//);
      }
    }
  } finally {
    await f.cleanup();
  }
});

test('zero special-file protection maps to disabled and unexpected values remain unknown', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.procRoot, 'sys', 'fs', 'protected_fifos'), '0\n');
    await writeFile(join(f.procRoot, 'sys', 'fs', 'protected_regular'), '3\nprivate-policy-material');
    const backend = backendFor(f);
    const scope = backend.securitySettingScope();

    const fifo = await backend.observeSecuritySetting(scope, 'security.protected-fifos');
    assert.equal(fifo.state, 'ok');
    if (fifo.state === 'ok') assert.equal(fifo.value.value, 'disabled');

    const regular = await backend.observeSecuritySetting(scope, 'security.protected-regular-files');
    assert.equal(regular.state, 'ok');
    if (regular.state === 'ok') {
      assert.equal(regular.value.value, 'unknown');
      assert.doesNotMatch(JSON.stringify(regular.value), /private-policy-material/);
    }
  } finally {
    await f.cleanup();
  }
});

test('missing protected special-file sources and stale scopes remain explicit', async () => {
  const f = await fixture();
  try {
    const backend = backendFor(f);
    const scope = backend.securitySettingScope();
    const missing = await backend.observeSecuritySetting(scope, 'security.protected-fifos');
    assert.equal(missing.state, 'ok');
    if (missing.state === 'ok') assert.equal(missing.value.value, 'not-configured');

    assert.deepEqual(
      await backend.observeSecuritySetting({ ...scope, generation: scope.generation + 1 }, 'security.protected-regular-files'),
      { state: 'unsupported-privilege', evidence: 'security-setting-scope-stale' },
    );
  } finally {
    await f.cleanup();
  }
});
