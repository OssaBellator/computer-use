import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RemoteDesktopRemoteSessionBackend,
} from '../src/computer/remoteDesktopRemoteSessionBackend.js';
import type {
  RemoteDesktopProviderFrame,
  RemoteDesktopProviderSession,
  RemoteDesktopTransportProvider,
} from '../src/computer/remoteDesktopTransportProvider.js';
import {
  RemoteSessionAdapter,
  type RemoteDispatchOutcome,
  type RemoteEndpointIdentity,
  type RemoteVisualInput,
} from '../src/computer/remoteSessionAdapter.js';

const endpoint: RemoteEndpointIdentity = Object.freeze({ endpointId: 'vnc-adversarial', protocol: 'vnc', host: 'fixture.invalid', port: 5900 });

class AdversarialDesktopProvider implements RemoteDesktopTransportProvider {
  readonly protocol = 'vnc' as const;
  connectCalls = 0;
  cleanupCalls = 0;
  disconnectCalls = 0;
  captureCalls = 0;
  inputCalls = 0;
  nextSession: unknown = { providerSessionId: 'provider-1', remoteHostId: 'host-1' };
  frame: unknown = { width: 1, height: 1, format: 'rgba', byteLength: 4, copyBytes: () => new Uint8Array(4) };
  outcome: unknown = { dispatch: 'dispatched-once', status: 'completed' };

  async connect(): Promise<RemoteDesktopProviderSession> {
    this.connectCalls++;
    return this.nextSession as RemoteDesktopProviderSession;
  }
  async cleanupFailedConnect(_candidate: unknown): Promise<void> { this.cleanupCalls++; }
  async disconnect(_session: RemoteDesktopProviderSession): Promise<void> { this.disconnectCalls++; }
  async captureDisplay(): Promise<RemoteDesktopProviderFrame> {
    this.captureCalls++;
    return this.frame as RemoteDesktopProviderFrame;
  }
  async sendPointer(): Promise<RemoteDispatchOutcome<void>> { this.inputCalls++; return this.outcome as RemoteDispatchOutcome<void>; }
  async sendKey(): Promise<RemoteDispatchOutcome<void>> { this.inputCalls++; return this.outcome as RemoteDispatchOutcome<void>; }
  async sendText(): Promise<RemoteDispatchOutcome<void>> { this.inputCalls++; return this.outcome as RemoteDispatchOutcome<void>; }
}

function visualAction(adapter: RemoteSessionAdapter, authority: unknown, input: RemoteVisualInput) {
  return adapter.act({
    adapterId: adapter.adapterId,
    actionId: 'desktop-adversarial-action',
    capability: 'remote.visual.input',
    effect: 'remote-execution',
    idempotency: 'non-idempotent',
    payload: { authority, input },
  });
}

test('provider session accessors are never invoked and trigger explicit failed-connect cleanup', async () => {
  const provider = new AdversarialDesktopProvider();
  let accessorCalls = 0;
  const candidate = { remoteHostId: 'host-1' } as Record<string, unknown>;
  Object.defineProperty(candidate, 'providerSessionId', {
    enumerable: true,
    get() { accessorCalls++; return 'provider-hidden'; },
  });
  provider.nextSession = candidate;
  const adapter = new RemoteSessionAdapter('vnc', endpoint, new RemoteDesktopRemoteSessionBackend(provider));
  await assert.rejects(() => adapter.connect(), /invalid remote desktop provider session/);
  assert.equal(accessorCalls, 0);
  assert.equal(provider.cleanupCalls, 1);
  assert.equal(adapter.state().authority, undefined);
});

test('frame accessors are rejected before byte materialization', async () => {
  const provider = new AdversarialDesktopProvider();
  let widthAccessorCalls = 0;
  let copyCalls = 0;
  const frame = {
    height: 1,
    format: 'rgba',
    byteLength: 4,
    copyBytes() { copyCalls++; return new Uint8Array(4); },
  } as Record<string, unknown>;
  Object.defineProperty(frame, 'width', {
    enumerable: true,
    get() { widthAccessorCalls++; return 1; },
  });
  provider.frame = frame;
  const adapter = new RemoteSessionAdapter('vnc', endpoint, new RemoteDesktopRemoteSessionBackend(provider));
  await adapter.connect();
  await assert.rejects(() => adapter.observe({ adapterId: 'vnc', channel: 'visual', limits: { maxItems: 1, maxTextBytes: 16 } }), /invalid remote desktop provider frame/);
  assert.equal(widthAccessorCalls, 0);
  assert.equal(copyCalls, 0);
});

test('invalid rgba declared length is rejected before copyBytes', async () => {
  const provider = new AdversarialDesktopProvider();
  let copyCalls = 0;
  provider.frame = {
    width: 2,
    height: 2,
    format: 'rgba',
    byteLength: 15,
    copyBytes() { copyCalls++; return new Uint8Array(15); },
  };
  const adapter = new RemoteSessionAdapter('vnc', endpoint, new RemoteDesktopRemoteSessionBackend(provider));
  await adapter.connect();
  await assert.rejects(() => adapter.observe({ adapterId: 'vnc', channel: 'visual', limits: { maxItems: 1, maxTextBytes: 64 } }), /invalid remote desktop provider frame/);
  assert.equal(copyCalls, 0);
});

test('post-dispatch outcome accessor becomes uncertainty without redispatch', async () => {
  const provider = new AdversarialDesktopProvider();
  let evidenceAccessorCalls = 0;
  const outcome = { dispatch: 'dispatched-once', status: 'completed' } as Record<string, unknown>;
  Object.defineProperty(outcome, 'evidence', {
    enumerable: true,
    get() { evidenceAccessorCalls++; return 'hidden'; },
  });
  provider.outcome = outcome;
  const adapter = new RemoteSessionAdapter('vnc', endpoint, new RemoteDesktopRemoteSessionBackend(provider));
  const authority = await adapter.connect();
  const result = await visualAction(adapter, authority, { kind: 'key', key: 'Enter' });
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(result.status, 'unknown');
  assert.equal(result.verification, 'unverified');
  assert.equal(evidenceAccessorCalls, 0);
  assert.equal(provider.inputCalls, 1);
});

test('copied frame bytes are detached from provider-owned mutable storage', async () => {
  const provider = new AdversarialDesktopProvider();
  const providerBytes = new Uint8Array([1, 2, 3, 4]);
  provider.frame = { width: 1, height: 1, format: 'rgba', byteLength: 4, copyBytes: () => providerBytes };
  const adapter = new RemoteSessionAdapter('vnc', endpoint, new RemoteDesktopRemoteSessionBackend(provider));
  await adapter.connect();
  const observation = await adapter.observe({ adapterId: 'vnc', channel: 'visual', limits: { maxItems: 1, maxTextBytes: 16 } });
  assert.equal(observation.channel, 'visual');
  const frame = observation.data as { bytes?: Uint8Array };
  assert.ok(frame.bytes instanceof Uint8Array);
  providerBytes[0] = 99;
  assert.equal(frame.bytes[0], 1);
});
