import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostSystemDeviceBackend } from '../src/computer/hostSystemDeviceBackend.js';
import { TruthfulInventoryLinuxSystemDeviceBackend } from '../src/computer/truthfulInventoryLinuxSystemDeviceBackend.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'linux-volume-generation-'));
  const procRoot = join(root, 'proc');
  const sysClassRoot = join(root, 'class');
  const sysRoot = join(root, 'sys');
  await mkdir(join(procRoot, 'self'), { recursive: true });
  await mkdir(sysClassRoot, { recursive: true });
  await mkdir(sysRoot, { recursive: true });
  return {
    root, procRoot, sysClassRoot, sysRoot,
    backend() {
      return createHostSystemDeviceBackend({
        platformFamily: 'linux', linux: { procRoot, sysClassRoot, sysRoot },
      });
    },
    async mountInfo(value: string) {
      await writeFile(join(procRoot, 'self', 'mountinfo'), value);
    },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

const mountLine = (mountId: number, filesystem = 'ext4', source = '/dev/private-source') =>
  `${mountId} 31 8:1 / / rw,relatime - ${filesystem} ${source} rw\n`;

test('unchanged mounted volume preserves opaque identity and generation', async () => {
  const f = await fixture();
  try {
    await f.mountInfo(mountLine(42));
    const backend = f.backend();
    assert.ok(backend instanceof TruthfulInventoryLinuxSystemDeviceBackend);
    if (!(backend instanceof TruthfulInventoryLinuxSystemDeviceBackend)) return;

    const first = await backend.enumerateVolumes({ maxItems: 8, maxTextBytes: 4096 });
    const second = await backend.enumerateVolumes({ maxItems: 8, maxTextBytes: 4096 });
    assert.equal(first.state, 'ok');
    assert.equal(second.state, 'ok');
    if (first.state !== 'ok' || second.state !== 'ok') return;
    assert.equal(first.value.length, 1);
    assert.equal(second.value.length, 1);
    assert.deepEqual(second.value[0]?.identity, first.value[0]?.identity);
    assert.doesNotMatch(JSON.stringify(second.value), /private-source|\/dev\//i);
  } finally {
    await f.cleanup();
  }
});

test('replacement at the same mount point preserves opaque ID and advances generation', async () => {
  const f = await fixture();
  try {
    await f.mountInfo(mountLine(42, 'ext4', '/dev/private-old-source'));
    const backend = f.backend();
    assert.ok(backend instanceof TruthfulInventoryLinuxSystemDeviceBackend);
    if (!(backend instanceof TruthfulInventoryLinuxSystemDeviceBackend)) return;

    const first = await backend.enumerateVolumes({ maxItems: 8, maxTextBytes: 4096 });
    assert.equal(first.state, 'ok');
    if (first.state !== 'ok' || first.value.length !== 1) return;
    const before = first.value[0]!.identity;

    await f.mountInfo(mountLine(43, 'ext4', '/dev/private-new-source'));
    const second = await backend.enumerateVolumes({ maxItems: 8, maxTextBytes: 4096 });
    assert.equal(second.state, 'ok');
    if (second.state !== 'ok' || second.value.length !== 1) return;
    const after = second.value[0]!.identity;

    assert.equal(after.id, before.id);
    assert.ok(after.generation > before.generation);
    assert.doesNotMatch(after.id, /42|43|private|source|dev/i);
    assert.doesNotMatch(JSON.stringify(second.value), /private-new-source|\/dev\//i);
  } finally {
    await f.cleanup();
  }
});

test('filesystem replacement also advances volume generation without changing opaque ID', async () => {
  const f = await fixture();
  try {
    await f.mountInfo(mountLine(42, 'ext4'));
    const backend = f.backend();
    assert.ok(backend instanceof TruthfulInventoryLinuxSystemDeviceBackend);
    if (!(backend instanceof TruthfulInventoryLinuxSystemDeviceBackend)) return;

    const first = await backend.enumerateVolumes({ maxItems: 8, maxTextBytes: 4096 });
    assert.equal(first.state, 'ok');
    if (first.state !== 'ok' || first.value.length !== 1) return;
    const before = first.value[0]!.identity;

    await f.mountInfo(mountLine(42, 'xfs'));
    const second = await backend.enumerateVolumes({ maxItems: 8, maxTextBytes: 4096 });
    assert.equal(second.state, 'ok');
    if (second.state !== 'ok' || second.value.length !== 1) return;
    const after = second.value[0]!.identity;

    assert.equal(after.id, before.id);
    assert.ok(after.generation > before.generation);
  } finally {
    await f.cleanup();
  }
});
