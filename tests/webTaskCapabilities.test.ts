import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskProgram } from '../src/agent/taskProgram.js';
import {
  STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
  WEB_TASK_CATEGORIES,
  WEB_TASK_CATEGORY_DEFINITIONS,
  analyzeTaskProgramCapabilities,
  assessCapabilityRequirements,
  assessWebTaskCategory,
  commitmentRequiresExplicitApproval,
} from '../src/capabilities/webTaskCapabilities.js';

test('web capability taxonomy defines exactly the seven long-term task categories', () => {
  assert.equal(WEB_TASK_CATEGORIES.length, 7);
  assert.deepEqual(
    Object.keys(WEB_TASK_CATEGORY_DEFINITIONS).sort(),
    [...WEB_TASK_CATEGORIES].sort(),
  );
  for (const category of WEB_TASK_CATEGORIES) {
    assert.ok(WEB_TASK_CATEGORY_DEFINITIONS[category].label.length > 0);
    assert.ok(WEB_TASK_CATEGORY_DEFINITIONS[category].examples.length > 0);
  }
});

test('standalone profile exposes general document observation as a real research gap', () => {
  const assessment = assessWebTaskCategory(
    STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
    'information-retrieval-research',
  );
  assert.equal(assessment.runnable, false);
  assert.equal(assessment.fullySupported, false);
  assert.equal(
    assessment.requiredUnsupported.some(
      (entry) => entry.requirement.capability === 'document-content-observation',
    ),
    true,
  );
});

test('partial required capabilities stay visible without being treated as absent', () => {
  const assessment = assessCapabilityRequirements(
    STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
    [
      { capability: 'navigation' },
      { capability: 'network-activity-observation' },
      { capability: 'clipboard-write', level: 'preferred' },
    ],
  );
  assert.equal(assessment.runnable, true);
  assert.equal(assessment.fullySupported, false);
  assert.deepEqual(
    assessment.requiredPartial.map((entry) => entry.requirement.capability),
    ['network-activity-observation'],
  );
  assert.deepEqual(
    assessment.preferredUnsupported.map((entry) => entry.requirement.capability),
    ['clipboard-write'],
  );
});

test('task-program analysis infers browser mechanics and approval requirements', () => {
  const program: TaskProgram = {
    version: 1,
    entry: 'navigate',
    steps: [
      {
        id: 'navigate',
        kind: 'navigate',
        url: 'https://example.com/',
        next: 'type',
      },
      {
        id: 'type',
        kind: 'type',
        target: { name: 'Message' },
        text: 'hello',
        next: 'upload',
      },
      {
        id: 'upload',
        kind: 'upload',
        risk: 'external-side-effect',
        target: { name: 'Attachment' },
        files: ['/tmp/example.txt'],
        next: 'network',
      },
      {
        id: 'network',
        kind: 'wait-network-idle',
        next: 'assert-download',
      },
      {
        id: 'assert-download',
        kind: 'assert',
        condition: {
          kind: 'downloads',
          state: { completedCountAtLeast: 1 },
        },
        next: 'complete',
      },
      {
        id: 'complete',
        kind: 'complete',
      },
    ],
  };

  const analysis = analyzeTaskProgramCapabilities(program);
  assert.deepEqual(analysis.required, [
    'task-program-execution',
    'navigation',
    'network-activity-observation',
    'download-observation',
    'keyboard-input',
    'text-entry',
    'file-upload',
    'explicit-confirmation-gate',
  ]);
  assert.deepEqual(analysis.externalSideEffectStepIds, ['upload']);
  assert.deepEqual(analysis.approvalStepIds, ['upload']);
});

test('commitment classes encode default explicit-approval boundaries', () => {
  assert.equal(commitmentRequiresExplicitApproval('observe-only'), false);
  assert.equal(commitmentRequiresExplicitApproval('local-reversible'), false);
  assert.equal(commitmentRequiresExplicitApproval('remote-reversible'), false);
  assert.equal(commitmentRequiresExplicitApproval('remote-publish'), true);
  assert.equal(commitmentRequiresExplicitApproval('financial'), true);
  assert.equal(commitmentRequiresExplicitApproval('identity-security'), true);
  assert.equal(commitmentRequiresExplicitApproval('process-trigger'), true);
});
