import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HostFilesystemMutationDispatcher,
  type FilesystemMutationDispatcher,
} from '../src/computer/filesystemAdapter.js';
import {
  approvingFilesystemMutation,
  filesystemMutationFixture,
  mutationAction,
} from './helpers/filesystemMutationHarness.js';

function assertMismatch(result: Awaited<ReturnType<ReturnType<typeof filesystemMutationFixture>['adapter']['act']>>) {
  assert.equal(result.status, 'unknown');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(result.verification, 'mismatch');
}

test('create-file syscall success is insufficient when destination content changes before verification', async () => {
  const host = new HostFilesystemMutationDispatcher();
  let root = '';
  const dispatcher: FilesystemMutationDispatcher = {
    async dispatch(mutation, rootDevice) {
      await host.dispatch(mutation, rootDevice);
      if (mutation.operation === 'create-file') await writeFile(join(root, 'created.txt'), 'corrupted');
    },
  };
  const f = await filesystemMutationFixture({ dispatcher });
  root = f.root;
  try {
    const prepared = await f.adapter.prepareMutation({ operation: 'create-file', path: 'created.txt', content: 'intended' });
    assertMismatch(await f.adapter.act(mutationAction(f.adapterId, prepared, 'verify-create-file')));
    assert.equal(await readFile(join(root, 'created.txt'), 'utf8'), 'corrupted');
  } finally { await f.cleanup(); }
});

test('write-file syscall success is insufficient when overwrite material changes before verification', async () => {
  const host = new HostFilesystemMutationDispatcher();
  let root = '';
  const dispatcher: FilesystemMutationDispatcher = {
    async dispatch(mutation, rootDevice) {
      await host.dispatch(mutation, rootDevice);
      if (mutation.operation === 'write-file') await writeFile(join(root, 'target.txt'), 'corrupted');
    },
  };
  const f = await filesystemMutationFixture({ dispatcher, approvalVerifier: approvingFilesystemMutation });
  root = f.root;
  try {
    await writeFile(join(root, 'target.txt'), 'before');
    const target = await f.adapter.resolvePath('target.txt');
    const prepared = await f.adapter.prepareMutation({ operation: 'write-file', path: 'target.txt', expectedTarget: target, content: 'intended', overwrite: true });
    assertMismatch(await f.adapter.act(mutationAction(f.adapterId, prepared, 'verify-write-file')));
  } finally { await f.cleanup(); }
});

test('copy syscall success is insufficient when copied bytes change before verification', async () => {
  const host = new HostFilesystemMutationDispatcher();
  let root = '';
  const dispatcher: FilesystemMutationDispatcher = {
    async dispatch(mutation, rootDevice) {
      await host.dispatch(mutation, rootDevice);
      if (mutation.operation === 'copy') await writeFile(join(root, 'destination.txt'), 'corrupted');
    },
  };
  const f = await filesystemMutationFixture({ dispatcher });
  root = f.root;
  try {
    await writeFile(join(root, 'source.txt'), 'source-material');
    const source = await f.adapter.resolvePath('source.txt');
    const prepared = await f.adapter.prepareMutation({ operation: 'copy', sourcePath: 'source.txt', expectedSource: source, destinationPath: 'destination.txt' });
    assertMismatch(await f.adapter.act(mutationAction(f.adapterId, prepared, 'verify-copy')));
  } finally { await f.cleanup(); }
});

test('create-directory verifies directory kind rather than trusting mkdir success', async () => {
  const host = new HostFilesystemMutationDispatcher();
  let root = '';
  const dispatcher: FilesystemMutationDispatcher = {
    async dispatch(mutation, rootDevice) {
      await host.dispatch(mutation, rootDevice);
      if (mutation.operation === 'create-directory') {
        await rmdir(join(root, 'created-dir'));
        await writeFile(join(root, 'created-dir'), 'replacement-file');
      }
    },
  };
  const f = await filesystemMutationFixture({ dispatcher });
  root = f.root;
  try {
    const prepared = await f.adapter.prepareMutation({ operation: 'create-directory', path: 'created-dir' });
    assertMismatch(await f.adapter.act(mutationAction(f.adapterId, prepared, 'verify-create-directory')));
  } finally { await f.cleanup(); }
});

