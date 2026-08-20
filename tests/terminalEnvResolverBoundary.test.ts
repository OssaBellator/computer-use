import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { HostTerminalAdapter, type ExecutionPathBinder, type ProcessSpawner, type TerminalExecutionEffectResolver } from '../src/computer/terminalAdapter.js';
import { ProcessIdentityStore, type ProcessSnapshotSource } from '../src/computer/processAdapter.js';

const source: ProcessSnapshotSource = {
  async listPids() { return { pids: [], truncated: false }; },
  async inspect() { return undefined; },
};

function request(env: Record<string, string>, effect: 'security-sensitive' | 'process-execution' = 'security-sensitive') {
  return {
    adapterId: 'terminal:test', actionId: 'a', capability: 'terminal.execute.argv', effect, idempotency: 'non-idempotent',
    payload: { mode: 'argv', executable: '/bin/echo', argv: ['ok'], cwd: '/tmp', env, classification: 'local-compute' },
  } as const;
}

test('oversized env is rejected before bulk descriptor materialization or authority work', async () => {
  const env: Record<string, string> = {};
  for (let index = 0; index < 100_000; index += 1) env[`K${index}`] = 'v';
  let resolverCalls = 0; let binderCalls = 0; let spawnCalls = 0; let bulkEnvDescriptorCalls = 0;
  const resolver: TerminalExecutionEffectResolver = { requiredEffect() { resolverCalls += 1; return 'security-sensitive'; } };
  const binder: ExecutionPathBinder = { async bind() { binderCalls += 1; throw new Error('should not bind'); } };
  const spawner: ProcessSpawner = { spawn() { spawnCalls += 1; throw new Error('should not spawn'); } };
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test', source), spawner, binder, resolver);
  const originalDescriptors = Object.getOwnPropertyDescriptors;
  Object.getOwnPropertyDescriptors = ((value: object) => {
    if (value === env) { bulkEnvDescriptorCalls += 1; throw new Error('oversized env must not be bulk-materialized'); }
    return originalDescriptors(value);
  }) as typeof Object.getOwnPropertyDescriptors;
  try {
    const result = await adapter.act(request(env));
    assert.equal(result.dispatch, 'not-dispatched');
  } finally {
    Object.getOwnPropertyDescriptors = originalDescriptors;
  }
  assert.equal(bulkEnvDescriptorCalls, 0);
  assert.equal(resolverCalls, 0);
  assert.equal(binderCalls, 0);
  assert.equal(spawnCalls, 0);
});

test('resolver method replacement after construction cannot widen authority', async () => {
  let originalCalls = 0; let replacementCalls = 0; let binderCalls = 0; let spawnCalls = 0;
  const resolver: TerminalExecutionEffectResolver = {
    requiredEffect() { originalCalls += 1; return 'security-sensitive'; },
  };
  const binder: ExecutionPathBinder = { async bind() { binderCalls += 1; throw new Error('should not bind'); } };
  const spawner: ProcessSpawner = { spawn() { spawnCalls += 1; return { pid: 1, stdout: new PassThrough(), stderr: new PassThrough(), once() { return this; }, kill() { return true; } }; } };
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test', source), spawner, binder, resolver);
  resolver.requiredEffect = () => { replacementCalls += 1; return 'process-execution'; };
  const result = await adapter.act(request({}, 'process-execution'));
  assert.equal(result.dispatch, 'not-dispatched');
  assert.deepEqual(result.evidence, ['terminal.effect.mismatch']);
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 0);
  assert.equal(binderCalls, 0);
  assert.equal(spawnCalls, 0);
});
