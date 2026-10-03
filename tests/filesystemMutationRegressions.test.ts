import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FilesystemAdapterError,
  FilesystemComputerEnvironmentAdapter,
  HostFilesystemMutationDispatcher,
  type FilesystemApprovalVerifier,
  type FilesystemMutationDispatcher,
  type FilesystemPreparedMutation,
} from '../src/computer/filesystemAdapter.js';

const approving: FilesystemApprovalVerifier = { verify: async () => true };

async function fixture(dispatcher?: FilesystemMutationDispatcher) {
  const root = await mkdtemp(join(tmpdir(), 'computer-fs-mutation-regression-'));
  return {
    root,
    adapter: new FilesystemComputerEnvironmentAdapter({
      adapterId: 'filesystem-mutation-regression',
      rootPath: root,
      approvalVerifier: approving,
      ...(dispatcher ? { mutationDispatcher: dispatcher } : {}),
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function request(prepared: FilesystemPreparedMutation, actionId: string, approve = false) {
  return {
    adapterId: 'filesystem-mutation-regression',
    actionId,
    capability: prepared.capability,
    effect: prepared.effect,
    idempotency: prepared.idempotency,
    ...(prepared.target ? { target: prepared.target } : {}),
    payload: {
      ...prepared.payload,
      ...(approve ? {
        approval: {
          approved: true as const,
          approvalId: `${actionId}-approval`,
          effect: 'local-destructive' as const,
          planId: prepared.payload.planId,
        },
      } : {}),
    },
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof FilesystemAdapterError && error.code === code,
  );
}

test('move verification accepts rename ctime change while proving the same object moved', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'source.txt'), 'move-me');
    const source = await f.adapter.resolvePath('source.txt');
    const prepared = await f.adapter.prepareMutation({
      operation: 'move',
      sourcePath: 'source.txt',
      expectedSource: source,
      destinationPath: 'moved.txt',
    });

    const result = await f.adapter.act(request(prepared, 'move-ctime'));

    assert.equal(result.status, 'completed');
    assert.equal(result.dispatch, 'dispatched-once');
    assert.equal(result.verification, 'verified');
    assert.equal(await readFile(join(f.root, 'moved.txt'), 'utf8'), 'move-me');
    await assert.rejects(readFile(join(f.root, 'source.txt')));
  } finally {
    await f.cleanup();
  }
});

test('overwrite copy revalidates source inside the single mutation dispatch', async () => {
  const host = new HostFilesystemMutationDispatcher();
  let root = '';
  let dispatches = 0;
  const racing: FilesystemMutationDispatcher = {
    async dispatch(mutation, device) {
      dispatches += 1;
      assert.equal(mutation.operation, 'copy');
      await writeFile(join(root, 'source.txt'), 'raced-source');
      await host.dispatch(mutation, device);
    },
  };
  const f = await fixture(racing);
  root = f.root;
  try {
    await writeFile(join(f.root, 'source.txt'), 'prepared-source');
    await writeFile(join(f.root, 'destination.txt'), 'keep-destination');
    const source = await f.adapter.resolvePath('source.txt');
    const destination = await f.adapter.resolvePath('destination.txt');
    const prepared = await f.adapter.prepareMutation({
      operation: 'copy',
      sourcePath: 'source.txt',
      expectedSource: source,
      destinationPath: 'destination.txt',
      overwrite: true,
      expectedDestination: destination,
      maxBytes: 64,
    });

    const result = await f.adapter.act(request(prepared, 'copy-source-race', true));

    assert.equal(result.status, 'rejected');
    assert.equal(result.dispatch, 'not-dispatched');
    assert.equal(result.verification, 'rejected');
    assert.deepEqual(result.evidence, ['filesystem-race-detected']);
    assert.equal(dispatches, 1);
    assert.equal(await readFile(join(f.root, 'destination.txt'), 'utf8'), 'keep-destination');
  } finally {
    await f.cleanup();
  }
});

test('in-place write rejects a hardlinked destination instead of mutating aliases', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'first.txt'), 'shared');
    await link(join(f.root, 'first.txt'), join(f.root, 'second.txt'));
    const first = await f.adapter.resolvePath('first.txt');

    await expectCode(
      f.adapter.prepareMutation({
        operation: 'write-file',
        path: 'first.txt',
        expectedTarget: first,
        content: 'replacement',
        overwrite: true,
      }),
      'filesystem-hardlink-overwrite-rejected',
    );

    assert.equal(await readFile(join(f.root, 'first.txt'), 'utf8'), 'shared');
    assert.equal(await readFile(join(f.root, 'second.txt'), 'utf8'), 'shared');
  } finally {
    await f.cleanup();
  }
});

test('copy overwrite rejects a hardlinked destination instead of mutating aliases', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'source.txt'), 'source');
    await writeFile(join(f.root, 'first.txt'), 'shared');
    await link(join(f.root, 'first.txt'), join(f.root, 'second.txt'));
    const source = await f.adapter.resolvePath('source.txt');
    const first = await f.adapter.resolvePath('first.txt');

    await expectCode(
      f.adapter.prepareMutation({
        operation: 'copy',
        sourcePath: 'source.txt',
        expectedSource: source,
        destinationPath: 'first.txt',
        overwrite: true,
        expectedDestination: first,
        maxBytes: 64,
      }),
      'filesystem-hardlink-overwrite-rejected',
    );

    assert.equal(await readFile(join(f.root, 'first.txt'), 'utf8'), 'shared');
    assert.equal(await readFile(join(f.root, 'second.txt'), 'utf8'), 'shared');
  } finally {
    await f.cleanup();
  }
});
