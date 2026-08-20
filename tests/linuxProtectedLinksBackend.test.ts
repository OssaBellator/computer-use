import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtectedLinksLinuxSystemDeviceBackend } from '../src/computer/protectedLinksLinuxSystemDeviceBackend.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'linux-protected-links-'));
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
  return new ProtectedLinksLinuxSystemDeviceBackend({
    platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
  });
}

test('protected hardlink and symlink sysctls expose coarse enabled posture only', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.procRoot, 'sys', 'fs', 'protected_hardlinks'), '1\n');
    await writeFile(join(f.procRoot, 'sys', 'fs', 'protected_symlinks'), '1\n');
    const backend = backendFor(f);
    const scope = backend.securitySettingScope();

    for (const setting of ['security.protected-hardlinks', 'security.protected-symlinks']) {
      const observed = await backend.observeSecuritySetting(scope, setting);
      assert.equal(observed.state, 'ok');
      if (observed.state === 'ok') {
        assert.equal(observed.value.value, 'enabled');
        assert.equal(Object.isFrozen(observed.value), true);
        assert.equal(Object.isFrozen(observed.value.scope), true);
        assert.doesNotMatch(JSON.stringify(observed.value), /protected_hardlinks|protected_symlinks|\/proc\//);
      }
    }
  } finally {
    await f.cleanup();
  }
});

test('zero maps to disabled and unexpected protected-link values map to unknown', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.procRoot, 'sys', 'fs', 'protected_hardlinks'), '0\n');
    await writeFile(join(f.procRoot, 'sys', 'fs', 'protected_symlinks'), '2\nprivate-policy-text');
    const backend = backendFor(f);
    const scope = backend.securitySettingScope();

    const hardlinks = await backend.observeSecuritySetting(scope, 'security.protected-hardlinks');
    assert.equal(hardlinks.state, 'ok');
    if (hardlinks.state === 'ok') assert.equal(hardlinks.value.value, 'disabled');

    const symlinks = await backend.observeSecuritySetting(scope, 'security.protected-symlinks');
    assert.equal(symlinks.state, 'ok');
    if (symlinks.state === 'ok') {
      assert.equal(symlinks.value.value, 'unknown');
      assert.doesNotMatch(JSON.stringify(symlinks.value), /private-policy-text/);
    }
  } finally {
    await f.cleanup();
  }
});

test('missing protected-link sources and stale scopes remain explicit', async () => {
  const f = await fixture();
  try {
    const backend = backendFor(f);
    const scope = backend.securitySettingScope();
    const missing = await backend.observeSecuritySetting(scope, 'security.protected-hardlinks');
    assert.equal(missing.state, 'ok');
    if (missing.state === 'ok') assert.equal(missing.value.value, 'not-configured');

    assert.deepEqual(
      await backend.observeSecuritySetting({ ...scope, id: 'fabricated-protected-link-scope' }, 'security.protected-symlinks'),
      { state: 'unsupported-privilege', evidence: 'security-setting-scope-stale' },
    );
  } finally {
    await f.cleanup();
  }
});
