import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FilesystemAdapterError } from '../src/computer/filesystemAdapter.js';
import {
  approvingFilesystemMutation,
  filesystemMutationFixture,
  mutationAction,
} from './helpers/filesystemMutationHarness.js';

async function expectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof FilesystemAdapterError && error.code === code,
  );
}

test('new-object mutations are classified local-reversible', async () => {
  const f = await filesystemMutationFixture();
  try {
    await writeFile(join(f.root, 'source.txt'), 'source');
    const source = await f.adapter.resolvePath('source.txt');

    const createFile = await f.adapter.prepareMutation({ operation: 'create-file', path: 'created.txt', content: 'created' });
    const createDirectory = await f.adapter.prepareMutation({ operation: 'create-directory', path: 'created-dir' });
    const copy = await f.adapter.prepareMutation({ operation: 'copy', sourcePath: 'source.txt', expectedSource: source, destinationPath: 'copy.txt' });
    const move = await f.adapter.prepareMutation({ operation: 'move', sourcePath: 'source.txt', expectedSource: source, destinationPath: 'moved.txt' });

    assert.equal(createFile.effect, 'local-reversible');
    assert.equal(createDirectory.effect, 'local-reversible');
    assert.equal(copy.effect, 'local-reversible');
    assert.equal(move.effect, 'local-reversible');
    assert.equal(createFile.idempotency, 'non-idempotent');
    assert.equal(copy.idempotency, 'non-idempotent');
  } finally {
    await f.cleanup();
  }
});

test('overwrite and removal mutations are classified local-destructive', async () => {
  const f = await filesystemMutationFixture({ approvalVerifier: approvingFilesystemMutation });
  try {
    await writeFile(join(f.root, 'source.txt'), 'source');
    await writeFile(join(f.root, 'destination.txt'), 'destination');
    await writeFile(join(f.root, 'delete.txt'), 'delete');
    await mkdir(join(f.root, 'empty'));

    const source = await f.adapter.resolvePath('source.txt');
    const destination = await f.adapter.resolvePath('destination.txt');
    const deleteTarget = await f.adapter.resolvePath('delete.txt');
    const empty = await f.adapter.resolvePath('empty');

    const write = await f.adapter.prepareMutation({ operation: 'write-file', path: 'destination.txt', expectedTarget: destination, content: 'new', overwrite: true });
    const copy = await f.adapter.prepareMutation({ operation: 'copy', sourcePath: 'source.txt', expectedSource: source, destinationPath: 'destination.txt', overwrite: true, expectedDestination: destination });
    const move = await f.adapter.prepareMutation({ operation: 'move', sourcePath: 'source.txt', expectedSource: source, destinationPath: 'destination.txt', overwrite: true, expectedDestination: destination });
    const removeFile = await f.adapter.prepareMutation({ operation: 'delete', path: 'delete.txt', expectedTarget: deleteTarget, destructive: true });
    const removeDirectory = await f.adapter.prepareMutation({ operation: 'remove-empty-directory', path: 'empty', expectedTarget: empty, destructive: true });

    for (const prepared of [write, copy, move, removeFile, removeDirectory]) {
      assert.equal(prepared.effect, 'local-destructive');
      assert.equal(prepared.idempotency, 'non-idempotent');
    }
  } finally {
    await f.cleanup();
  }
});

test('destructive operation is inert without approval and succeeds with approval', async () => {
  const f = await filesystemMutationFixture({ approvalVerifier: approvingFilesystemMutation });
  try {
    await writeFile(join(f.root, 'target.txt'), 'before');
    const target = await f.adapter.resolvePath('target.txt');
    const prepared = await f.adapter.prepareMutation({ operation: 'write-file', path: 'target.txt', expectedTarget: target, content: 'after', overwrite: true });

    const denied = await f.adapter.act(mutationAction(f.adapterId, prepared, 'write-denied', false));
    assert.equal(denied.status, 'rejected');
    assert.equal(denied.dispatch, 'not-dispatched');
    assert.equal(await readFile(join(f.root, 'target.txt'), 'utf8'), 'before');

    const approved = await f.adapter.act(mutationAction(f.adapterId, prepared, 'write-approved'));
    assert.equal(approved.status, 'completed');
    assert.equal(approved.verification, 'verified');
    assert.equal(await readFile(join(f.root, 'target.txt'), 'utf8'), 'after');
  } finally {
    await f.cleanup();
  }
});

