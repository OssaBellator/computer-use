import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostSystemDeviceEnvironmentAdapter } from '../src/computer/hostSystemDeviceBackend.js';
import type { BoundedDeviceMetadata, BoundedVolumeMetadata } from '../src/computer/systemDeviceAdapter.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'linux-enumeration-completeness-'));
  const procRoot = join(root, 'proc');
  const sysClassRoot = join(root, 'class');
  const sysRoot = join(root, 'sys');
  await mkdir(join(procRoot, 'self'), { recursive: true });
  await mkdir(sysClassRoot, { recursive: true });
  await mkdir(sysRoot, { recursive: true });
  await writeFile(join(procRoot, 'self', 'mountinfo'), '');
  return {
    root, procRoot, sysClassRoot, sysRoot,
    adapter() {
      return createHostSystemDeviceEnvironmentAdapter('truthful-linux-host', {
        platformFamily: 'linux',
        linux: { procRoot, sysClassRoot, sysRoot },
      });
    },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

test('item-limited device acquisition reports incomplete and truncated', async () => {
  const f = await fixture();
  try {
    const input = join(f.sysClassRoot, 'input');
    await mkdir(input, { recursive: true });
    for (const name of ['SERIAL-secret-a', 'SERIAL-secret-b', 'SERIAL-secret-c']) {
      await writeFile(join(input, name), name);
    }
    const observed = await f.adapter().observe({
      adapterId: 'truthful-linux-host', channel: 'device', limits: { maxItems: 1, maxTextBytes: 1024 },
    });
    const data = observed.data as { devices: readonly BoundedDeviceMetadata[]; volumes: readonly BoundedVolumeMetadata[] };
    assert.equal(observed.complete, false);
    assert.equal(observed.truncated, true);
    assert.equal(data.devices.length, 1);
    assert.equal(data.volumes.length, 0);
    assert.doesNotMatch(JSON.stringify(observed.data), /SERIAL|secret/i);
  } finally {
    await f.cleanup();
  }
});

test('text-limited device acquisition reports incomplete without leaking native names', async () => {
  const f = await fixture();
  try {
    const input = join(f.sysClassRoot, 'input');
    await mkdir(input, { recursive: true });
    await writeFile(join(input, 'native-sensitive-device-name'), 'x');
    const observed = await f.adapter().observe({
      adapterId: 'truthful-linux-host', channel: 'device', limits: { maxItems: 16, maxTextBytes: 1 },
    });
    const data = observed.data as { devices: readonly BoundedDeviceMetadata[] };
    assert.equal(observed.complete, false);
    assert.equal(observed.truncated, true);
    assert.equal(data.devices.length, 0);
    assert.doesNotMatch(JSON.stringify(observed.data), /native-sensitive-device-name/);
  } finally {
    await f.cleanup();
  }
});

test('bounded mountinfo prefix exhaustion reports incomplete inventory', async () => {
  const f = await fixture();
  try {
    const sensitive = '/dev/disk/by-id/SERIAL-PRIVATE-VOLUME';
    await writeFile(
      join(f.procRoot, 'self', 'mountinfo'),
      `42 31 8:1 / / rw,relatime - ext4 ${sensitive} rw\n`.repeat(8),
    );
    const observed = await f.adapter().observe({
      adapterId: 'truthful-linux-host', channel: 'device', limits: { maxItems: 8, maxTextBytes: 12 },
    });
    const data = observed.data as { volumes: readonly BoundedVolumeMetadata[] };
    assert.equal(observed.complete, false);
    assert.equal(observed.truncated, true);
    assert.equal(data.volumes.length, 0);
    assert.doesNotMatch(JSON.stringify(observed.data), /SERIAL-PRIVATE-VOLUME|\/dev\/disk/);
  } finally {
    await f.cleanup();
  }
});

test('fully acquired finite inventory remains complete and frozen', async () => {
  const f = await fixture();
  try {
    const input = join(f.sysClassRoot, 'input');
    await mkdir(input, { recursive: true });
    await writeFile(join(input, 'private-native-input-id'), 'x');
    await writeFile(
      join(f.procRoot, 'self', 'mountinfo'),
      '42 31 8:1 / / rw,relatime - ext4 /dev/private-root-source rw\n',
    );
    const observed = await f.adapter().observe({
      adapterId: 'truthful-linux-host', channel: 'device', limits: { maxItems: 8, maxTextBytes: 4096 },
    });
    const data = observed.data as { devices: readonly BoundedDeviceMetadata[]; volumes: readonly BoundedVolumeMetadata[] };
    assert.equal(observed.complete, true);
    assert.equal(observed.truncated, false);
    assert.equal(data.devices.length, 1);
    assert.equal(data.volumes.length, 1);
    assert.equal(Object.isFrozen(data.devices[0]), true);
    assert.equal(Object.isFrozen(data.devices[0]?.identity), true);
    assert.equal(Object.isFrozen(data.volumes[0]), true);
    assert.equal(Object.isFrozen(data.volumes[0]?.identity), true);
    assert.doesNotMatch(JSON.stringify(observed.data), /private-native-input-id|private-root-source|\/dev\//i);
  } finally {
    await f.cleanup();
  }
});
