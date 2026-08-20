import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RemoteDispatchError,
  RemoteSessionAdapter,
  type RemoteCommandResult,
  type RemoteDispatchOutcome,
  type RemoteDisplayFrame,
  type RemoteEndpointIdentity,
  type RemoteSessionBackend,
  type RemoteSessionConnection,
  type RemoteVisualInput,
} from '../src/computer/remoteSessionAdapter.js';
import { computerActionMayAutoRetry } from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';

class FakeBackend implements RemoteSessionBackend {
  readonly protocol;
  nextHost = 'host-a';
  nextSession = 'session-1';
  connectCount = 0;
  disconnectCount = 0;
  disconnectedSessions: string[] = [];
  metadata = Array.from({ length: 80 }, (_, i) => ({ key: `k${i}`, value: 'value' }));
  commandError: unknown;
  commandCalls = 0;
  commandOutcome: RemoteDispatchOutcome<RemoteCommandResult> = { dispatch: 'dispatched-once', status: 'completed', value: { exitCode: 0, stdout: 'ok' } };
  inputOutcome: RemoteDispatchOutcome<void> = { dispatch: 'dispatched-once', status: 'completed' };
  displayFrame: RemoteDisplayFrame = { width: 2, height: 2, format: 'synthetic-rgba', bytes: new Uint8Array(16) };
  seenCredential: unknown;
  invalidNextIdentity = false;

  constructor(protocol: 'ssh' | 'rdp' | 'vnc') { this.protocol = protocol; }

  async connect(_endpoint: RemoteEndpointIdentity, credential?: unknown): Promise<RemoteSessionConnection> {
    this.connectCount++;
    this.seenCredential = credential;
    return {
      sessionId: this.invalidNextIdentity ? '' : this.nextSession,
      remoteHostId: this.nextHost,
      capabilities: ['remote.session.observe', 'remote.metadata.observe', ...(this.protocol === 'ssh' ? ['remote.ssh.execute'] : ['remote.display.observe', 'remote.visual.input']), ...Array.from({ length: 100 }, (_, i) => `invalid.${i}`)],
    };
  }
  async disconnect(connection: RemoteSessionConnection) { this.disconnectCount++; this.disconnectedSessions.push(connection.sessionId); }
  async observeMetadata() { return this.metadata; }
  async captureDisplay() { return this.displayFrame; }
  async sendVisualInput(_c: RemoteSessionConnection, _input: RemoteVisualInput) { return this.inputOutcome; }
  async executeRemoteCommand() { this.commandCalls++; if (this.commandError) throw this.commandError; return this.commandOutcome; }
}

const endpoint = (protocol: 'ssh' | 'rdp' | 'vnc'): RemoteEndpointIdentity => ({ endpointId: `endpoint-${protocol}`, protocol, host: 'explicit.example.test', port: protocol === 'ssh' ? 22 : 3389 });
const action = (adapter: RemoteSessionAdapter, authority: ReturnType<RemoteSessionAdapter['state']>['authority'], capability: string, payload: Record<string, unknown>) => adapter.act({ adapterId: adapter.adapterId, actionId: 'a1', capability, effect: 'remote-execution', idempotency: 'non-idempotent', payload: { authority, ...payload } });

test('connect/disconnect and bounded session observation', async () => {
  const backend = new FakeBackend('ssh'); const adapter = new RemoteSessionAdapter('remote-1', endpoint('ssh'), backend);
  const credential = { kind: 'secret-handle' as const, handleId: 'vault:ssh-test' };
  const auth = await adapter.connect(credential);
  assert.equal(adapter.state().lifecycle, 'connected'); assert.equal(auth.generation, 1); assert.equal(backend.seenCredential, credential);
  const obs = await adapter.observe({ adapterId: 'remote-1', channel: 'terminal', limits: { maxItems: 3, maxTextBytes: 100 } });
  assert.equal((obs.data as { metadata: unknown[] }).metadata.length, 3); assert.equal(obs.truncated, true);
  assert.equal(JSON.stringify(adapter.state()).includes('vault:ssh-test'), false);
  await adapter.disconnect(); assert.equal(adapter.state().lifecycle, 'disconnected'); assert.equal(backend.disconnectCount, 1);
});

