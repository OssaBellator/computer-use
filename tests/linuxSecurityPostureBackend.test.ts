import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostureLinuxSystemDeviceBackend } from '../src/computer/postureLinuxSystemDeviceBackend.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'linux-security-posture-'));
  const procRoot = join(root, 'proc');
  const sysClassRoot = join(root, 'class');
  const sysRoot = join(root, 'sys');
  await mkdir(join(procRoot, 'sys', 'kernel', 'yama'), { recursive: true });
  await mkdir(sysClassRoot, { recursive: true });
  await mkdir(sysRoot, { recursive: true });
  return {
    root, procRoot, sysClassRoot, sysRoot,
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

test('coarse ASLR and ptrace observations expose posture only', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.procRoot, 'sys', 'kernel', 'randomize_va_space'), '2\n');
    await writeFile(join(f.procRoot, 'sys', 'kernel', 'yama', 'ptrace_scope'), '1\n');
    const backend = new PostureLinuxSystemDeviceBackend({
      platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
    });
    const scope = backend.securitySettingScope();

    const aslr = await backend.observeSecuritySetting(scope, 'security.aslr');
    assert.equal(aslr.state, 'ok');
    if (aslr.state === 'ok') {
      assert.equal(aslr.value.value, 'enabled');
      assert.equal(Object.isFrozen(aslr.value), true);
      assert.equal(Object.isFrozen(aslr.value.scope), true);
      assert.doesNotMatch(JSON.stringify(aslr.value), /randomize_va_space|\/proc\//);
    }

    const ptrace = await backend.observeSecuritySetting(scope, 'security.yama-ptrace');
    assert.equal(ptrace.state, 'ok');
    if (ptrace.state === 'ok') {
      assert.equal(ptrace.value.value, 'enabled');
      assert.doesNotMatch(JSON.stringify(ptrace.value), /ptrace_scope|\/proc\//);
    }
  } finally {
    await f.cleanup();
  }
});

test('zero posture scalars map only to disabled and malformed values map to unknown', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.procRoot, 'sys', 'kernel', 'randomize_va_space'), '0\n');
    await writeFile(join(f.procRoot, 'sys', 'kernel', 'yama', 'ptrace_scope'), 'policy-details-must-not-leak\n');
    const backend = new PostureLinuxSystemDeviceBackend({
      platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
    });
    const scope = backend.securitySettingScope();

    const aslr = await backend.observeSecuritySetting(scope, 'security.aslr');
    assert.equal(aslr.state, 'ok');
    if (aslr.state === 'ok') assert.equal(aslr.value.value, 'disabled');

    const ptrace = await backend.observeSecuritySetting(scope, 'security.yama-ptrace');
    assert.equal(ptrace.state, 'ok');
    if (ptrace.state === 'ok') {
      assert.equal(ptrace.value.value, 'unknown');
      assert.doesNotMatch(JSON.stringify(ptrace.value), /policy-details/);
    }
  } finally {
    await f.cleanup();
  }
});

test('missing posture sources stay explicit and stale scopes fail before reads', async () => {
  const f = await fixture();
  try {
    const backend = new PostureLinuxSystemDeviceBackend({
      platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
    });
    const scope = backend.securitySettingScope();
    const missing = await backend.observeSecuritySetting(scope, 'security.aslr');
    assert.equal(missing.state, 'ok');
    if (missing.state === 'ok') assert.equal(missing.value.value, 'not-configured');

    assert.deepEqual(
      await backend.observeSecuritySetting({ ...scope, generation: scope.generation + 1 }, 'security.aslr'),
      { state: 'unsupported-privilege', evidence: 'security-setting-scope-stale' },
    );
  } finally {
    await f.cleanup();
  }
});
