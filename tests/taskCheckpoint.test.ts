import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_CHECKPOINT_MAX_BYTES,
  TASK_CHECKPOINT_VERSION,
  TaskCheckpointCodecError,
  bindTrustedTaskResumeInputs,
  checkTaskCheckpointCompatibility,
  createTaskCheckpoint,
  deserializeTaskCheckpoint,
  hashTaskProgram,
  serializeTaskCheckpoint,
  type CheckpointableTaskProgram,
  type TaskCheckpoint,
} from '../src/agent/taskCheckpoint.js';

const program: CheckpointableTaskProgram = {
  version: 1,
  name: 'checkout-fixture',
  entry: 'type-secret',
  inputs: ['secret', 'counterparty', 'amount'],
  steps: [
    { id: 'type-secret', kind: 'type', target: 'secret', text: { input: 'secret' }, next: 'review' },
    { id: 'review', kind: 'assert', condition: { kind: 'exists', target: 'review' }, next: 'done' },
    { id: 'done', kind: 'complete' },
  ] as unknown as readonly { id: string }[],
};

function checkpoint(overrides: Partial<Parameters<typeof createTaskCheckpoint>[0]> = {}): TaskCheckpoint {
  return createTaskCheckpoint({
    programId: 'fixture/checkout',
    program,
    currentStepId: 'review',
    stepsExecuted: 1,
    visits: { 'type-secret': 1 },
    consecutiveNoProgress: 0,
    budgets: { maxSteps: 64, maxVisitsPerStep: 8, maxConsecutiveNoProgress: 4 },
    browserStateFingerprint: 'deadbeef',
    ...overrides,
  });
}

function issueCodes(value: ReturnType<typeof checkTaskCheckpointCompatibility>): string[] {
  return value.issues.map((issue) => issue.code);
}

test('checkpoint codec round-trips deterministically', () => {
  const value = checkpoint({ visits: new Map([['type-secret', 1]]) });
  const first = serializeTaskCheckpoint(value);
  const decoded = deserializeTaskCheckpoint(first);
  const second = serializeTaskCheckpoint(decoded);
  assert.deepEqual(decoded, value);
  assert.equal(second, first);
  assert.equal(decoded.version, TASK_CHECKPOINT_VERSION);
});

test('codec rejects corruption and unsupported versions', () => {
  const encoded = serializeTaskCheckpoint(checkpoint());
  const corrupted = encoded.replace('deadbeef', 'feedbeef');
  assert.throws(
    () => deserializeTaskCheckpoint(corrupted),
    (error: unknown) => error instanceof TaskCheckpointCodecError && error.code === 'integrity-mismatch',
  );

  const parsed = JSON.parse(encoded) as { payload: { version: number } };
  parsed.payload.version = 2;
  assert.throws(
    () => deserializeTaskCheckpoint(JSON.stringify(parsed)),
    (error: unknown) => error instanceof TaskCheckpointCodecError && error.code === 'unsupported-version',
  );
});

test('compatibility rejects wrong and modified programs', () => {
  const value = checkpoint();
  const wrong = checkTaskCheckpointCompatibility(value, {
    programId: 'fixture/other',
    program,
    currentBrowserStateFingerprint: 'deadbeef',
  });
  assert.ok(issueCodes(wrong).includes('wrong-program'));

  const modified = structuredClone(program);
  modified.steps = [...modified.steps, { id: 'extra' }];
  const changed = checkTaskCheckpointCompatibility(value, {
    programId: 'fixture/checkout',
    program: modified,
    currentBrowserStateFingerprint: 'deadbeef',
  });
  assert.ok(issueCodes(changed).includes('modified-program'));
  assert.notEqual(hashTaskProgram(modified), value.program.hash);
});

