import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComputerEntityRef } from '../src/computer/environmentAdapter.js';
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

test('create-file snapshots caller-owned path and content before its first await boundary', async () => {
  const f = await filesystemMutationFixture();
  try {
    const mutable = { operation: 'create-file' as const, path: 'captured.txt', content: 'captured-content' };
    const preparing = f.adapter.prepareMutation(mutable);
    mutable.path = 'mutated.txt';
    mutable.content = 'mutated-content';
    const prepared = await preparing;

    assert.equal(prepared.summary.destinationPath, 'captured.txt');
    const result = await f.adapter.act(mutationAction(f.adapterId, prepared, 'snapshot-create'));
    assert.equal(result.verification, 'verified');
    assert.equal(await readFile(join(f.root, 'captured.txt'), 'utf8'), 'captured-content');
    await assert.rejects(readFile(join(f.root, 'mutated.txt')));
  } finally {
    await f.cleanup();
  }
});

test('expected entity refs are cloned before asynchronous preparation work', async () => {
  const f = await filesystemMutationFixture({ approvalVerifier: approvingFilesystemMutation });
  try {
    await writeFile(join(f.root, 'target.txt'), 'before');
    const ref = await f.adapter.resolvePath('target.txt');
    const mutableRef = { ...ref } as ComputerEntityRef & { entityId: string; generation: number };
    const intent = {
      operation: 'write-file' as const,
      path: 'target.txt',
      expectedTarget: mutableRef,
      content: 'after',
      overwrite: true as const,
    };

    const preparing = f.adapter.prepareMutation(intent);
    mutableRef.entityId = 'mutated-entity-id';
    mutableRef.generation += 100;
    const prepared = await preparing;

    const result = await f.adapter.act(mutationAction(f.adapterId, prepared, 'snapshot-ref'));
    assert.equal(result.status, 'completed');
    assert.equal(result.verification, 'verified');
    assert.equal(await readFile(join(f.root, 'target.txt'), 'utf8'), 'after');
  } finally {
    await f.cleanup();
  }
});

test('mutation intents with accessor properties are rejected rather than evaluated', async () => {
  const f = await filesystemMutationFixture();
  try {
    let reads = 0;
    const malicious = Object.defineProperties({}, {
      operation: {
        enumerable: true,
        get() {
          reads += 1;
          return 'create-file';
        },
      },
      path: { enumerable: true, value: 'getter.txt' },
      content: { enumerable: true, value: 'getter-content' },
    });

    await expectCode(
      f.adapter.prepareMutation(malicious as never),
      'filesystem-invalid-request',
    );
    assert.equal(reads, 0);
  } finally {
    await f.cleanup();
  }
});

test('mutation intents with non-plain prototypes are rejected', async () => {
  const f = await filesystemMutationFixture();
  try {
    class IntentLike {
      operation = 'create-file' as const;
      path = 'class.txt';
      content = 'class-content';
    }

    await expectCode(
      f.adapter.prepareMutation(new IntentLike() as never),
      'filesystem-invalid-request',
    );
  } finally {
    await f.cleanup();
  }
});

test('prepared payload and approval summary are frozen snapshots', async () => {
  let sawFrozenSummary = false;
  const f = await filesystemMutationFixture({
    approvalVerifier: {
      async verify(_request, _approval, summary) {
        sawFrozenSummary = Object.isFrozen(summary);
        assert.equal(summary.operation, 'write-file');
        assert.equal(summary.destinationPath, 'target.txt');
        assert.equal(summary.materialBytes, Buffer.byteLength('replacement'));
        assert.match(summary.materialDigest ?? '', /^[a-f0-9]{64}$/);
        return true;
      },
    },
  });
  try {
    await writeFile(join(f.root, 'target.txt'), 'before');
    const target = await f.adapter.resolvePath('target.txt');
    const prepared = await f.adapter.prepareMutation({
      operation: 'write-file',
      path: 'target.txt',
      expectedTarget: target,
      content: 'replacement',
      overwrite: true,
    });

    assert.equal(Object.isFrozen(prepared), true);
    assert.equal(Object.isFrozen(prepared.payload), true);
    assert.equal(Object.isFrozen(prepared.summary), true);
    const result = await f.adapter.act(mutationAction(f.adapterId, prepared, 'frozen-summary'));
    assert.equal(result.verification, 'verified');
    assert.equal(sawFrozenSummary, true);
  } finally {
    await f.cleanup();
  }
});

