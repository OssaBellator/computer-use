import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_CHECKPOINT_MAX_BYTES,
  TASK_CHECKPOINT_MAX_VISIT_ENTRIES,
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

const BROWSER_FINGERPRINT = 'd'.repeat(64);
const STALE_BROWSER_FINGERPRINT = 'c'.repeat(64);

const program: CheckpointableTaskProgram = {
  version: 1,
  name: 'checkout-fixture',
  entry: 'type-secret',
  inputs: ['secret', 'counterparty', 'amount'],
  steps: [
    { id: 'type-secret', kind: 'type', target: 'secret', text: { input: 'secret' }, next: 'review' },
    { id: 'review', kind: 'assert', condition: { kind: 'exists', target: 'review' }, next: 'done' },
    { id: 'done', kind: 'complete' },
  ],
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
    browserStateFingerprint: BROWSER_FINGERPRINT,
    ...overrides,
  });
}

function issueCodes(value: ReturnType<typeof checkTaskCheckpointCompatibility>): string[] {
  return value.issues.map((issue) => issue.code);
}

function mutatedCheckpoint(mutate: (value: TaskCheckpoint) => TaskCheckpoint): TaskCheckpoint {
  return mutate(checkpoint());
}

function largeProgram(stepCount: number): CheckpointableTaskProgram {
  const ids = Array.from({ length: stepCount }, (_, index) => `step-${String(index).padStart(3, '0')}-${'x'.repeat(110)}`);
  return {
    version: 1,
    entry: ids[0]!,
    steps: ids.map((id, index) => index === ids.length - 1
      ? { id, kind: 'complete' }
      : { id, kind: 'assert', condition: { kind: 'targets', state: {} }, next: ids[index + 1]! }),
  };
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

test('program hashing covers the full program and is independent of object key insertion order', () => {
  const reordered: CheckpointableTaskProgram = {
    steps: program.steps,
    inputs: program.inputs,
    entry: program.entry,
    name: program.name,
    version: 1,
  };
  assert.equal(hashTaskProgram(reordered), hashTaskProgram(program));

  const modified: CheckpointableTaskProgram = {
    ...program,
    steps: program.steps.map((step) => step.id === 'type-secret' ? { ...step, next: 'done' } : step),
  };
  assert.notEqual(hashTaskProgram(modified), hashTaskProgram(program));
});

test('codec rejects corruption and unsupported checkpoint versions', () => {
  const encoded = serializeTaskCheckpoint(checkpoint());
  const corrupted = encoded.replace(BROWSER_FINGERPRINT, `${'e'.repeat(63)}f`);
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

test('checkpoint creation rejects invalid programs and non-resumable execution state', () => {
  const invalidProgram = { ...program, version: 2 } as unknown as CheckpointableTaskProgram;
  assert.throws(
    () => checkpoint({ program: invalidProgram }),
    (error: unknown) => error instanceof TaskCheckpointCodecError && error.code === 'invalid-program',
  );
  assert.throws(
    () => checkpoint({ currentStepId: 'missing' }),
    (error: unknown) => error instanceof TaskCheckpointCodecError && error.code === 'invalid-state',
  );
  assert.throws(
    () => checkpoint({ stepsExecuted: 7 }),
    (error: unknown) => error instanceof TaskCheckpointCodecError && error.code === 'invalid-state',
  );
});

test('compatibility rejects wrong and modified programs', () => {
  const value = checkpoint();
  const wrong = checkTaskCheckpointCompatibility(value, {
    programId: 'fixture/other',
    program,
    currentBrowserStateFingerprint: BROWSER_FINGERPRINT,
  });
  assert.ok(issueCodes(wrong).includes('wrong-program'));

  const modified: CheckpointableTaskProgram = {
    ...program,
    steps: program.steps.map((step) => step.id === 'review' ? { ...step, description: 'changed-review' } : step),
  };
  const changed = checkTaskCheckpointCompatibility(value, {
    programId: 'fixture/checkout',
    program: modified,
    currentBrowserStateFingerprint: BROWSER_FINGERPRINT,
  });
  assert.ok(issueCodes(changed).includes('modified-program'));
  assert.notEqual(hashTaskProgram(modified), value.program.hash);
});

test('compatibility rejects impossible steps, malformed counters, exhausted budgets, and stale browser state', () => {
  const impossible = mutatedCheckpoint((value) => ({ ...value, cursor: { ...value.cursor, stepId: 'missing' } }));
  assert.ok(issueCodes(checkTaskCheckpointCompatibility(impossible, {
    programId: 'fixture/checkout', program, currentBrowserStateFingerprint: BROWSER_FINGERPRINT,
  })).includes('impossible-step'));

  const malformed = mutatedCheckpoint((value) => ({ ...value, cursor: { ...value.cursor, stepsExecuted: 7 } }));
  assert.ok(issueCodes(checkTaskCheckpointCompatibility(malformed, {
    programId: 'fixture/checkout', program, currentBrowserStateFingerprint: BROWSER_FINGERPRINT,
  })).includes('malformed-counters'));

  const duplicate = mutatedCheckpoint((value) => ({
    ...value,
    cursor: { ...value.cursor, stepsExecuted: 2, visits: [{ stepId: 'type-secret', count: 1 }, { stepId: 'type-secret', count: 1 }] },
  }));
  assert.ok(issueCodes(checkTaskCheckpointCompatibility(duplicate, {
    programId: 'fixture/checkout', program, currentBrowserStateFingerprint: BROWSER_FINGERPRINT,
  })).includes('malformed-counters'));

  const exhausted = mutatedCheckpoint((value) => ({
    ...value,
    cursor: { ...value.cursor, stepId: 'type-secret', stepsExecuted: 8, visits: [{ stepId: 'type-secret', count: 8 }] },
  }));
  assert.ok(issueCodes(checkTaskCheckpointCompatibility(exhausted, {
    programId: 'fixture/checkout', program, currentBrowserStateFingerprint: BROWSER_FINGERPRINT,
  })).includes('exhausted-budget'));

  const stale = checkTaskCheckpointCompatibility(checkpoint(), {
    programId: 'fixture/checkout', program, currentBrowserStateFingerprint: STALE_BROWSER_FINGERPRINT,
  });
  assert.ok(issueCodes(stale).includes('browser-state-mismatch'));

  const unverified = checkTaskCheckpointCompatibility(checkpoint(), {
    programId: 'fixture/checkout', program,
  });
  assert.ok(issueCodes(unverified).includes('browser-state-unverified'));
});

test('compatibility rejects an invalid current program even before runtime integration', () => {
  const invalidProgram = { ...program, version: 2 } as unknown as CheckpointableTaskProgram;
  const result = checkTaskCheckpointCompatibility(checkpoint(), {
    programId: 'fixture/checkout', program: invalidProgram, currentBrowserStateFingerprint: BROWSER_FINGERPRINT,
  });
  assert.ok(issueCodes(result).includes('invalid-program'));
});

test('trusted inputs are rebound from own properties only and never serialized', () => {
  const inherited = { secret: 'inherited-secret' };
  const trusted = Object.assign(Object.create(inherited) as Record<string, string>, {
    counterparty: 'Synthetic Merchant 42',
    amount: '123.45',
    unrelatedToken: 'do-not-forward',
  });
  const missing = bindTrustedTaskResumeInputs(program, trusted);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingInputs, ['secret']);

  trusted.secret = 'correct horse battery staple';
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
  for (const prohibited of ['cookie', 'authToken', 'pageExcerpt', 'Synthetic Merchant 42', '123.45']) {
    assert.equal(encoded.includes(prohibited), false);
  }
});

test('strict schema prevents sensitive fields from being smuggled into a checkpoint', () => {
  const unsafe = { ...checkpoint(), authToken: 'synthetic-token' } as unknown as TaskCheckpoint;
  assert.throws(
    () => serializeTaskCheckpoint(unsafe),
    (error: unknown) => error instanceof TaskCheckpointCodecError && error.code === 'invalid-schema',
  );
});

test('serialized checkpoints stay bounded at maximum visit cardinality and reject overflow', () => {
  const maximumProgram = largeProgram(TASK_CHECKPOINT_MAX_VISIT_ENTRIES + 1);
  const visits: Record<string, number> = {};
  for (const step of maximumProgram.steps.slice(0, TASK_CHECKPOINT_MAX_VISIT_ENTRIES)) visits[step.id] = 1;
  const maximum = createTaskCheckpoint({
    programId: 'fixture/large',
    program: maximumProgram,
    currentStepId: maximumProgram.steps[TASK_CHECKPOINT_MAX_VISIT_ENTRIES]!.id,
    stepsExecuted: TASK_CHECKPOINT_MAX_VISIT_ENTRIES,
    visits,
    consecutiveNoProgress: 0,
    budgets: { maxSteps: 500, maxVisitsPerStep: 8, maxConsecutiveNoProgress: 4 },
    browserStateFingerprint: BROWSER_FINGERPRINT,
  });
  const encoded = serializeTaskCheckpoint(maximum);
  assert.ok(Buffer.byteLength(encoded, 'utf8') <= TASK_CHECKPOINT_MAX_BYTES);

  const overflowProgram = largeProgram(TASK_CHECKPOINT_MAX_VISIT_ENTRIES + 2);
  const overflowVisits: Record<string, number> = {};
  for (const step of overflowProgram.steps.slice(0, TASK_CHECKPOINT_MAX_VISIT_ENTRIES + 1)) overflowVisits[step.id] = 1;
  assert.throws(
    () => createTaskCheckpoint({
      programId: 'fixture/overflow',
      program: overflowProgram,
      currentStepId: overflowProgram.steps[TASK_CHECKPOINT_MAX_VISIT_ENTRIES + 1]!.id,
      stepsExecuted: TASK_CHECKPOINT_MAX_VISIT_ENTRIES + 1,
      visits: overflowVisits,
      consecutiveNoProgress: 0,
      budgets: { maxSteps: 500, maxVisitsPerStep: 8, maxConsecutiveNoProgress: 4 },
      browserStateFingerprint: BROWSER_FINGERPRINT,
    }),
    (error: unknown) => error instanceof TaskCheckpointCodecError && error.code === 'invalid-schema',
  );

  assert.throws(
    () => deserializeTaskCheckpoint(' '.repeat(TASK_CHECKPOINT_MAX_BYTES + 1)),
    (error: unknown) => error instanceof TaskCheckpointCodecError && error.code === 'payload-too-large',
  );
});
