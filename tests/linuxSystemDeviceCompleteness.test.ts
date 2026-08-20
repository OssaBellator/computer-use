import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostSystemDeviceEnvironmentAdapter } from '../src/computer/hostSystemDeviceBackend.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'linux-system-completeness-'));
  const sysClassRoot = join(root, 'class');
  const procRoot = join(root, 'proc');
  const sysRoot = join(root, 'sys');
  await mkdir(sysClassRoot, { recursive: true });
  await mkdir(join(procRoot, 'self'), { recursive: true });
  await mkdir(sysRoot, { recursive: true });
  return {
    root, sysClassRoot, procRoot, sysRoot,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function adapterFor(f: Awaited<ReturnType<typeof fixture>>) {
  return createHostSystemDeviceEnvironmentAdapter('linux-completeness', {
    platformFamily: 'linux',
    linux: { sysClassRoot: f.sysClassRoot, procRoot: f.procRoot, sysRoot: f.sysRoot },
  });
}

test('bounded mountinfo prefix cannot produce a complete neutral observation', async () => {
  const f = await fixture();
  try {
    const line = '42 31 8:1 / / rw,relatime - ext4 /dev/root rw\n';
    await writeFile(join(f.procRoot, 'self', 'mountinfo'), line.repeat(32));
    const result = await adapterFor(f).observe({
      adapterId: 'linux-completeness', channel: 'device', limits: { maxItems: 8, maxTextBytes: 128 },
    });
    const data = result.data as { access: { state: string; reason?: string }; volumes: readonly unknown[] };
    assert.equal(result.complete, false);
    assert.equal(data.access.state, 'unsupported-privilege');
    assert.equal(data.access.reason, 'volume-enumeration-truncated');
    assert.deepEqual(data.volumes, []);
  } finally {
    await f.cleanup();
  }
});

test('partially inaccessible device classes fail closed instead of looking complete', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.sysClassRoot, 'input'), { recursive: true });
    await writeFile(join(f.sysClassRoot, 'input', 'event-private-native-name'), 'fixture');
    await writeFile(join(f.sysClassRoot, 'sound'), 'not-a-directory');
    await writeFile(join(f.procRoot, 'self', 'mountinfo'), '');

    const result = await adapterFor(f).observe({
      adapterId: 'linux-completeness', channel: 'device', limits: { maxItems: 8, maxTextBytes: 1024 },
    });
    const encoded = JSON.stringify(result.data);
    const data = result.data as { access: { state: string; reason?: string }; devices: readonly unknown[] };
    assert.equal(result.complete, false);
    assert.equal(data.access.state, 'unsupported-privilege');
    assert.equal(data.access.reason, 'device-enumeration-incomplete');
    assert.deepEqual(data.devices, []);
    assert.doesNotMatch(encoded, /event-private-native-name/);
  } finally {
    await f.cleanup();
  }
});