test('approval with a getter is rejected before approval verifier invocation', async () => {
  let verifierCalls = 0;
  let getterReads = 0;
  const f = await filesystemMutationFixture({
    approvalVerifier: {
      async verify() {
        verifierCalls += 1;
        return true;
      },
    },
  });
  try {
    await writeFile(join(f.root, 'target.txt'), 'before');
    const target = await f.adapter.resolvePath('target.txt');
    const prepared = await f.adapter.prepareMutation({ operation: 'write-file', path: 'target.txt', expectedTarget: target, content: 'after', overwrite: true });
    const base = mutationAction(f.adapterId, prepared, 'approval-getter');
    const approval = Object.defineProperties({}, {
      approved: { enumerable: true, value: true },
      approvalId: {
        enumerable: true,
        get() {
          getterReads += 1;
          return 'approval-id';
        },
      },
      effect: { enumerable: true, value: 'local-destructive' },
      planId: { enumerable: true, value: prepared.payload.planId },
    });
    const action = { ...base, payload: { ...prepared.payload, approval } };

    const result = await f.adapter.act(action);
    assert.equal(result.status, 'rejected');
    assert.equal(result.dispatch, 'not-dispatched');
    assert.deepEqual(result.evidence, ['filesystem-approval-required']);
    assert.equal(getterReads, 0);
    assert.equal(verifierCalls, 0);
    assert.equal(await readFile(join(f.root, 'target.txt'), 'utf8'), 'before');
  } finally {
    await f.cleanup();
  }
});

test('approval identifiers are bounded and reject control characters', async () => {
  let verifierCalls = 0;
  const f = await filesystemMutationFixture({
    approvalVerifier: {
      async verify() {
        verifierCalls += 1;
        return true;
      },
    },
  });
  try {
    await writeFile(join(f.root, 'target.txt'), 'before');
    const target = await f.adapter.resolvePath('target.txt');
    const prepared = await f.adapter.prepareMutation({ operation: 'write-file', path: 'target.txt', expectedTarget: target, content: 'after', overwrite: true });

    for (const approvalId of ['', 'bad\nline', 'x'.repeat(193)]) {
      const base = mutationAction(f.adapterId, prepared, `approval-shape-${approvalId.length}`);
      const action = {
        ...base,
        payload: {
          ...prepared.payload,
          approval: {
            approved: true as const,
            approvalId,
            effect: 'local-destructive' as const,
            planId: prepared.payload.planId,
          },
        },
      };
      const result = await f.adapter.act(action);
      assert.equal(result.status, 'rejected');
      assert.equal(result.dispatch, 'not-dispatched');
      assert.deepEqual(result.evidence, ['filesystem-approval-required']);
    }
    assert.equal(verifierCalls, 0);
    assert.equal(await readFile(join(f.root, 'target.txt'), 'utf8'), 'before');
  } finally {
    await f.cleanup();
  }
});

test('request payload accessors are rejected without evaluating the accessor', async () => {
  const f = await filesystemMutationFixture();
  try {
    let reads = 0;
    const prepared = await f.adapter.prepareMutation({ operation: 'create-file', path: 'payload.txt', content: 'content' });
    const payload = Object.defineProperty({}, 'planId', {
      enumerable: true,
      get() {
        reads += 1;
        return prepared.payload.planId;
      },
    });

    const result = await f.adapter.act({
      adapterId: f.adapterId,
      actionId: 'payload-getter',
      capability: prepared.capability,
      effect: prepared.effect,
      idempotency: prepared.idempotency,
      payload,
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.dispatch, 'not-dispatched');
    assert.equal(reads, 0);
  } finally {
    await f.cleanup();
  }
});

test('cross-adapter expected refs cannot authorize mutation preparation', async () => {
  const first = await filesystemMutationFixture({ adapterId: 'filesystem-first' });
  const second = await filesystemMutationFixture({ adapterId: 'filesystem-second' });
  try {
    await writeFile(join(first.root, 'first.txt'), 'first');
    await writeFile(join(second.root, 'second.txt'), 'second');
    const foreign = await first.adapter.resolvePath('first.txt');

    await expectCode(
      second.adapter.prepareMutation({ operation: 'write-file', path: 'second.txt', expectedTarget: foreign, content: 'wrong-authority', overwrite: true }),
      'filesystem-invalid-request',
    );
    assert.equal(await readFile(join(second.root, 'second.txt'), 'utf8'), 'second');
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test('effect confusion is rejected without consuming a prepared plan', async () => {
  const f = await filesystemMutationFixture();
  try {
    const prepared = await f.adapter.prepareMutation({ operation: 'create-file', path: 'effect.txt', content: 'content' });
    const wrongEffect = {
      ...mutationAction(f.adapterId, prepared, 'wrong-effect'),
      effect: 'local-destructive' as const,
    };

    const rejected = await f.adapter.act(wrongEffect);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.dispatch, 'not-dispatched');

    const completed = await f.adapter.act(mutationAction(f.adapterId, prepared, 'correct-effect'));
    assert.equal(completed.status, 'completed');
    assert.equal(completed.verification, 'verified');
  } finally {
    await f.cleanup();
  }
});
