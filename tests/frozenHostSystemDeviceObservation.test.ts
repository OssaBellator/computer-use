import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostSystemDeviceEnvironmentAdapter } from '../src/computer/hostSystemDeviceBackend.js';
import type {
  BoundedDeviceMetadata,
  BoundedSystemInformation,
  BoundedVolumeMetadata,
  SystemDevicePrivilegeState,
} from '../src/computer/systemDeviceAdapter.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'frozen-host-system-device-'));
  const procRoot = join(root, 'proc');
  const sysClassRoot = join(root, 'class');
  const sysRoot = join(root, 'sys');
  await mkdir(join(procRoot, 'self'), { recursive: true });
  await mkdir(join(sysClassRoot, 'input'), { recursive: true });
  await mkdir(sysRoot, { recursive: true });
  await writeFile(join(sysClassRoot, 'input', 'private-native-input'), 'x');
  await writeFile(
    join(procRoot, 'self', 'mountinfo'),
    '42 31 8:1 / / rw,relatime - ext4 /dev/private-native-root rw\n',
  );
  return {
    root, procRoot, sysClassRoot, sysRoot,
    adapter() {
      return createHostSystemDeviceEnvironmentAdapter('frozen-host', {
        platformFamily: 'linux', linux: { procRoot, sysClassRoot, sysRoot },
      });
    },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

test('complete production host observation is finite-schema copied and deeply frozen', async () => {
  const f = await fixture();
  try {
    const observed = await f.adapter().observe({
      adapterId: 'frozen-host', channel: 'device', limits: { maxItems: 8, maxTextBytes: 4096 },
    });
    const data = observed.data as {
      access: SystemDevicePrivilegeState;
      system?: BoundedSystemInformation;
      devices: readonly BoundedDeviceMetadata[];
      volumes: readonly BoundedVolumeMetadata[];
    };

    assert.equal(observed.complete, true);
    assert.equal(Object.isFrozen(observed), true);
    assert.equal(Object.isFrozen(data), true);
    assert.equal(Object.isFrozen(data.access), true);
    assert.equal(Object.isFrozen(data.system), true);
    assert.equal(Object.isFrozen(data.devices), true);
    assert.equal(Object.isFrozen(data.devices[0]), true);
    assert.equal(Object.isFrozen(data.devices[0]?.identity), true);
    assert.equal(Object.isFrozen(data.volumes), true);
    assert.equal(Object.isFrozen(data.volumes[0]), true);
    assert.equal(Object.isFrozen(data.volumes[0]?.identity), true);
    assert.deepEqual(Object.keys(data).sort(), ['access', 'devices', 'system', 'volumes']);
    assert.doesNotMatch(JSON.stringify(data), /private-native-input|private-native-root|\/dev\//i);

    assert.throws(() => {
      (data.devices as BoundedDeviceMetadata[])[0]!.state = 'busy';
    }, TypeError);
  } finally {
    await f.cleanup();
  }
});

test('truncated production host observation remains deeply frozen', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.sysClassRoot, 'input', 'second-private-input'), 'y');
    const observed = await f.adapter().observe({
      adapterId: 'frozen-host', channel: 'device', limits: { maxItems: 1, maxTextBytes: 1024 },
    });
    const data = observed.data as {
      access: SystemDevicePrivilegeState;
      devices: readonly BoundedDeviceMetadata[];
      volumes: readonly BoundedVolumeMetadata[];
    };

    assert.equal(observed.complete, false);
    assert.equal(observed.truncated, true);
    assert.equal(Object.isFrozen(observed), true);
    assert.equal(Object.isFrozen(data), true);
    assert.equal(Object.isFrozen(data.access), true);
    assert.equal(Object.isFrozen(data.devices), true);
    assert.equal(Object.isFrozen(data.devices[0]), true);
    assert.equal(Object.isFrozen(data.devices[0]?.identity), true);
    assert.equal(Object.isFrozen(data.volumes), true);
    assert.doesNotMatch(JSON.stringify(data), /second-private-input|private-native-input/);
  } finally {
    await f.cleanup();
  }
});
