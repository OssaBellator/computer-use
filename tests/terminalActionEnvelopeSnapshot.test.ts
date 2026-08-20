import test from 'node:test';
import assert from 'node:assert/strict';
import { HostTerminalAdapter, type ExecutionPathBinder, type ProcessSpawner, type TerminalExecutionEffectResolver } from '../src/computer/terminalAdapter.js';
import { ProcessIdentityStore } from '../src/computer/processAdapter.js';

function dependencies() {
  const calls = { getter: 0, resolver: 0, path: 0, spawn: 0 };
  const resolver: TerminalExecutionEffectResolver = { requiredEffect() { calls.resolver += 1; return 'security-sensitive'; } };
  const binder: ExecutionPathBinder = { async bind() { calls.path += 1; return undefined; } };
  const spawner: ProcessSpawner = { spawn() { calls.spawn += 1; throw new Error('must not spawn'); } };
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), spawner, binder, resolver);
  return { calls, adapter };
}

function validPayload() {
  return { mode: 'argv', executable: '/fixture/bin', argv: ['--fixture'], cwd: '/fixture', classification: 'local-compute' };
}

for (const field of ['effect', 'capability', 'payload'] as const) {
  test(`accessor-backed ${field} is rejected without getter or authority calls`, async () => {
    const { calls, adapter } = dependencies();
    const request: Record<string, unknown> = {
      adapterId: 'terminal:test', actionId: `accessor-${field}`, capability: 'terminal.execute.argv',
      effect: 'security-sensitive', idempotency: 'non-idempotent', payload: validPayload(),
    };
    Object.defineProperty(request, field, {
      enumerable: true,
      get() { calls.getter += 1; return field === 'payload' ? validPayload() : field === 'effect' ? 'security-sensitive' : 'terminal.execute.argv'; },
    });
    const result = await adapter.act(request as any);
    assert.equal(result.status, 'rejected');
    assert.equal(result.dispatch, 'not-dispatched');
    assert.equal(calls.getter, 0);
    assert.equal(calls.resolver, 0);
    assert.equal(calls.path, 0);
    assert.equal(calls.spawn, 0);
  });
}

test('accessor-backed nested argv is rejected without getter execution', async () => {
  const { calls, adapter } = dependencies();
  const payload: Record<string, unknown> = { mode: 'argv', executable: '/fixture/bin', cwd: '/fixture', classification: 'local-compute' };
  Object.defineProperty(payload, 'argv', { enumerable: true, get() { calls.getter += 1; return ['--fixture']; } });
  const result = await adapter.act({ adapterId: 'terminal:test', actionId: 'nested-accessor', capability: 'terminal.execute.argv', effect: 'security-sensitive', idempotency: 'non-idempotent', payload } as any);
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(calls.getter, 0);
  assert.equal(calls.resolver, 0);
  assert.equal(calls.path, 0);
  assert.equal(calls.spawn, 0);
});

test('sparse argv is rejected before resolver/path/spawn', async () => {
  const { calls, adapter } = dependencies();
  const argv = new Array<string>(2);
  argv[1] = '--fixture';
  const result = await adapter.act({ adapterId: 'terminal:test', actionId: 'sparse', capability: 'terminal.execute.argv', effect: 'security-sensitive', idempotency: 'non-idempotent', payload: { ...validPayload(), argv } } as any);
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(calls.resolver, 0);
  assert.equal(calls.path, 0);
  assert.equal(calls.spawn, 0);
});
