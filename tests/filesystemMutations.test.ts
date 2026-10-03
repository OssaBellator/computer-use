import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FilesystemAdapterError,
  FilesystemComputerEnvironmentAdapter,
  HostFilesystemMutationDispatcher,
  type FilesystemApprovalVerifier,
  type FilesystemMutationDispatch,
  type FilesystemMutationDispatcher,
  type FilesystemPreparedMutation,
} from '../src/computer/filesystemAdapter.js';

const approving: FilesystemApprovalVerifier = { verify: async () => true };

async function fixture(dispatcher?: FilesystemMutationDispatcher) {
  const root = await mkdtemp(join(tmpdir(), 'computer-fs-mutation-'));
  return {
    root,
    adapter: new FilesystemComputerEnvironmentAdapter({
      adapterId: 'filesystem-mutation-test', rootPath: root, approvalVerifier: approving,
      ...(dispatcher ? { mutationDispatcher: dispatcher } : {}),
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function request(prepared: FilesystemPreparedMutation, actionId: string, approve = false) {
  return {
    adapterId: 'filesystem-mutation-test', actionId,
    capability: prepared.capability, effect: prepared.effect, idempotency: prepared.idempotency,
    ...(prepared.target ? { target: prepared.target } : {}),
    payload: {
      ...prepared.payload,
      ...(approve ? { approval: { approved: true as const, approvalId: `${actionId}-approval`, effect: 'local-destructive' as const, planId: prepared.payload.planId } } : {}),
    },
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof FilesystemAdapterError && error.code === code);
}

test('stale copy source fails closed before dispatch', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'source.bin'), Buffer.from([1, 2, 3]));
    const source = await f.adapter.resolvePath('source.bin');
    const prepared = await f.adapter.prepareMutation({ operation: 'copy', sourcePath: 'source.bin', expectedSource: source, destinationPath: 'copy.bin', maxBytes: 8 });
    await writeFile(join(f.root, 'source.bin'), Buffer.from([9, 9, 9]));
    const result = await f.adapter.act(request(prepared, 'stale-source'));
    assert.equal(result.dispatch, 'not-dispatched');
    assert.equal(result.status, 'rejected');
    await assert.rejects(readFile(join(f.root, 'copy.bin')));
  } finally { await f.cleanup(); }
});

test('destination replacement race is rejected by last-moment dispatcher identity check', async () => {
  const host = new HostFilesystemMutationDispatcher();
  let root = '';
  const racing: FilesystemMutationDispatcher = {
    async dispatch(mutation, device) {
      if (mutation.operation === 'write-file') {
        await rename(join(root, 'target.txt'), join(root, 'old.txt'));
        await writeFile(join(root, 'target.txt'), 'attacker');
      }
      await host.dispatch(mutation, device);
    },
  };
  const f = await fixture(racing); root = f.root;
  try {
    await writeFile(join(f.root, 'target.txt'), 'old');
    const ref = await f.adapter.resolvePath('target.txt');
    const prepared = await f.adapter.prepareMutation({ operation: 'write-file', path: 'target.txt', expectedTarget: ref, content: 'new', overwrite: true });
    const result = await f.adapter.act(request(prepared, 'destination-race', true));
    assert.equal(result.dispatch, 'not-dispatched');
    assert.equal(await readFile(join(f.root, 'target.txt'), 'utf8'), 'attacker');
  } finally { await f.cleanup(); }
});

test('symlink attack after preparation is rejected without following the link', async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'computer-fs-mutation-outside-'));
  try {
    const outsideFile = join(outside, 'outside.txt');
    await writeFile(outsideFile, 'outside');
    const prepared = await f.adapter.prepareMutation({ operation: 'create-file', path: 'new.txt', content: 'inside' });
    await symlink(outsideFile, join(f.root, 'new.txt'));
    const result = await f.adapter.act(request(prepared, 'symlink-race'));
    assert.equal(result.dispatch, 'not-dispatched');
    assert.equal(await readFile(outsideFile, 'utf8'), 'outside');
  } finally { await f.cleanup(); await rm(outside, { recursive: true, force: true }); }
});

test('mount/device crossing fails closed', async () => {
  const f = await fixture();
  try {
    await f.adapter.root();
    (f.adapter as unknown as { rootDevice: string }).rootDevice = 'forced-other-device';
    await expectCode(f.adapter.prepareMutation({ operation: 'create-file', path: 'x.txt', content: 'x' }), 'filesystem-mount-boundary');
  } finally { await f.cleanup(); }
});

test('overwrite requires approval and then verifies exact content', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'target.txt'), 'old');
    const ref = await f.adapter.resolvePath('target.txt');
    const prepared = await f.adapter.prepareMutation({ operation: 'write-file', path: 'target.txt', expectedTarget: ref, content: 'replacement', overwrite: true });
    const denied = await f.adapter.act(request(prepared, 'overwrite-denied'));
    assert.deepEqual(denied.evidence, ['filesystem-approval-required']);
    assert.equal(await readFile(join(f.root, 'target.txt'), 'utf8'), 'old');
    const done = await f.adapter.act(request(prepared, 'overwrite-approved', true));
    assert.equal(done.verification, 'verified');
    assert.equal(await readFile(join(f.root, 'target.txt'), 'utf8'), 'replacement');
  } finally { await f.cleanup(); }
});