test('compatibility rejects impossible steps, malformed counters, exhausted budgets, and stale browser state', () => {
  const impossible = { ...checkpoint(), cursor: { ...checkpoint().cursor, stepId: 'missing' } };
  assert.ok(issueCodes(checkTaskCheckpointCompatibility(impossible, {
    programId: 'fixture/checkout', program, currentBrowserStateFingerprint: 'deadbeef',
  })).includes('impossible-step'));

  const malformed = {
    ...checkpoint(),
    cursor: { ...checkpoint().cursor, stepsExecuted: 7 },
  };
  assert.ok(issueCodes(checkTaskCheckpointCompatibility(malformed, {
    programId: 'fixture/checkout', program, currentBrowserStateFingerprint: 'deadbeef',
  })).includes('malformed-counters'));

  const exhausted = checkpoint({
    currentStepId: 'type-secret',
    stepsExecuted: 8,
    visits: { 'type-secret': 8 },
  });
  assert.ok(issueCodes(checkTaskCheckpointCompatibility(exhausted, {
    programId: 'fixture/checkout', program, currentBrowserStateFingerprint: 'deadbeef',
  })).includes('exhausted-budget'));

  const stale = checkTaskCheckpointCompatibility(checkpoint(), {
    programId: 'fixture/checkout', program, currentBrowserStateFingerprint: 'cafebabe',
  });
  assert.ok(issueCodes(stale).includes('browser-state-mismatch'));
});

test('trusted inputs are re-bound after restart but never serialized', () => {
  const trusted = {
    secret: 'correct horse battery staple',
    counterparty: 'Synthetic Merchant 42',
    amount: '123.45',
    unrelatedToken: 'do-not-forward',
  };
  const bound = bindTrustedTaskResumeInputs(program, trusted);
  assert.equal(bound.ok, true);
  assert.deepEqual({ ...bound.inputs }, {
    secret: trusted.secret,
    counterparty: trusted.counterparty,
    amount: trusted.amount,
  });
  assert.equal('unrelatedToken' in (bound.inputs ?? {}), false);

  const encoded = serializeTaskCheckpoint(checkpoint());
  for (const sensitive of Object.values(trusted)) assert.equal(encoded.includes(sensitive), false);
  assert.equal(encoded.includes('cookie'), false);
  assert.equal(encoded.includes('authToken'), false);
  assert.equal(encoded.includes('pageExcerpt'), false);
});

test('strict schema prevents sensitive fields from being smuggled into a checkpoint', () => {
  const unsafe = { ...checkpoint(), authToken: 'synthetic-token' } as unknown as TaskCheckpoint;
  assert.throws(
    () => serializeTaskCheckpoint(unsafe),
    (error: unknown) => error instanceof TaskCheckpointCodecError && error.code === 'invalid-schema',
  );
});

test('serialized checkpoints are bounded and oversized input is rejected before parsing', () => {
  const visits: Record<string, number> = {};
  for (let index = 0; index < 200; index += 1) visits[`step-${String(index).padStart(3, '0')}`] = 1;
  const largeProgram: CheckpointableTaskProgram = {
    version: 1,
    entry: 'step-000',
    steps: Object.keys(visits).map((id) => ({ id })),
  };
  const large = createTaskCheckpoint({
    programId: 'fixture/large',
    program: largeProgram,
    currentStepId: 'step-199',
    stepsExecuted: 200,
    visits,
    consecutiveNoProgress: 0,
    budgets: { maxSteps: 500, maxVisitsPerStep: 8, maxConsecutiveNoProgress: 4 },
    browserStateFingerprint: '0123456789abcdef',
  });
  const encoded = serializeTaskCheckpoint(large);
  assert.ok(Buffer.byteLength(encoded, 'utf8') <= TASK_CHECKPOINT_MAX_BYTES);

  assert.throws(
    () => deserializeTaskCheckpoint(' '.repeat(TASK_CHECKPOINT_MAX_BYTES + 1)),
    (error: unknown) => error instanceof TaskCheckpointCodecError && error.code === 'payload-too-large',
  );
});
