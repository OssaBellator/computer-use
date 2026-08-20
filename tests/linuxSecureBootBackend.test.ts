import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecureBootLinuxSystemDeviceBackend } from '../src/computer/secureBootLinuxSystemDeviceBackend.js';

const SECURE_BOOT_NAME = 'SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'linux-secure-boot-'));
  const procRoot = join(root, 'proc');
  const sysClassRoot = join(root, 'class');
  const sysRoot = join(root, 'sys');
  const efivars = join(sysRoot, 'firmware', 'efi', 'efivars');
  await mkdir(efivars, { recursive: true });
  await mkdir(sysClassRoot, { recursive: true });
  await mkdir(procRoot, { recursive: true });
  return {
    root, procRoot, sysClassRoot, sysRoot, efivars,
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

function backendFor(f: Awaited<ReturnType<typeof fixture>>) {
  return new SecureBootLinuxSystemDeviceBackend({
    platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
  });
}

test('canonical Secure Boot efivar is reduced to enabled posture without GUID leakage', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.efivars, SECURE_BOOT_NAME), Buffer.from([7, 0, 0, 0, 1]));
    const backend = backendFor(f);
    const scope = backend.securitySettingScope();
    const observed = await backend.observeSecuritySetting(scope, 'security.secure-boot');
    assert.equal(observed.state, 'ok');
    if (observed.state === 'ok') {
      assert.equal(observed.value.value, 'enabled');
      assert.equal(Object.isFrozen(observed.value), true);
      assert.equal(Object.isFrozen(observed.value.scope), true);
      assert.doesNotMatch(JSON.stringify(observed.value), /8be4df61|SecureBoot-|efivars/i);
    }
  } finally {
    await f.cleanup();
  }
});

test('canonical Secure Boot disabled and malformed efivars remain coarse', async () => {
  const f = await fixture();
  try {
    const path = join(f.efivars, SECURE_BOOT_NAME);
    await writeFile(path, Buffer.from([7, 0, 0, 0, 0]));
    const backend = backendFor(f);
    const scope = backend.securitySettingScope();
    const disabled = await backend.observeSecuritySetting(scope, 'security.secure-boot');
    assert.equal(disabled.state, 'ok');
    if (disabled.state === 'ok') assert.equal(disabled.value.value, 'disabled');

    await writeFile(path, Buffer.from([7, 0, 0]));
    const malformed = await backend.observeSecuritySetting(scope, 'security.secure-boot');
    assert.equal(malformed.state, 'ok');
    if (malformed.state === 'ok') {
      assert.equal(malformed.value.value, 'unknown');
      assert.doesNotMatch(JSON.stringify(malformed.value), /8be4df61|SecureBoot-/);
    }
  } finally {
    await f.cleanup();
  }
});

test('spoofed SecureBoot-prefixed efivars cannot prove security posture', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.efivars, 'SecureBoot-attacker-controlled-guid'), Buffer.from([7, 0, 0, 0, 1]));
    const backend = backendFor(f);
    const scope = backend.securitySettingScope();
    const observed = await backend.observeSecuritySetting(scope, 'security.secure-boot');
    assert.equal(observed.state, 'ok');
    if (observed.state === 'ok') {
      assert.equal(observed.value.value, 'not-configured');
      assert.doesNotMatch(JSON.stringify(observed.value), /attacker-controlled-guid|SecureBoot-/);
    }
  } finally {
    await f.cleanup();
  }
});

test('missing efivarfs and stale security scopes fail conservatively', async () => {
  const f = await fixture();
  try {
    const backend = backendFor(f);
    const scope = backend.securitySettingScope();
    await rm(f.efivars, { recursive: true, force: true });
    const absent = await backend.observeSecuritySetting(scope, 'security.secure-boot');
    assert.equal(absent.state, 'ok');
    if (absent.state === 'ok') assert.equal(absent.value.value, 'not-configured');

    assert.deepEqual(
      await backend.observeSecuritySetting({ ...scope, generation: scope.generation + 1 }, 'security.secure-boot'),
      { state: 'unsupported-privilege', evidence: 'security-setting-scope-stale' },
    );
  } finally {
    await f.cleanup();
  }
});