test('reconnect changes generation and stale authority is rejected', async () => {
  const backend = new FakeBackend('ssh'); const adapter = new RemoteSessionAdapter('remote-1', endpoint('ssh'), backend);
  const first = await adapter.connect(); backend.nextSession = 'session-2'; const second = await adapter.reconnect();
  assert.equal(second.generation, 2); assert.notEqual(second.sessionId, first.sessionId);
  const stale = await action(adapter, first, 'remote.ssh.execute', { invocation: { command: 'printf', args: ['ok'] } });
  assert.equal(stale.dispatch, 'not-dispatched'); assert.deepEqual(stale.evidence, ['remote-session-replaced']);
});

test('failed reconnect closes invalid candidate and preserves tracked prior authority', async () => {
  const backend = new FakeBackend('ssh'); const adapter = new RemoteSessionAdapter('remote-1', endpoint('ssh'), backend);
  const first = await adapter.connect();
  backend.invalidNextIdentity = true;
  await assert.rejects(() => adapter.reconnect(), /invalid remote identity/);
  const state = adapter.state();
  assert.equal(state.lifecycle, 'connected'); assert.deepEqual(state.authority, first);
  assert.equal(backend.disconnectedSessions.includes(''), true);
  const stillUsable = await action(adapter, first, 'remote.ssh.execute', { invocation: { command: 'true' } });
  assert.equal(stillUsable.dispatch, 'dispatched-once');
});

test('remote host mismatch is rejected before dispatch', async () => {
  const backend = new FakeBackend('ssh'); const adapter = new RemoteSessionAdapter('remote-1', endpoint('ssh'), backend); const auth = await adapter.connect();
  const result = await action(adapter, { ...auth, remoteHostId: 'host-b' }, 'remote.ssh.execute', { invocation: { command: 'true' } });
  assert.equal(result.dispatch, 'not-dispatched'); assert.deepEqual(result.evidence, ['remote-host-mismatch']);
});

test('SSH requires remote-execution and preserves definite versus ambiguous dispatch', async () => {
  const backend = new FakeBackend('ssh'); const adapter = new RemoteSessionAdapter('remote-1', endpoint('ssh'), backend); const auth = await adapter.connect();
  const wrong = await adapter.act({ adapterId: 'remote-1', actionId: 'x', capability: 'remote.ssh.execute', effect: 'process-trigger', idempotency: 'non-idempotent', payload: { authority: auth, invocation: { command: 'true' } } });
  assert.deepEqual(wrong.evidence, ['remote-effect-required']);
  backend.commandError = new RemoteDispatchError('not-dispatched', 'ssh-pre-dispatch-connect-failed');
  const pre = await action(adapter, auth, 'remote.ssh.execute', { invocation: { command: 'true' } }); assert.equal(pre.dispatch, 'not-dispatched');
  backend.commandError = new RemoteDispatchError('unknown', 'ssh-transport-failed-after-send');
  const ambiguous = await action(adapter, auth, 'remote.ssh.execute', { invocation: { command: 'do-once' } }); assert.equal(ambiguous.status, 'unknown'); assert.equal(ambiguous.dispatch, 'unknown');
  assert.equal(computerActionMayAutoRetry({ effect: 'remote-execution', idempotency: 'non-idempotent' }, ambiguous), false);
});

test('SSH argv payload is strictly bounded and rejected before dispatch', async () => {
  const backend = new FakeBackend('ssh'); const adapter = new RemoteSessionAdapter('remote-1', endpoint('ssh'), backend); const auth = await adapter.connect();
  const malformed = await action(adapter, auth, 'remote.ssh.execute', { invocation: { command: 'printf', args: ['ok', 42] } });
  assert.equal(malformed.dispatch, 'not-dispatched'); assert.deepEqual(malformed.evidence, ['remote-command-invalid']);
  const oversized = await action(adapter, auth, 'remote.ssh.execute', { invocation: { command: 'printf', args: ['x'.repeat(5000)] } });
  assert.equal(oversized.dispatch, 'not-dispatched'); assert.equal(backend.commandCalls, 0);
});