test('move verifies the same generation-aware source object arrived at destination', async () => {
  const host = new HostFilesystemMutationDispatcher();
  let root = '';
  const dispatcher: FilesystemMutationDispatcher = {
    async dispatch(mutation, rootDevice) {
      await host.dispatch(mutation, rootDevice);
      if (mutation.operation === 'move') {
        await rename(join(root, 'destination.txt'), join(root, 'moved-away.txt'));
        await writeFile(join(root, 'destination.txt'), 'replacement-object');
      }
    },
  };
  const f = await filesystemMutationFixture({ dispatcher });
  root = f.root;
  try {
    await writeFile(join(root, 'source.txt'), 'source');
    const source = await f.adapter.resolvePath('source.txt');
    const prepared = await f.adapter.prepareMutation({ operation: 'move', sourcePath: 'source.txt', expectedSource: source, destinationPath: 'destination.txt' });
    assertMismatch(await f.adapter.act(mutationAction(f.adapterId, prepared, 'verify-move')));
  } finally { await f.cleanup(); }
});

test('delete verifies the intended locator remains absent after unlink', async () => {
  const host = new HostFilesystemMutationDispatcher();
  let root = '';
  const dispatcher: FilesystemMutationDispatcher = {
    async dispatch(mutation, rootDevice) {
      await host.dispatch(mutation, rootDevice);
      if (mutation.operation === 'delete') await writeFile(join(root, 'delete.txt'), 'recreated');
    },
  };
  const f = await filesystemMutationFixture({ dispatcher, approvalVerifier: approvingFilesystemMutation });
  root = f.root;
  try {
    await writeFile(join(root, 'delete.txt'), 'original');
    const target = await f.adapter.resolvePath('delete.txt');
    const prepared = await f.adapter.prepareMutation({ operation: 'delete', path: 'delete.txt', expectedTarget: target, destructive: true });
    assertMismatch(await f.adapter.act(mutationAction(f.adapterId, prepared, 'verify-delete')));
    assert.equal(await readFile(join(root, 'delete.txt'), 'utf8'), 'recreated');
  } finally { await f.cleanup(); }
});

test('remove-empty-directory verifies the locator remains absent after rmdir', async () => {
  const host = new HostFilesystemMutationDispatcher();
  let root = '';
  const dispatcher: FilesystemMutationDispatcher = {
    async dispatch(mutation, rootDevice) {
      await host.dispatch(mutation, rootDevice);
      if (mutation.operation === 'remove-empty-directory') await mkdir(join(root, 'empty'));
    },
  };
  const f = await filesystemMutationFixture({ dispatcher, approvalVerifier: approvingFilesystemMutation });
  root = f.root;
  try {
    await mkdir(join(root, 'empty'));
    const target = await f.adapter.resolvePath('empty');
    const prepared = await f.adapter.prepareMutation({ operation: 'remove-empty-directory', path: 'empty', expectedTarget: target, destructive: true });
    assertMismatch(await f.adapter.act(mutationAction(f.adapterId, prepared, 'verify-remove-directory')));
  } finally { await f.cleanup(); }
});

test('verification mismatch consumes the plan and never dispatches it twice', async () => {
  const host = new HostFilesystemMutationDispatcher();
  let root = '';
  let dispatches = 0;
  const dispatcher: FilesystemMutationDispatcher = {
    async dispatch(mutation, rootDevice) {
      dispatches += 1;
      await host.dispatch(mutation, rootDevice);
      if (mutation.operation === 'create-file') await writeFile(join(root, 'once.txt'), 'corrupted');
    },
  };
  const f = await filesystemMutationFixture({ dispatcher });
  root = f.root;
  try {
    const prepared = await f.adapter.prepareMutation({ operation: 'create-file', path: 'once.txt', content: 'intended' });
    assertMismatch(await f.adapter.act(mutationAction(f.adapterId, prepared, 'verify-once-first')));
    const replay = await f.adapter.act(mutationAction(f.adapterId, prepared, 'verify-once-replay'));
    assert.equal(replay.status, 'rejected');
    assert.equal(replay.dispatch, 'not-dispatched');
    assert.deepEqual(replay.evidence, ['filesystem-plan-consumed']);
    assert.equal(dispatches, 1);
  } finally { await f.cleanup(); }
});
