import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemPostureLinuxSystemDeviceBackend } from '../src/computer/systemPostureLinuxSystemDeviceBackend.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'linux-system-posture-'));
  const procRoot = join(root, 'proc');
  const sysClassRoot = join(root, 'class');
  const sysRoot = join(root, 'sys');
  await mkdir(join(procRoot, 'self'), { recursive: true });
  await mkdir(sysClassRoot, { recursive: true });
  await mkdir(sysRoot, { recursive: true });
  return {
    root, procRoot, sysClassRoot, sysRoot,
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

test('root filesystem posture returns a boolean without mount identity text', async () => {
  const f = await fixture();
  try {
    const sensitiveSource = '/dev/disk/by-id/SERIAL-PRIVATE-HOST-DISK';
    await writeFile(
      join(f.procRoot, 'self', 'mountinfo'),
      `42 31 8:1 / / ro,relatime - ext4 ${sensitiveSource} rw\n`,
    );
    const backend = new SystemPostureLinuxSystemDeviceBackend({
      platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
    });
    const scope = backend.systemSettingScope();
    const observed = await backend.observeSystemSetting(scope, 'system.root-filesystem.read-only');
    assert.equal(observed.state, 'ok');
    if (observed.state === 'ok') {
      assert.equal(observed.value.state, 'known');
      assert.equal(observed.value.value, true);
      assert.equal(Object.isFrozen(observed.value), true);
      assert.equal(Object.isFrozen(observed.value.scope), true);
      assert.doesNotMatch(JSON.stringify(observed.value), /SERIAL|\/dev\/disk|mountinfo/i);
    }
  } finally {
    await f.cleanup();
  }
});

test('cgroup v2 presence is observed without cgroup/container identifiers', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.sysRoot, 'fs', 'cgroup'), { recursive: true });
    await writeFile(join(f.sysRoot, 'fs', 'cgroup', 'cgroup.controllers'), 'cpu memory io\n');
    const backend = new SystemPostureLinuxSystemDeviceBackend({
      platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
    });
    const scope = backend.systemSettingScope();
    const present = await backend.observeSystemSetting(scope, 'system.cgroup-v2.present');
    assert.equal(present.state, 'ok');
    if (present.state === 'ok') {
      assert.equal(present.value.value, true);
      assert.doesNotMatch(JSON.stringify(present.value), /cpu memory io|cgroup\.controllers/);
    }

    await rm(join(f.sysRoot, 'fs', 'cgroup', 'cgroup.controllers'), { force: true });
    const absent = await backend.observeSystemSetting(scope, 'system.cgroup-v2.present');
    assert.equal(absent.state, 'ok');
    if (absent.state === 'ok') assert.equal(absent.value.value, false);
  } finally {
    await f.cleanup();
  }
});

test('incomplete root mount acquisition stays unknown and fabricated scope fails closed', async () => {
  const f = await fixture();
  try {
    const filler = '9'.repeat(9000);
    await writeFile(join(f.procRoot, 'self', 'mountinfo'), `${filler}\n42 31 8:1 / / rw - ext4 /dev/root rw\n`);
    const backend = new SystemPostureLinuxSystemDeviceBackend({
      platformFamily: 'linux', procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot,
    });
    const scope = backend.systemSettingScope();
    const bounded = await backend.observeSystemSetting(scope, 'system.root-filesystem.read-only');
    assert.equal(bounded.state, 'ok');
    if (bounded.state === 'ok') {
      assert.equal(bounded.value.state, 'unknown');
      assert.equal(bounded.value.value, undefined);
    }

    assert.deepEqual(
      await backend.observeSystemSetting({ ...scope, generation: scope.generation + 1 }, 'system.cgroup-v2.present'),
      { state: 'unsupported-privilege', evidence: 'system-setting-scope-stale' },
    );
  } finally {
    await f.cleanup();
  }
});
