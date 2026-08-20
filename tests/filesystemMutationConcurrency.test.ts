import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HostFilesystemMutationDispatcher,
  type FilesystemApprovalVerifier,
  type FilesystemMutationDispatcher,
} from '../src/computer/filesystemAdapter.js';
import {
  filesystemMutationFixture,
  mutationAction,
} from './helpers/filesystemMutationHarness.js';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test('concurrent reversible actions can claim a prepared plan only once', async () => {
  const host = new HostFilesystemMutationDispatcher();
  const entered = deferred();
  const continueDispatch = deferred();
  let dispatches = 0;
  const dispatcher: FilesystemMutationDispatcher = {
    async dispatch(mutation, rootDevice) {
      dispatches += 1;
      entered.release();
      await continueDispatch.promise;
      await host.dispatch(mutation, rootDevice);
    },
  };
  const f = await filesystemMutationFixture({ dispatcher });
  try {
    const prepared = await f.adapter.prepareMutation({ operation: 'create-file', path: 'once.txt', content: 'once' });
    const first = f.adapter.act(mutationAction(f.adapterId, prepared, 'concurrent-create-first'));
    await entered.promise;

    const second = await f.adapter.act(mutationAction(f.adapterId, prepared, 'concurrent-create-second'));
    assert.equal(second.status, 'rejected');
    assert.equal(second.dispatch, 'not-dispatched');
    assert.deepEqual(second.evidence, ['filesystem-plan-consumed']);

    continueDispatch.release();
    const completed = await first;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.verification, 'verified');
    assert.equal(dispatches, 1);
    assert.equal(await readFile(join(f.root, 'once.txt'), 'utf8'), 'once');
  } finally {
    continueDispatch.release();
    await f.cleanup();
  }
});

test('destructive plans are claimed before awaiting approval verification', async () => {
  const approvalEntered = deferred();
  const continueApproval = deferred();
  let approvals = 0;
  let dispatches = 0;
  const approvalVerifier: FilesystemApprovalVerifier = {
    async verify() {
      approvals += 1;
      approvalEntered.release();
      await continueApproval.promise;
      return true;
    },
  };
  const host = new HostFilesystemMutationDispatcher();
  const dispatcher: FilesystemMutationDispatcher = {
    async dispatch(mutation, rootDevice) {
      dispatches += 1;
      await host.dispatch(mutation, rootDevice);
    },
  };
  const f = await filesystemMutationFixture({ dispatcher, approvalVerifier });
  try {
    await writeFile(join(f.root, 'target.txt'), 'before');
    const target = await f.adapter.resolvePath('target.txt');
    const prepared = await f.adapter.prepareMutation({ operation: 'write-file', path: 'target.txt', expectedTarget: target, content: 'after', overwrite: true });

    const first = f.adapter.act(mutationAction(f.adapterId, prepared, 'concurrent-write-first'));
    await approvalEntered.promise;
    const second = await f.adapter.act(mutationAction(f.adapterId, prepared, 'concurrent-write-second'));

    assert.equal(second.status, 'rejected');
    assert.equal(second.dispatch, 'not-dispatched');
    assert.deepEqual(second.evidence, ['filesystem-plan-consumed']);
    assert.equal(approvals, 1);
    assert.equal(dispatches, 0);

    continueApproval.release();
    const completed = await first;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.verification, 'verified');
    assert.equal(approvals, 1);
    assert.equal(dispatches, 1);
    assert.equal(await readFile(join(f.root, 'target.txt'), 'utf8'), 'after');
  } finally {
    continueApproval.release();
    await f.cleanup();
  }
});

test('denied approval releases the pre-dispatch claim for an explicit later retry', async () => {
  let approve = false;
  let verifierCalls = 0;
  const f = await filesystemMutationFixture({
    approvalVerifier: {
      async verify() {
        verifierCalls += 1;
        return approve;
      },
    },
  });
  try {
    await writeFile(join(f.root, 'target.txt'), 'before');
    const target = await f.adapter.resolvePath('target.txt');
    const prepared = await f.adapter.prepareMutation({ operation: 'write-file', path: 'target.txt', expectedTarget: target, content: 'after', overwrite: true });

    const denied = await f.adapter.act(mutationAction(f.adapterId, prepared, 'approval-denied'));
    assert.equal(denied.status, 'rejected');
    assert.equal(denied.dispatch, 'not-dispatched');
    assert.equal(await readFile(join(f.root, 'target.txt'), 'utf8'), 'before');

    approve = true;
    const retried = await f.adapter.act(mutationAction(f.adapterId, prepared, 'approval-retry'));
    assert.equal(retried.status, 'completed');
    assert.equal(retried.verification, 'verified');
    assert.equal(verifierCalls, 2);
    assert.equal(await readFile(join(f.root, 'target.txt'), 'utf8'), 'after');
  } finally { await f.cleanup(); }
});

test('malformed approval does not strand the plan in an in-progress state', async () => {
  const f = await filesystemMutationFixture({ approvalVerifier: { verify: async () => true } });
  try {
    await writeFile(join(f.root, 'target.txt'), 'before');
    const target = await f.adapter.resolvePath('target.txt');
    const prepared = await f.adapter.prepareMutation({ operation: 'write-file', path: 'target.txt', expectedTarget: target, content: 'after', overwrite: true });
    const valid = mutationAction(f.adapterId, prepared, 'valid-after-malformed');
    const malformed = {
      ...valid,
      actionId: 'malformed-first',
      payload: {
        ...prepared.payload,
        approval: {
          approved: true as const,
          approvalId: '',
          effect: 'local-destructive' as const,
          planId: prepared.payload.planId,
        },
      },
    };

    const rejected = await f.adapter.act(malformed);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.dispatch, 'not-dispatched');

    const completed = await f.adapter.act(valid);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.verification, 'verified');
  } finally { await f.cleanup(); }
});