test('RDP/VNC expose bounded visual observation/input seams without claiming app-level verification', async () => {
  for (const protocol of ['rdp', 'vnc'] as const) {
    const backend = new FakeBackend(protocol); const adapter = new RemoteSessionAdapter(`remote-${protocol}`, endpoint(protocol), backend); const auth = await adapter.connect();
    const visual = await adapter.observe({ adapterId: adapter.adapterId, channel: 'visual' }); assert.equal((visual.data as { width: number }).width, 2);
    const result = await action(adapter, auth, 'remote.visual.input', { input: { kind: 'pointer', x: 1, y: 1 } });
    assert.equal(result.status, 'unknown'); assert.equal(result.dispatch, 'dispatched-once'); assert.equal(result.verification, 'unverified'); assert.ok(result.evidence?.includes('remote-visual-effect-unverified'));
  }
});

test('registry preserves known visual dispatch instead of rewriting adapter response', async () => {
  const backend = new FakeBackend('rdp'); const adapter = new RemoteSessionAdapter('remote-rdp', endpoint('rdp'), backend); const auth = await adapter.connect();
  const registry = new ComputerEnvironmentRegistry(); registry.register(adapter);
  const result = await registry.act({ adapterId: adapter.adapterId, actionId: 'input-1', capability: 'remote.visual.input', effect: 'remote-execution', idempotency: 'non-idempotent', payload: { authority: auth, input: { kind: 'key', key: 'A' } } });
  assert.equal(result.status, 'unknown'); assert.equal(result.dispatch, 'dispatched-once'); assert.ok(result.evidence?.includes('remote-visual-effect-unverified'));
});

test('visual observations omit oversized bytes and mark truncation', async () => {
  const backend = new FakeBackend('rdp'); const adapter = new RemoteSessionAdapter('remote-rdp', endpoint('rdp'), backend); await adapter.connect();
  backend.displayFrame = { width: 100, height: 100, format: 'synthetic-rgba', bytes: new Uint8Array(40_000) };
  const visual = await adapter.observe({ adapterId: adapter.adapterId, channel: 'visual', limits: { maxItems: 20_000, maxTextBytes: 100 } });
  const frame = visual.data as RemoteDisplayFrame;
  assert.equal(visual.truncated, true); assert.equal(visual.complete, false); assert.equal(frame.bytes, undefined);
  backend.displayFrame = { width: 20_000, height: 2, format: 'synthetic-rgba', bytes: new Uint8Array(1) };
  await assert.rejects(() => adapter.observe({ adapterId: adapter.adapterId, channel: 'visual' }), /hard pixel bound|invalid remote display frame/);
});

test('session replacement on same host invalidates prior generation authority', async () => {
  const backend = new FakeBackend('rdp'); const adapter = new RemoteSessionAdapter('remote-rdp', endpoint('rdp'), backend); const first = await adapter.connect();
  backend.nextSession = 'replacement'; const second = await adapter.reconnect(); assert.equal(second.remoteHostId, first.remoteHostId); assert.equal(second.generation, first.generation + 1);
  const result = await action(adapter, first, 'remote.visual.input', { input: { kind: 'key', key: 'A' } }); assert.equal(result.dispatch, 'not-dispatched');
});

test('same-session reconnect still invalidates stale generation authority', async () => {
  const backend = new FakeBackend('ssh'); const adapter = new RemoteSessionAdapter('remote-1', endpoint('ssh'), backend); const first = await adapter.connect();
  const second = await adapter.reconnect(); assert.equal(second.sessionId, first.sessionId); assert.equal(second.generation, first.generation + 1);
  const result = await action(adapter, first, 'remote.ssh.execute', { invocation: { command: 'true' } }); assert.deepEqual(result.evidence, ['remote-session-stale-generation']);
});
