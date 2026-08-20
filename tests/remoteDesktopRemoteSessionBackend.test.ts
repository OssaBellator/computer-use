import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteDesktopRemoteSessionBackend } from '../src/computer/remoteDesktopRemoteSessionBackend.js';
import type {
  RemoteDesktopProviderFrame,
  RemoteDesktopProviderSession,
  RemoteDesktopTransportProvider,
} from '../src/computer/remoteDesktopTransportProvider.js';
import {
  RemoteSessionAdapter,
  type RemoteDispatchOutcome,
  type RemoteDisplayCaptureLimits,
  type RemoteEndpointIdentity,
  type RemoteSecretHandle,
} from '../src/computer/remoteSessionAdapter.js';

const endpoint: RemoteEndpointIdentity = Object.freeze({ endpointId: 'vnc-fixture', protocol: 'vnc', host: 'fixture.invalid', port: 5900 });

class FakeDesktopProvider implements RemoteDesktopTransportProvider {
  readonly protocol = 'vnc' as const;
  connectCalls = 0;
  disconnectCalls = 0;
  cleanupCalls = 0;
  captureCalls = 0;
  copyCalls = 0;
  inputCalls: string[] = [];
  seenCredential?: RemoteSecretHandle;
  seenLimits?: RemoteDisplayCaptureLimits;
  nextSession: unknown = { providerSessionId: 'native-1', remoteHostId: 'host-1' };
  disconnectError?: Error;
  cleanupError?: Error;
  outcome: unknown = { dispatch: 'dispatched-once', status: 'completed' };
  frame: RemoteDesktopProviderFrame = {
    width: 2,
    height: 2,
    format: 'rgba',
    byteLength: 16,
    copyBytes: () => { this.copyCalls++; return new Uint8Array(16); },
  };

  async connect(_endpoint: RemoteEndpointIdentity, credential?: RemoteSecretHandle): Promise<RemoteDesktopProviderSession> {
    this.connectCalls++;
    this.seenCredential = credential;
    return this.nextSession as RemoteDesktopProviderSession;
  }
  async cleanupFailedConnect(_candidate: unknown): Promise<void> {
    this.cleanupCalls++;
    if (this.cleanupError) throw this.cleanupError;
  }
  async disconnect(_session: RemoteDesktopProviderSession): Promise<void> {
    this.disconnectCalls++;
    if (this.disconnectError) throw this.disconnectError;
  }
  async captureDisplay(_session: RemoteDesktopProviderSession, limits: RemoteDisplayCaptureLimits): Promise<RemoteDesktopProviderFrame> {
    this.captureCalls++;
    this.seenLimits = limits;
    return this.frame;
  }
  async sendPointer(): Promise<RemoteDispatchOutcome<void>> { this.inputCalls.push('pointer'); return this.outcome as RemoteDispatchOutcome<void>; }
  async sendKey(): Promise<RemoteDispatchOutcome<void>> { this.inputCalls.push('key'); return this.outcome as RemoteDispatchOutcome<void>; }
  async sendText(): Promise<RemoteDispatchOutcome<void>> { this.inputCalls.push('text'); return this.outcome as RemoteDispatchOutcome<void>; }
}

function visualAction(adapter: RemoteSessionAdapter, authority: unknown, input: unknown) {
  return adapter.act({
    adapterId: adapter.adapterId,
    actionId: 'visual-action',
    capability: 'remote.visual.input',
    effect: 'remote-execution',
    idempotency: 'non-idempotent',
    payload: { authority, input },
  });
}

test('malformed native session is explicitly cleaned before authority can be created', async () => {
  const provider = new FakeDesktopProvider();
  provider.nextSession = { providerSessionId: '', remoteHostId: 'host-1' };
  const adapter = new RemoteSessionAdapter('vnc', endpoint, new RemoteDesktopRemoteSessionBackend(provider));
  await assert.rejects(() => adapter.connect(), /invalid remote desktop provider session/);
  assert.equal(provider.cleanupCalls, 1);
  assert.equal(adapter.state().authority, undefined);
  assert.equal(adapter.state().lifecycle, 'failed');
});

