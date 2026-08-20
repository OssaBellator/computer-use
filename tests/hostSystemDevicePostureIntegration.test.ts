import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHostSystemDeviceBackend,
  createHostSystemDeviceEnvironmentAdapter,
} from '../src/computer/hostSystemDeviceBackend.js';
import { KernelVisibilityLinuxSystemDeviceBackend } from '../src/computer/kernelVisibilityLinuxSystemDeviceBackend.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'host-system-posture-integration-'));
  const procRoot = join(root, 'proc');
  const sysClassRoot = join(root, 'class');
  const sysRoot = join(root, 'sys');

  await mkdir(join(procRoot, 'self'), { recursive: true });
  await mkdir(join(procRoot, 'sys', 'kernel', 'yama'), { recursive: true });
  await mkdir(join(sysRoot, 'firmware', 'efi', 'efivars'), { recursive: true });
  await mkdir(join(sysRoot, 'module', 'apparmor', 'parameters'), { recursive: true });
  await mkdir(join(sysRoot, 'fs', 'selinux'), { recursive: true });
  await mkdir(join(sysRoot, 'kernel', 'security'), { recursive: true });
  await mkdir(join(sysRoot, 'fs', 'cgroup'), { recursive: true });
  await mkdir(sysClassRoot, { recursive: true });

  await writeFile(join(procRoot, 'swaps'), 'Filename\tType\tSize\tUsed\tPriority\n/dev/zram0 partition 1024 0 100\n');
  await writeFile(join(procRoot, 'self', 'mountinfo'), '42 31 8:1 / / ro,relatime - ext4 /dev/private-root rw\n');
  await writeFile(join(procRoot, 'sys', 'kernel', 'randomize_va_space'), '2\n');
  await writeFile(join(procRoot, 'sys', 'kernel', 'yama', 'ptrace_scope'), '1\n');
  await writeFile(join(procRoot, 'sys', 'kernel', 'modules_disabled'), '1\n');
  await writeFile(join(procRoot, 'sys', 'kernel', 'unprivileged_bpf_disabled'), '2\n');
  await writeFile(join(procRoot, 'sys', 'kernel', 'kptr_restrict'), '2\n');
  await writeFile(join(procRoot, 'sys', 'kernel', 'dmesg_restrict'), '1\n');

  await writeFile(join(sysRoot, 'module', 'apparmor', 'parameters', 'enabled'), 'Y\n');
  await writeFile(join(sysRoot, 'fs', 'selinux', 'enforce'), '1\n');
  await writeFile(join(sysRoot, 'kernel', 'security', 'lockdown'), 'none [integrity] confidentiality\n');
  await writeFile(join(sysRoot, 'fs', 'cgroup', 'cgroup.controllers'), 'cpu memory io\n');
  await writeFile(
    join(sysRoot, 'firmware', 'efi', 'efivars', 'SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c'),
    Buffer.from([7, 0, 0, 0, 1]),
  );

  return {
    root, procRoot, sysClassRoot, sysRoot,
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

test('production host selector composes all reviewed Linux system/security posture reads', async () => {
  const f = await fixture();
  try {
    const backend = createHostSystemDeviceBackend({
      platformFamily: 'linux',
      linux: { procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot },
    });
    assert.ok(backend instanceof KernelVisibilityLinuxSystemDeviceBackend);
    if (!(backend instanceof KernelVisibilityLinuxSystemDeviceBackend)) return;

    const systemScope = backend.systemSettingScope();
    const securityScope = backend.securitySettingScope();
    const systemExpectations: Readonly<Record<string, boolean>> = {
      'system.efi.present': true,
      'system.swap.enabled': true,
      'system.root-filesystem.read-only': true,
      'system.cgroup-v2.present': true,
    };
    for (const [setting, expected] of Object.entries(systemExpectations)) {
      const observed = await backend.observeSystemSetting(systemScope, setting);
      assert.equal(observed.state, 'ok', setting);
      if (observed.state === 'ok') assert.equal(observed.value.value, expected, setting);
    }

    const securitySettings = [
      'security.apparmor',
      'security.selinux',
      'security.lockdown',
      'security.aslr',
      'security.yama-ptrace',
      'security.module-loading-locked',
      'security.unprivileged-bpf-disabled',
      'security.secure-boot',
      'security.kernel-pointer-restricted',
      'security.dmesg-restricted',
    ];
    for (const setting of securitySettings) {
      const observed = await backend.observeSecuritySetting(securityScope, setting);
      assert.equal(observed.state, 'ok', setting);
      if (observed.state === 'ok') {
        assert.equal(observed.value.state, 'known', setting);
        assert.equal(observed.value.value, 'enabled', setting);
      }
    }

    const serialized = JSON.stringify({ systemScope, securityScope });
    assert.doesNotMatch(serialized, /private-root|zram|8be4df61|cpu memory io|\/dev\//i);
  } finally {
    await f.cleanup();
  }
});

test('fully composed production adapter still advertises observation only', async () => {
  const f = await fixture();
  try {
    const adapter = createHostSystemDeviceEnvironmentAdapter('host-system-posture', {
      platformFamily: 'linux',
      linux: { procRoot: f.procRoot, sysClassRoot: f.sysClassRoot, sysRoot: f.sysRoot },
    });
    assert.deepEqual(adapter.descriptor.capabilities, ['device.observe', 'system.observe']);
    assert.equal(adapter.descriptor.capabilities.some((capability) => /change|configure|modify|partition|firmware/i.test(capability)), false);
  } finally {
    await f.cleanup();
  }
});