test('existing destination requires explicit overwrite and expected identity', async () => {
  const f = await filesystemMutationFixture();
  try {
    await writeFile(join(f.root, 'source.txt'), 'source');
    await writeFile(join(f.root, 'destination.txt'), 'destination');
    const source = await f.adapter.resolvePath('source.txt');
    const destination = await f.adapter.resolvePath('destination.txt');

    await expectCode(
      f.adapter.prepareMutation({ operation: 'copy', sourcePath: 'source.txt', expectedSource: source, destinationPath: 'destination.txt' }),
      'filesystem-destination-exists',
    );

    await expectCode(
      f.adapter.prepareMutation({ operation: 'copy', sourcePath: 'source.txt', expectedSource: source, destinationPath: 'destination.txt', overwrite: true }),
      'filesystem-target-stale',
    );

    const wrongExpected = await f.adapter.resolvePath('source.txt');
    await expectCode(
      f.adapter.prepareMutation({ operation: 'copy', sourcePath: 'source.txt', expectedSource: source, destinationPath: 'destination.txt', overwrite: true, expectedDestination: wrongExpected }),
      'filesystem-target-stale',
    );

    const prepared = await f.adapter.prepareMutation({ operation: 'copy', sourcePath: 'source.txt', expectedSource: source, destinationPath: 'destination.txt', overwrite: true, expectedDestination: destination });
    assert.equal(prepared.effect, 'local-destructive');
  } finally {
    await f.cleanup();
  }
});

test('copy remains non-recursive and rejects directory sources', async () => {
  const f = await filesystemMutationFixture();
  try {
    await mkdir(join(f.root, 'source-dir'));
    await writeFile(join(f.root, 'source-dir', 'nested.txt'), 'nested');
    const sourceDirectory = await f.adapter.resolvePath('source-dir');

    await expectCode(
      f.adapter.prepareMutation({ operation: 'copy', sourcePath: 'source-dir', expectedSource: sourceDirectory, destinationPath: 'copy-dir' }),
      'filesystem-target-kind-mismatch',
    );
  } finally {
    await f.cleanup();
  }
});

test('directory move is limited to empty directories', async () => {
  const f = await filesystemMutationFixture();
  try {
    await mkdir(join(f.root, 'nonempty'));
    await writeFile(join(f.root, 'nonempty', 'child.txt'), 'child');
    const source = await f.adapter.resolvePath('nonempty');

    await expectCode(
      f.adapter.prepareMutation({ operation: 'move', sourcePath: 'nonempty', expectedSource: source, destinationPath: 'moved' }),
      'filesystem-target-kind-mismatch',
    );
  } finally {
    await f.cleanup();
  }
});

test('empty directory move stays bounded and post-verifies identity', async () => {
  const f = await filesystemMutationFixture();
  try {
    await mkdir(join(f.root, 'empty'));
    const source = await f.adapter.resolvePath('empty');
    const prepared = await f.adapter.prepareMutation({ operation: 'move', sourcePath: 'empty', expectedSource: source, destinationPath: 'moved-empty' });
    const result = await f.adapter.act(mutationAction(f.adapterId, prepared, 'move-empty'));

    assert.equal(result.status, 'completed');
    assert.equal(result.verification, 'verified');
    const moved = await f.adapter.resolvePath('moved-empty');
    assert.equal(moved.entityId, source.entityId);
    assert.equal(moved.generation, source.generation);
  } finally {
    await f.cleanup();
  }
});