test('cleanup failure on malformed native session fails closed', async () => {
  const provider = new FakeDesktopProvider();
  provider.nextSession = { providerSessionId: '', remoteHostId: 'host-1' };
  provider.cleanupError = new Error('native cleanup ambiguous');
  const adapter = new RemoteSessionAdapter('vnc', endpoint, new RemoteDesktopRemoteSessionBackend(provider));
  await assert.rejects(() => adapter.connect(), /cleanup failed/);
  assert.equal(adapter.state().lifecycle, 'failed');
  assert.equal(adapter.state().authority, undefined);
});

test('declared frame bounds are validated before defensive byte copy', async () => {
  const provider = new FakeDesktopProvider();
  provider.frame = {
    width: 4096,
    height: 4096,
    format: 'rgba',
    byteLength: 67_108_864,
    copyBytes: () => { provider.copyCalls++; return new Uint8Array(0); },
  };
  const adapter = new RemoteSessionAdapter('vnc', endpoint, new RemoteDesktopRemoteSessionBackend(provider));
  await adapter.connect();
  await assert.rejects(
    () => adapter.observe({ adapterId: 'vnc', channel: 'visual', limits: { maxItems: 4, maxTextBytes: 16 } }),
    /acquisition (pixel|byte) bound/,
  );
  assert.equal(provider.copyCalls, 0);
  assert.equal(provider.captureCalls, 1);
  assert.deepEqual(provider.seenLimits, { maxPixels: 4, maxBytes: 16 });
  assert.equal(Object.isFrozen(provider.seenLimits), true);
});

test('valid frame is copied only after declared dimensions and byte length pass', async () => {
  const provider = new FakeDesktopProvider();
  const adapter = new RemoteSessionAdapter('vnc', endpoint, new RemoteDesktopRemoteSessionBackend(provider));
  await adapter.connect();
  const result = await adapter.observe({ adapterId: 'vnc', channel: 'visual', limits: { maxItems: 4, maxTextBytes: 16 } });
  assert.equal(provider.copyCalls, 1);
  assert.equal(result.complete, true);
  assert.deepEqual(result.data, { width: 2, height: 2, format: 'synthetic-rgba', bytes: new Uint8Array(16), frameId: undefined });
});

test('pointer key and text have explicit single provider dispatch paths', async () => {
  const provider = new FakeDesktopProvider();
  const adapter = new RemoteSessionAdapter('vnc', endpoint, new RemoteDesktopRemoteSessionBackend(provider));
  const authority = await adapter.connect();
  for (const input of [
    { kind: 'pointer', x: 1, y: 2 },
    { kind: 'key', key: 'Enter' },
    { kind: 'text', text: 'hello' },
  ]) {
    const result = await visualAction(adapter, authority, input);
    assert.equal(result.dispatch, 'dispatched-once');
    assert.equal(result.status, 'unknown');
    assert.equal(result.verification, 'unverified');
    assert.ok(result.evidence?.includes('remote-visual-effect-unverified'));
  }
  assert.deepEqual(provider.inputCalls, ['pointer', 'key', 'text']);
});

test('malformed visual provider outcome becomes sticky uncertainty without redispatch', async () => {
  const provider = new FakeDesktopProvider();
  provider.outcome = { dispatch: 'dispatched-once', status: 'completed', value: { unexpected: true } };
  const adapter = new RemoteSessionAdapter('vnc', endpoint, new RemoteDesktopRemoteSessionBackend(provider));
  const authority = await adapter.connect();
  const result = await visualAction(adapter, authority, { kind: 'key', key: 'A' });
  assert.equal(result.dispatch, 'unknown');
  assert.equal(result.status, 'unknown');
  assert.deepEqual(provider.inputCalls, ['key']);
});

test('reconnect disconnect ambiguity discards both old and replacement authority', async () => {
  const provider = new FakeDesktopProvider();
  const adapter = new RemoteSessionAdapter('vnc', endpoint, new RemoteDesktopRemoteSessionBackend(provider));
  const first = await adapter.connect();
  provider.nextSession = { providerSessionId: 'native-2', remoteHostId: 'host-1' };
  provider.disconnectError = new Error('native disconnect ambiguous');
  await assert.rejects(() => adapter.reconnect(), /native disconnect ambiguous/);
  assert.equal(adapter.state().lifecycle, 'failed');
  assert.equal(adapter.state().authority, undefined);
  assert.equal(provider.connectCalls, 2);
  assert.equal(provider.disconnectCalls, 2);
  assert.equal(first.generation, 1);
});
