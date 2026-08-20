import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import {
  createComputerTaskCheckpoint,
  decodeComputerTaskCheckpoint,
  encodeComputerTaskCheckpoint,
  type ComputerTaskCheckpoint,
} from '../src/computer/computerTaskCheckpoint.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';
const SECRET = 'arbitrary-secret-metadata-must-not-survive';

const PROGRAM: ComputerTaskProgram = {
  id: 'strict-checkpoint-schema-test',
  entry: 'write',
  steps: [{
    kind: 'action',
    id: 'write',
    request: {
      adapterId: 'fake',
      actionId: 'write',
      capability: 'fake.write',
      effect: 'local-reversible',
      idempotency: 'non-idempotent',
    },
  }],
};

function checkpoint(): ComputerTaskCheckpoint {
  return createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 0,
    actions: { write: 'not-started' },
  });
}

test('encoder rejects arbitrary root checkpoint metadata', () => {
  const forged = { ...checkpoint(), arbitraryData: SECRET } as unknown as ComputerTaskCheckpoint;
  assert.throws(() => encodeComputerTaskCheckpoint(forged), /unsupported fields/);
});

test('encoder rejects arbitrary nested action metadata', () => {
  const valid = checkpoint();
  const forged = {
    ...valid,
    actions: [{ ...valid.actions[0]!, adapterObservationData: SECRET }],
  } as unknown as ComputerTaskCheckpoint;
  assert.throws(() => encodeComputerTaskCheckpoint(forged), /unsupported fields/);
});

test('encoder rejects arbitrary cursor and identity metadata', () => {
  const valid = checkpoint();
  assert.throws(() => encodeComputerTaskCheckpoint({
    ...valid,
    cursor: { ...valid.cursor, transcript: SECRET },
  } as unknown as ComputerTaskCheckpoint), /unsupported fields/);
  assert.throws(() => encodeComputerTaskCheckpoint({
    ...valid,
    program: { ...valid.program, rawPayload: SECRET },
  } as unknown as ComputerTaskCheckpoint), /unsupported fields/);
  assert.throws(() => encodeComputerTaskCheckpoint({
    ...valid,
    execution: { ...valid.execution, token: SECRET },
  } as unknown as ComputerTaskCheckpoint), /unsupported fields/);
});

test('decoder rejects unsigned extension fields on the outer envelope', () => {
  const encoded = encodeComputerTaskCheckpoint(checkpoint());
  const envelope = JSON.parse(encoded) as Record<string, unknown>;
  envelope.pageExcerpt = SECRET;
  assert.throws(() => decodeComputerTaskCheckpoint(JSON.stringify(envelope)), /unsupported fields/);
});

test('decoder rejects extension fields in the integrity object', () => {
  const encoded = encodeComputerTaskCheckpoint(checkpoint());
  const envelope = JSON.parse(encoded) as {
    integrity: Record<string, unknown>;
  };
  envelope.integrity.secret = SECRET;
  assert.throws(() => decodeComputerTaskCheckpoint(JSON.stringify(envelope)), /unsupported fields/);
});

test('decoder rejects arbitrary payload metadata before returning a provenanced checkpoint', () => {
  const encoded = encodeComputerTaskCheckpoint(checkpoint());
  const envelope = JSON.parse(encoded) as {
    payload: Record<string, unknown>;
  };
  envelope.payload.filesystemContents = SECRET;
  assert.throws(() => decodeComputerTaskCheckpoint(JSON.stringify(envelope)), /unsupported fields/);
});