test('remove-empty-directory rejects non-empty directories before approval', async () => {
  let approvals = 0;
  const f = await filesystemMutationFixture({
    approvalVerifier: {
      async verify() {
        approvals += 1;
        return true;
      },
    },
  });
  try {
    await mkdir(join(f.root, 'nonempty'));
    await writeFile(join(f.root, 'nonempty', 'child.txt'), 'child');
    const target = await f.adapter.resolvePath('nonempty');

    await expectCode(
      f.adapter.prepareMutation({ operation: 'remove-empty-directory', path: 'nonempty', expectedTarget: target, destructive: true }),
      'filesystem-target-kind-mismatch',
    );
    assert.equal(approvals, 0);
  } finally {
    await f.cleanup();
  }
});

test('prepared summaries commit exact material size and digest without exposing content', async () => {
  const f = await filesystemMutationFixture();
  try {
    const prepared = await f.adapter.prepareMutation({ operation: 'create-file', path: 'summary.txt', content: 'summary-material' });
    assert.equal(prepared.summary.operation, 'create-file');
    assert.equal(prepared.summary.destinationPath, 'summary.txt');
    assert.equal(prepared.summary.materialBytes, Buffer.byteLength('summary-material'));
    assert.match(prepared.summary.materialDigest ?? '', /^[a-f0-9]{64}$/);
    assert.equal('content' in prepared.summary, false);
    assert.deepEqual(Object.keys(prepared.payload), ['planId']);
  } finally {
    await f.cleanup();
  }
});

test('copy summaries commit source, destination, size and digest', async () => {
  const f = await filesystemMutationFixture();
  try {
    await writeFile(join(f.root, 'source.txt'), 'copy-material');
    const source = await f.adapter.resolvePath('source.txt');
    const prepared = await f.adapter.prepareMutation({ operation: 'copy', sourcePath: 'source.txt', expectedSource: source, destinationPath: 'destination.txt' });

    assert.deepEqual(
      {
        operation: prepared.summary.operation,
        sourcePath: prepared.summary.sourcePath,
        destinationPath: prepared.summary.destinationPath,
        materialBytes: prepared.summary.materialBytes,
      },
      {
        operation: 'copy',
        sourcePath: 'source.txt',
        destinationPath: 'destination.txt',
        materialBytes: Buffer.byteLength('copy-material'),
      },
    );
    assert.match(prepared.summary.materialDigest ?? '', /^[a-f0-9]{64}$/);
  } finally {
    await f.cleanup();
  }
});

test('mutation destinations cannot escape the configured root', async () => {
  const f = await filesystemMutationFixture();
  try {
    await writeFile(join(f.root, 'source.txt'), 'source');
    const source = await f.adapter.resolvePath('source.txt');

    await expectCode(f.adapter.prepareMutation({ operation: 'create-file', path: '../outside.txt', content: 'x' }), 'filesystem-path-traversal');
    await expectCode(f.adapter.prepareMutation({ operation: 'create-directory', path: '../outside-dir' }), 'filesystem-path-traversal');
    await expectCode(
      f.adapter.prepareMutation({ operation: 'copy', sourcePath: 'source.txt', expectedSource: source, destinationPath: '../outside-copy.txt' }),
      'filesystem-path-traversal',
    );
    await expectCode(
      f.adapter.prepareMutation({ operation: 'move', sourcePath: 'source.txt', expectedSource: source, destinationPath: '../outside-move.txt' }),
      'filesystem-path-traversal',
    );
  } finally {
    await f.cleanup();
  }
});

test('mutation source paths cannot escape the configured root', async () => {
  const f = await filesystemMutationFixture();
  try {
    await writeFile(join(f.root, 'inside.txt'), 'inside');
    const inside = await f.adapter.resolvePath('inside.txt');

    await expectCode(
      f.adapter.prepareMutation({ operation: 'copy', sourcePath: '../outside.txt', expectedSource: inside, destinationPath: 'copy.txt' }),
      'filesystem-path-traversal',
    );
    await expectCode(
      f.adapter.prepareMutation({ operation: 'move', sourcePath: '../outside.txt', expectedSource: inside, destinationPath: 'move.txt' }),
      'filesystem-path-traversal',
    );
  } finally {
    await f.cleanup();
  }
});
