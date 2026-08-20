import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
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

async function fixture(options: {
  dispatcher?: FilesystemMutationDispatcher;
  approvalVerifier?: FilesystemApprovalVerifier;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'computer-fs-adversarial-'));
  return {
    root,
    adapter: new FilesystemComputerEnvironmentAdapter({
      adapterId: 'filesystem-adversarial-test',
      rootPath: root,
      ...(options.dispatcher ? { mutationDispatcher: options.dispatcher } : {}),
      ...(options.approvalVerifier ? { approvalVerifier: options.approvalVerifier } : {}),
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function action(prepared: FilesystemPreparedMutation, actionId: string, approvalPlanId = prepared.payload.planId) {
  return {
    adapterId: 'filesystem-adversarial-test',
    actionId,
    capability: prepared.capability,
    effect: prepared.effect,
    idempotency: prepared.idempotency,
    ...(prepared.target ? { target: prepared.target } : {}),
    payload: {
      ...prepared.payload,
      ...(prepared.effect === 'local-destructive'
        ? {
            approval: {
              approved: true as const,
              approvalId: `${actionId}-approval`,
              effect: 'local-destructive' as const,
              planId: approvalPlanId,
            },
          }
        : {}),
    },
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof FilesystemAdapterError && error.code === code,
  );
}

test('approval await cannot hide a source replacement before destructive copy dispatch', async () => {
  let root = '';
  let dispatches = 0;
  const dispatcher: FilesystemMutationDispatcher = {
    async dispatch() {
      dispatches += 1;
    },
  };
  const approvalVerifier: FilesystemApprovalVerifier = {
    async verify() {
      await rename(join(root, 'source.txt'), join(root, 'source-old.txt'));
      await writeFile(join(root, 'source.txt'), 'replacement-source');
      return true;
    },
  };
  const f = await fixture({ dispatcher, approvalVerifier });
  root = f.root;
  try {
    await writeFile(join(root, 'source.txt'), 'approved-source');
    await writeFile(join(root, 'destination.txt'), 'old-destination');
    const source = await f.adapter.resolvePath('source.txt');
    const destination = await f.adapter.resolvePath('destination.txt');
    const prepared = await f.adapter.prepareMutation({
      operation: 'copy',
      sourcePath: 'source.txt',
      expectedSource: source,
      destinationPath: 'destination.txt',
      overwrite: true,
      expectedDestination: destination,
    });

    const result = await f.adapter.act(action(prepared, 'approval-source-race'));
    assert.equal(result.status, 'rejected');
    assert.equal(result.dispatch, 'not-dispatched');
    assert.equal(dispatches, 0);
    assert.equal(await readFile(join(root, 'destination.txt'), 'utf8'), 'old-destination');
  } finally {
    await f.cleanup();
  }
});

test('approval await cannot hide a destination replacement before overwrite dispatch', async () => {
  let root = '';
  let dispatches = 0;
  const dispatcher: FilesystemMutationDispatcher = {
    async dispatch() {
      dispatches += 1;
    },
  };
  const approvalVerifier: FilesystemApprovalVerifier = {
    async verify() {
      await rename(join(root, 'destination.txt'), join(root, 'destination-old.txt'));
      await writeFile(join(root, 'destination.txt'), 'attacker-destination');
      return true;
    },
  };
  const f = await fixture({ dispatcher, approvalVerifier });
  root = f.root;
  try {
    await writeFile(join(root, 'destination.txt'), 'old-destination');
    const destination = await f.adapter.resolvePath('destination.txt');
    const prepared = await f.adapter.prepareMutation({
      operation: 'write-file',
      path: 'destination.txt',
      expectedTarget: destination,
      content: 'approved-content',
      overwrite: true,
    });

    const result = await f.adapter.act(action(prepared, 'approval-destination-race'));
    assert.equal(result.status, 'rejected');
    assert.equal(result.dispatch, 'not-dispatched');
    assert.equal(dispatches, 0);
    assert.equal(await readFile(join(root, 'destination.txt'), 'utf8'), 'attacker-destination');
  } finally {
    await f.cleanup();
  }
});

test('overwrite copy retains source identity through the final host-dispatch boundary', async () => {
  const host = new HostFilesystemMutationDispatcher();
  let root = '';
  const racing: FilesystemMutationDispatcher = {
    async dispatch(mutation, rootDevice) {
      if (mutation.operation === 'copy') {
        await rename(join(root, 'source.txt'), join(root, 'source-old.txt'));
        await writeFile(join(root, 'source.txt'), 'raced-source');
      }
      await host.dispatch(mutation, rootDevice);
    },
  };
  const approvalVerifier: FilesystemApprovalVerifier = { verify: async () => true };
  const f = await fixture({ dispatcher: racing, approvalVerifier });
  root = f.root;
  try {
    await writeFile(join(root, 'source.txt'), 'snapshotted-source');
    await writeFile(join(root, 'destination.txt'), 'old-destination');
    const source = await f.adapter.resolvePath('source.txt');
    const destination = await f.adapter.resolvePath('destination.txt');
    const prepared = await f.adapter.prepareMutation({
      operation: 'copy',
      sourcePath: 'source.txt',
      expectedSource: source,
      destinationPath: 'destination.txt',
      overwrite: true,
      expectedDestination: destination,
    });

    const result = await f.adapter.act(action(prepared, 'copy-final-source-race'));
    assert.equal(result.status, 'rejected');
    assert.equal(result.dispatch, 'not-dispatched');
    assert.equal(await readFile(join(root, 'destination.txt'), 'utf8'), 'old-destination');
  } finally {
    await f.cleanup();
  }
});

test('post-dispatch destination corruption is reported as dispatched-once verification mismatch', async () => {
  const host = new HostFilesystemMutationDispatcher();
  let root = '';
  let calls = 0;
  const corrupting: FilesystemMutationDispatcher = {
    async dispatch(mutation, rootDevice) {
      calls += 1;
      await host.dispatch(mutation, rootDevice);
      if (mutation.operation === 'create-file') {
        await writeFile(join(root, 'created.txt'), 'corrupted-after-dispatch');
      }
    },
  };
  const f = await fixture({ dispatcher: corrupting });
  root = f.root;
  try {
    const prepared = await f.adapter.prepareMutation({
      operation: 'create-file',
      path: 'created.txt',
      content: 'intended',
    });

    const result = await f.adapter.act(action(prepared, 'post-dispatch-corruption'));
    assert.equal(result.status, 'unknown');
    assert.equal(result.dispatch, 'dispatched-once');
    assert.equal(result.verification, 'mismatch');
    assert.equal(calls, 1);

    const replay = await f.adapter.act(action(prepared, 'post-dispatch-corruption-replay'));
    assert.equal(replay.dispatch, 'not-dispatched');
    assert.deepEqual(replay.evidence, ['filesystem-plan-consumed']);
  } finally {
    await f.cleanup();
  }
});

test('destructive approval is bound to the prepared plan id', async () => {
  let verifierCalls = 0;
  const approvalVerifier: FilesystemApprovalVerifier = {
    async verify() {
      verifierCalls += 1;
      return true;
    },
  };
  const f = await fixture({ approvalVerifier });
  try {
    await writeFile(join(f.root, 'first.txt'), 'first');
    await writeFile(join(f.root, 'second.txt'), 'second');
    const first = await f.adapter.resolvePath('first.txt');
    const second = await f.adapter.resolvePath('second.txt');
    const firstPlan = await f.adapter.prepareMutation({ operation: 'delete', path: 'first.txt', expectedTarget: first, destructive: true });
    const secondPlan = await f.adapter.prepareMutation({ operation: 'delete', path: 'second.txt', expectedTarget: second, destructive: true });

    const confused = await f.adapter.act(action(secondPlan, 'cross-plan-approval', firstPlan.payload.planId));
    assert.equal(confused.status, 'rejected');
    assert.equal(confused.dispatch, 'not-dispatched');
    assert.deepEqual(confused.evidence, ['filesystem-approval-required']);
    assert.equal(verifierCalls, 0);
    assert.equal(await readFile(join(f.root, 'second.txt'), 'utf8'), 'second');
  } finally {
    await f.cleanup();
  }
});

test('hardlinked overwrite targets are rejected before approval or dispatch', async () => {
  const f = await fixture({ approvalVerifier: { verify: async () => true } });
  try {
    await writeFile(join(f.root, 'shared.txt'), 'shared');
    await link(join(f.root, 'shared.txt'), join(f.root, 'alias.txt'));
    const shared = await f.adapter.resolvePath('shared.txt');

    await expectCode(
      f.adapter.prepareMutation({
        operation: 'write-file',
        path: 'shared.txt',
        expectedTarget: shared,
        content: 'replacement',
        overwrite: true,
      }),
      'filesystem-hardlink-overwrite-rejected',
    );

    await writeFile(join(f.root, 'source.txt'), 'source');
    const source = await f.adapter.resolvePath('source.txt');
    await expectCode(
      f.adapter.prepareMutation({
        operation: 'copy',
        sourcePath: 'source.txt',
        expectedSource: source,
        destinationPath: 'shared.txt',
        overwrite: true,
        expectedDestination: shared,
      }),
      'filesystem-hardlink-overwrite-rejected',
    );

    assert.equal(await readFile(join(f.root, 'shared.txt'), 'utf8'), 'shared');
    assert.equal(await readFile(join(f.root, 'alias.txt'), 'utf8'), 'shared');
  } finally {
    await f.cleanup();
  }
});

test('a proven pre-dispatch rejection may retry the same immutable plan after state is restored', async () => {
  const f = await fixture();
  try {
    const prepared = await f.adapter.prepareMutation({ operation: 'create-file', path: 'new.txt', content: 'intended' });
    await writeFile(join(f.root, 'new.txt'), 'racer');

    const rejected = await f.adapter.act(action(prepared, 'stale-create-first-attempt'));
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.dispatch, 'not-dispatched');
    assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'racer');

    await unlink(join(f.root, 'new.txt'));
    const retried = await f.adapter.act(action(prepared, 'stale-create-restored-retry'));
    assert.equal(retried.status, 'completed');
    assert.equal(retried.dispatch, 'dispatched-once');
    assert.equal(retried.verification, 'verified');
    assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'intended');

    const afterSuccess = await f.adapter.act(action(prepared, 'stale-create-after-success'));
    assert.equal(afterSuccess.dispatch, 'not-dispatched');
    assert.deepEqual(afterSuccess.evidence, ['filesystem-plan-consumed']);
  } finally {
    await f.cleanup();
  }
});
