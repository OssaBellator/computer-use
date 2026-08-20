import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import {
  createComputerTaskCheckpoint,
  decodeComputerTaskCheckpoint,
  encodeComputerTaskCheckpoint,
  type ComputerTaskCheckpoint,
} from '../src/computer/computerTaskCheckpoint.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';

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

test('encoder strips arbitrary root and nested metadata instead of enumerating it into persistence', () => {
  const valid = checkpoint();
  const forged = {
    ...valid,
    arbitraryData: SECRET,
    program: { ...valid.program, rawPayload: SECRET },
    execution: { ...valid.execution, token: SECRET },
    cursor: { ...valid.cursor, transcript: SECRET },
    actions: [{ ...valid.actions[0]!, adapterObservationData: SECRET }],
  } as unknown as ComputerTaskCheckpoint;

  const encoded = encodeComputerTaskCheckpoint(forged);
  assert.equal(encoded.includes(SECRET), false);
  assert.deepEqual(decodeComputerTaskCheckpoint(encoded), valid);
});

test('decoder ignores extension fields while returning only the reviewed normalized schema', () => {
  const encoded = encodeComputerTaskCheckpoint(checkpoint());
  const envelope = JSON.parse(encoded) as {
    integrity: Record<string, unknown>;
    payload: Record<string, unknown>;
    [key: string]: unknown;
  };
  envelope.pageExcerpt = SECRET;
  envelope.integrity.secret = SECRET;
  envelope.payload.filesystemContents = SECRET;

  const decoded = decodeComputerTaskCheckpoint(JSON.stringify(envelope));
  assert.deepEqual(decoded, checkpoint());
  assert.equal(encodeComputerTaskCheckpoint(decoded).includes(SECRET), false);
});

test('reviewed accessor fields are rejected without invoking getters', () => {
  const valid = checkpoint();
  let rootGetterCalls = 0;
  const forged: Record<string, unknown> = {
    version: valid.version,
    execution: valid.execution,
    cursor: valid.cursor,
    actions: valid.actions,
  };
  Object.defineProperty(forged, 'program', {
    enumerable: true,
    get() {
      rootGetterCalls += 1;
      return valid.program;
    },
  });

  assert.throws(() => encodeComputerTaskCheckpoint(forged as unknown as ComputerTaskCheckpoint), /data properties/);
  assert.equal(rootGetterCalls, 0);
});

test('nested action accessors are rejected without invoking getters', () => {
  const valid = checkpoint();
  let stateGetterCalls = 0;
  const action: Record<string, unknown> = { stepId: 'write' };
  Object.defineProperty(action, 'state', {
    enumerable: true,
    get() {
      stateGetterCalls += 1;
      return 'not-started';
    },
  });
  const forged = { ...valid, actions: [action] } as unknown as ComputerTaskCheckpoint;

  assert.throws(() => encodeComputerTaskCheckpoint(forged), /data properties/);
  assert.equal(stateGetterCalls, 0);
});

test('encoder never requires a Proxy ownKeys traversal', () => {
  const valid = checkpoint();
  let ownKeysCalls = 0;
  const proxied = new Proxy(valid, {
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error('ownKeys must not be called');
    },
  });

  assert.doesNotThrow(() => encodeComputerTaskCheckpoint(proxied));
  assert.equal(ownKeysCalls, 0);
});

test('runtime resume consumes descriptor-captured snapshot rather than later ordinary proxy reads', () => {
  const valid = checkpoint();
  let ordinaryReads = 0;
  const proxied = new Proxy(valid, {
    get() {
      ordinaryReads += 1;
      throw new Error('ordinary checkpoint property read');
    },
  });

  const runtime = new ComputerTaskRuntime(PROGRAM, new ComputerEnvironmentRegistry(), {
    executionId: EXECUTION_ID,
    checkpoint: proxied,
  });
  assert.deepEqual(runtime.checkpoint(), valid);
  assert.equal(ordinaryReads, 0);
});
