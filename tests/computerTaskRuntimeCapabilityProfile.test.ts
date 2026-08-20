import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPUTER_TASK_RUNTIME_CAPABILITY_PROFILE,
  CURRENT_COMPUTER_USE_CAPABILITY_PROFILE,
  computerCapabilityImplementationState,
} from '../src/computer/computerUseCapabilityProfiles.js';

test('ComputerTaskRuntime advertises implemented routing checkpointing and approval', () => {
  for (const capability of [
    'adapter-routing',
    'task-checkpointing',
    'explicit-confirmation-gate',
  ] as const) {
    const state = computerCapabilityImplementationState(COMPUTER_TASK_RUNTIME_CAPABILITY_PROFILE, capability);
    assert.equal(state.status, 'implemented', capability);
    assert.deepEqual(state.scopes, ['computer-task-runtime'], capability);
  }
});

test('ComputerTaskRuntime keeps generic side-effect verification partial', () => {
  const runtimeState = computerCapabilityImplementationState(
    COMPUTER_TASK_RUNTIME_CAPABILITY_PROFILE,
    'side-effect-verification',
  );
  assert.equal(runtimeState.status, 'partial');
  assert.deepEqual(runtimeState.scopes, ['computer-task-runtime']);
  assert.match(runtimeState.note ?? '', /domain-specific verification remains external/u);

  assert.equal(
    computerCapabilityImplementationState(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE, 'side-effect-verification').status,
    'partial',
  );
});

test('integrated profile preserves implemented checkpointing without widening verification', () => {
  assert.equal(
    computerCapabilityImplementationState(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE, 'task-checkpointing').status,
    'implemented',
  );
  assert.equal(
    computerCapabilityImplementationState(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE, 'explicit-confirmation-gate').status,
    'implemented',
  );
  assert.notEqual(
    computerCapabilityImplementationState(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE, 'side-effect-verification').status,
    'implemented',
  );
});
