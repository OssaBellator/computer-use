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
  prepareTaskCheckpointResume,
  serializeTaskCheckpoint,
  type CheckpointableTaskProgram,
  type TaskCheckpoint,
} from '../src/agent/taskCheckpoint.js';

const BROWSER_FINGERPRINT = 'd'.repeat(64);
const STALE_BROWSER_FINGERPRINT = 'c'.repeat(64);
const EXECUTION_ID = 'a'.repeat(32);
const OTHER_EXECUTION_ID = 'b'.repeat(32);

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
    executionId: EXECUTION_ID,
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

function compatibleOptions(overrides: Partial<Parameters<typeof checkTaskCheckpointCompatibility>[1]> = {}) {
  return {
    programId: 'fixture/checkout',
    executionId: EXECUTION_ID,
    program,
    currentBrowserStateFingerprint: BROWSER_FINGERPRINT,
    ...overrides,
  };
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

test('checkpoint codec round-trips deterministically with execution identity', () => {
  const value = checkpoint({ visits: new Map([['type-secret', 1]]) });
  const first = serializeTaskCheckpoint(value);
  const decoded = deserializeTaskCheckpoint(first);
  const second = serializeTaskCheckpoint(decoded);
  assert.deepEqual(decoded, value);
  assert.equal(second, first);
  assert.equal(decoded.version, TASK_CHECKPOINT_VERSION);
  assert.equal(decoded.execution.id, EXECUTION_ID);
});

test('created and decoded checkpoints are deeply frozen to preserve validated budgets and counters', () => {
  const created = checkpoint();
  const decoded = deserializeTaskCheckpoint(serializeTaskCheckpoint(created));
  for (const value of [
    created, created.program, created.execution, created.cursor, created.cursor.visits, created.cursor.visits[0], created.budgets,
    decoded, decoded.program, decoded.execution, decoded.cursor, decoded.cursor.visits, decoded.cursor.visits[0], decoded.budgets,
  ]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { (decoded.budgets as { maxSteps: number }).maxSteps = 999; }, TypeError);
});

test('program hashing covers the full valid program and is independent of object key insertion order', () => {
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

  const invalidProgram = { ...program, version: 2 } as unknown as CheckpointableTaskProgram;
  assert.throws(
    () => hashTaskProgram(invalidProgram),
    (error: unknown) => error instanceof TaskCheckpointCodecError && error.code === 'invalid-program',
  );
});

test('visit ordering uses locale-independent code-unit order', () => {
  const unicodeProgram: CheckpointableTaskProgram = {
    version: 1,
    entry: 'z',
    steps: [
      { id: 'z', kind: 'assert', condition: { kind: 'targets', state: {} }, next: 'ä' },
      { id: 'ä', kind: 'assert', condition: { kind: 'targets', state: {} }, next: 'done' },
      { id: 'done', kind: 'complete' },
    ],
  };
  const value = createTaskCheckpoint({
    programId: 'fixture/unicode', executionId: EXECUTION_ID, program: unicodeProgram,
    currentStepId: 'done', stepsExecuted: 2,
    visits: new Map([['ä', 1], ['z', 1]]), consecutiveNoProgress: 0,
    budgets: { maxSteps: 10, maxVisitsPerStep: 4, maxConsecutiveNoProgress: 4 },
    browserStateFingerprint: BROWSER_FINGERPRINT,
  });
  assert.deepEqual(value.cursor.visits.map((visit) => visit.stepId), ['z', 'ä']);
  const decoded = deserializeTaskCheckpoint(serializeTaskCheckpoint(value));
  assert.deepEqual(decoded.cursor.visits.map((visit) => visit.stepId), ['z', 'ä']);
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

test('checkpoint creation rejects invalid programs, execution ids, and impossible execution state', () => {
  const invalidProgram = { ...program, version: 2 } as unknown as CheckpointableTaskProgram;
  assert.throws(
    () => checkpoint({ program: invalidProgram }),
    (error: unknown) => error instanceof TaskCheckpointCodecError && error.code === 'invalid-program',
  );
  assert.throws(
    () => checkpoint({ executionId: 'not-an-opaque-run-id' }),
    (error: unknown) => error instanceof TaskCheckpointCodecError && error.code === 'invalid-schema',
  );
  assert.throws(
    () => checkpoint({ currentStepId: 'missing' }),
    (error: unknown) => error instanceof TaskCheckpointCodecError && error.code === 'invalid-state',
  );
  assert.throws(
    () => checkpoint({ stepsExecuted: 1, visits: { 'type-secret': 1 }, consecutiveNoProgress: 2 }),
    (error: unknown) => error instanceof TaskCheckpointCodecError && error.code === 'invalid-state',
  );
});

test('compatibility rejects wrong, modified, and cross-execution checkpoints', () => {
  const value = checkpoint();
  const wrong = checkTaskCheckpointCompatibility(value, compatibleOptions({ programId: 'fixture/other' }));
  assert.ok(issueCodes(wrong).includes('wrong-program'));

  const modified: CheckpointableTaskProgram = {
    ...program,
    steps: program.steps.map((step) => step.id === 'review' ? { ...step, description: 'changed-review' } : step),
  };
  const changed = checkTaskCheckpointCompatibility(value, compatibleOptions({ program: modified }));
  assert.ok(issueCodes(changed).includes('modified-program'));
  assert.notEqual(hashTaskProgram(modified), value.program.hash);

  const wrongExecution = checkTaskCheckpointCompatibility(value, compatibleOptions({ executionId: OTHER_EXECUTION_ID }));
  assert.ok(issueCodes(wrongExecution).includes('wrong-execution'));
});

test('compatibility rejects impossible graph history, malformed counters, exhausted budgets, and stale browser state', () => {
  const impossible = mutatedCheckpoint((value) => ({ ...value, cursor: { ...value.cursor, stepId: 'missing' } }));
  assert.ok(issueCodes(checkTaskCheckpointCompatibility(impossible, compatibleOptions())).includes('impossible-step'));

  const zeroStepJump = mutatedCheckpoint((value) => ({
    ...value,
    cursor: { stepId: 'review', stepsExecuted: 0, visits: [], consecutiveNoProgress: 0 },
  }));
  assert.ok(issueCodes(checkTaskCheckpointCompatibility(zeroStepJump, compatibleOptions())).includes('impossible-step'));

  const malformed = mutatedCheckpoint((value) => ({ ...value, cursor: { ...value.cursor, stepsExecuted: 7 } }));
  assert.ok(issueCodes(checkTaskCheckpointCompatibility(malformed, compatibleOptions())).includes('malformed-counters'));

  const impossibleNoProgress = mutatedCheckpoint((value) => ({
    ...value,
    cursor: { ...value.cursor, consecutiveNoProgress: 2 },
  }));
  assert.ok(issueCodes(checkTaskCheckpointCompatibility(impossibleNoProgress, compatibleOptions())).includes('malformed-counters'));

  const duplicate = mutatedCheckpoint((value) => ({
    ...value,
    cursor: { ...value.cursor, stepsExecuted: 2, visits: [{ stepId: 'type-secret', count: 1 }, { stepId: 'type-secret', count: 1 }] },
  }));
  assert.ok(issueCodes(checkTaskCheckpointCompatibility(duplicate, compatibleOptions())).includes('malformed-counters'));

  const exhausted = mutatedCheckpoint((value) => ({
    ...value,
    cursor: { ...value.cursor, stepId: 'type-secret', stepsExecuted: 8, visits: [{ stepId: 'type-secret', count: 8 }] },
  }));
  assert.ok(issueCodes(checkTaskCheckpointCompatibility(exhausted, compatibleOptions())).includes('exhausted-budget'));

  const stale = checkTaskCheckpointCompatibility(checkpoint(), compatibleOptions({ currentBrowserStateFingerprint: STALE_BROWSER_FINGERPRINT }));
  assert.ok(issueCodes(stale).includes('browser-state-mismatch'));

  const unverified = checkTaskCheckpointCompatibility(checkpoint(), compatibleOptions({ currentBrowserStateFingerprint: undefined }));
  assert.ok(issueCodes(unverified).includes('browser-state-unverified'));
});

test('compatibility rejects a structurally unreachable checkpoint step even when the program is valid', () => {
  const graphProgram: CheckpointableTaskProgram = {
    version: 1,
    entry: 'entry',
    steps: [
      { id: 'entry', kind: 'assert', condition: { kind: 'targets', state: {} }, next: 'done' },
      { id: 'done', kind: 'complete' },
      { id: 'orphan', kind: 'complete' },
    ],
  };
  const valid = createTaskCheckpoint({
    programId: 'fixture/graph', executionId: EXECUTION_ID, program: graphProgram,
    currentStepId: 'done', stepsExecuted: 1, visits: { entry: 1 }, consecutiveNoProgress: 0,
    budgets: { maxSteps: 10, maxVisitsPerStep: 4, maxConsecutiveNoProgress: 4 },
    browserStateFingerprint: BROWSER_FINGERPRINT,
  });
  const impossible = { ...valid, cursor: { ...valid.cursor, stepId: 'orphan' } };
  const result = checkTaskCheckpointCompatibility(impossible, {
    programId: 'fixture/graph', executionId: EXECUTION_ID, program: graphProgram,
    currentBrowserStateFingerprint: BROWSER_FINGERPRINT,
  });
  assert.ok(issueCodes(result).includes('impossible-step'));
});

test('compatibility rejects an invalid current program even before runtime integration', () => {
  const invalidProgram = { ...program, version: 2 } as unknown as CheckpointableTaskProgram;
  const result = checkTaskCheckpointCompatibility(checkpoint(), compatibleOptions({ program: invalidProgram }));
  assert.ok(issueCodes(result).includes('invalid-program'));
});

test('trusted inputs are rebound from own data properties only and accessors are never invoked', () => {
  const inherited = { secret: 'inherited-secret' };
  const trusted = Object.assign(Object.create(inherited) as Record<string, string>, {
    counterparty: 'Synthetic Merchant 42',
    amount: '123.45',
    unrelatedToken: 'do-not-forward',
  });
  let accessorReads = 0;
  Object.defineProperty(trusted, 'secret', {
    enumerable: true,
    configurable: true,
    get() { accessorReads += 1; return 'getter-secret'; },
  });
  const missing = bindTrustedTaskResumeInputs(program, trusted);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingInputs, ['secret']);
  assert.equal(accessorReads, 0);

  Object.defineProperty(trusted, 'secret', { enumerable: true, configurable: true, writable: true, value: 'correct horse battery staple' });
  const bound = bindTrustedTaskResumeInputs(program, trusted);
  assert.equal(bound.ok, true);
  assert.deepEqual({ ...bound.inputs }, {
    secret: 'correct horse battery staple',
    counterparty: trusted.counterparty,
    amount: trusted.amount,
  });
  assert.equal('unrelatedToken' in (bound.inputs ?? {}), false);

  const encoded = serializeTaskCheckpoint(checkpoint());
  for (const sensitive of ['correct horse battery staple', trusted.counterparty, trusted.amount, trusted.unrelatedToken]) {
    assert.equal(encoded.includes(sensitive), false);
  }
  for (const prohibited of ['cookie', 'authToken', 'pageExcerpt', 'Synthetic Merchant 42', '123.45']) {
    assert.equal(encoded.includes(prohibited), false);
  }
});

test('resume preparation checks execution and browser compatibility before reading trusted inputs', () => {
  let reads = 0;
  const trusted = {} as Record<string, string>;
  for (const name of program.inputs ?? []) {
    Object.defineProperty(trusted, name, {
      enumerable: true,
      get() { reads += 1; throw new Error('must not read incompatible inputs'); },
    });
  }
  const blocked = prepareTaskCheckpointResume(checkpoint(), {
    ...compatibleOptions({ executionId: OTHER_EXECUTION_ID }),
    trustedInputs: trusted,
  });
  assert.equal(blocked.ready, false);
  assert.ok(issueCodes({ compatible: false, issues: blocked.issues }).includes('wrong-execution'));
  assert.equal(reads, 0);

  const ready = prepareTaskCheckpointResume(checkpoint(), {
    ...compatibleOptions(),
    trustedInputs: { secret: 's', counterparty: 'c', amount: 'a', extra: 'ignored' },
  });
  assert.equal(ready.ready, true);
  assert.deepEqual({ ...ready.inputs }, { secret: 's', counterparty: 'c', amount: 'a' });
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
    programId: 'fixture/large', executionId: EXECUTION_ID, program: maximumProgram,
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
      programId: 'fixture/overflow', executionId: EXECUTION_ID, program: overflowProgram,
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