test('delete requires explicit destructive semantics and approval', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'delete.txt'), 'delete-me');
    const ref = await f.adapter.resolvePath('delete.txt');
    const prepared = await f.adapter.prepareMutation({ operation: 'delete', path: 'delete.txt', expectedTarget: ref, destructive: true });
    assert.equal((await f.adapter.act(request(prepared, 'delete-denied'))).dispatch, 'not-dispatched');
    assert.equal(await readFile(join(f.root, 'delete.txt'), 'utf8'), 'delete-me');
    const done = await f.adapter.act(request(prepared, 'delete-approved', true));
    assert.equal(done.verification, 'verified');
    await assert.rejects(readFile(join(f.root, 'delete.txt')));
  } finally { await f.cleanup(); }
});

test('unknown possibly-dispatched mutation is never replayed', async () => {
  const host = new HostFilesystemMutationDispatcher();
  let calls = 0;
  const uncertain: FilesystemMutationDispatcher = {
    async dispatch(mutation: Readonly<FilesystemMutationDispatch>, device) {
      calls += 1;
      await host.dispatch(mutation, device);
      throw new Error('transport lost after dispatch');
    },
  };
  const f = await fixture(uncertain);
  try {
    const prepared = await f.adapter.prepareMutation({ operation: 'create-file', path: 'once.txt', content: 'once' });
    const first = await f.adapter.act(request(prepared, 'unknown-once'));
    assert.equal(first.status, 'unknown');
    assert.equal(first.dispatch, 'unknown');
    const second = await f.adapter.act(request(prepared, 'unknown-replay'));
    assert.equal(second.dispatch, 'not-dispatched');
    assert.deepEqual(second.evidence, ['filesystem-plan-consumed']);
    assert.equal(calls, 1);
    assert.equal(await readFile(join(f.root, 'once.txt'), 'utf8'), 'once');
  } finally { await f.cleanup(); }
});

test('successful create, copy and move are post-verified', async () => {
  const f = await fixture();
  try {
    const created = await f.adapter.prepareMutation({ operation: 'create-file', path: 'a.txt', content: 'verified' });
    assert.equal((await f.adapter.act(request(created, 'create'))).verification, 'verified');
    const a = await f.adapter.resolvePath('a.txt');
    const copied = await f.adapter.prepareMutation({ operation: 'copy', sourcePath: 'a.txt', expectedSource: a, destinationPath: 'b.txt' });
    assert.equal((await f.adapter.act(request(copied, 'copy'))).verification, 'verified');
    const b = await f.adapter.resolvePath('b.txt');
    const moved = await f.adapter.prepareMutation({ operation: 'move', sourcePath: 'b.txt', expectedSource: b, destinationPath: 'c.txt' });
    assert.equal((await f.adapter.act(request(moved, 'move'))).verification, 'verified');
    assert.equal(await readFile(join(f.root, 'c.txt'), 'utf8'), 'verified');
  } finally { await f.cleanup(); }
});

test('write and copy material acquisition are bounded', async () => {
  const f = await fixture();
  try {
    await expectCode(f.adapter.prepareMutation({ operation: 'create-file', path: 'too-big.txt', content: '12345', maxBytes: 4 }), 'filesystem-limit-invalid');
    await writeFile(join(f.root, 'source.bin'), Buffer.alloc(9));
    const ref = await f.adapter.resolvePath('source.bin');
    await expectCode(f.adapter.prepareMutation({ operation: 'copy', sourcePath: 'source.bin', expectedSource: ref, destinationPath: 'dest.bin', maxBytes: 8 }), 'filesystem-limit-invalid');
  } finally { await f.cleanup(); }
});

test('deleting one hardlink locator preserves generation-aware identity through the survivor', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'first.txt'), 'shared');
    await link(join(f.root, 'first.txt'), join(f.root, 'second.txt'));
    const first = await f.adapter.resolvePath('first.txt');
    const second = await f.adapter.resolvePath('second.txt');
    assert.equal(first.entityId, second.entityId);
    const prepared = await f.adapter.prepareMutation({ operation: 'delete', path: 'first.txt', expectedTarget: first, destructive: true });
    assert.equal((await f.adapter.act(request(prepared, 'delete-hardlink', true))).verification, 'verified');
    const read = await f.adapter.act({ adapterId: 'filesystem-mutation-test', actionId: 'read-survivor', capability: 'filesystem.read', effect: 'observe-only', idempotency: 'read-only', target: second, payload: { maxBytes: 16 } });
    assert.equal((read.details as { content: string }).content, 'shared');
  } finally { await f.cleanup(); }
});

test('pre-dispatch rejection has no rollback mutation and retry requires a fresh plan', async () => {
  const f = await fixture();
  try {
    const stalePlan = await f.adapter.prepareMutation({ operation: 'create-file', path: 'retry.txt', content: 'intended' });
    await writeFile(join(f.root, 'retry.txt'), 'racer');
    const rejected = await f.adapter.act(request(stalePlan, 'race-before-dispatch'));
    assert.equal(rejected.dispatch, 'not-dispatched');
    assert.equal(await readFile(join(f.root, 'retry.txt'), 'utf8'), 'racer');
    await unlink(join(f.root, 'retry.txt'));
    const freshPlan = await f.adapter.prepareMutation({ operation: 'create-file', path: 'retry.txt', content: 'intended' });
    const retried = await f.adapter.act(request(freshPlan, 'explicit-fresh-retry'));
    assert.equal(retried.verification, 'verified');
    assert.equal(await readFile(join(f.root, 'retry.txt'), 'utf8'), 'intended');
  } finally { await f.cleanup(); }
});
