import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  RemoteDesktopProviderFrame,
  RemoteDesktopProviderSession,
  RemoteDesktopTransportProvider,
} from '../src/computer/remoteDesktopTransportProvider.js';
import type {
  RemoteDispatchOutcome,
  RemoteDisplayCaptureLimits,
  RemoteEndpointIdentity,
  RemoteSecretHandle,
} from '../src/computer/remoteSessionAdapter.js';

class ContractProvider implements RemoteDesktopTransportProvider {
  constructor(readonly protocol: 'rdp' | 'vnc') {}
  async connect(_endpoint: RemoteEndpointIdentity, _credential?: RemoteSecretHandle): Promise<RemoteDesktopProviderSession> {
    return { providerSessionId: `${this.protocol}-provider`, remoteHostId: `${this.protocol}-host` };
  }
  async cleanupFailedConnect(_candidate: unknown): Promise<void> {}
  async disconnect(_session: RemoteDesktopProviderSession): Promise<void> {}
  async captureDisplay(_session: RemoteDesktopProviderSession, _limits: RemoteDisplayCaptureLimits): Promise<RemoteDesktopProviderFrame> {
    return { width: 1, height: 1, format: 'rgba', byteLength: 4, copyBytes: () => new Uint8Array(4) };
  }
  async sendPointer(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
  async sendKey(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
  async sendText(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
}

test('provider seam is symmetric for RDP and VNC core capture/input operations', () => {
  for (const protocol of ['rdp', 'vnc'] as const) {
    const provider = new ContractProvider(protocol);
    assert.equal(provider.protocol, protocol);
    assert.equal(typeof provider.connect, 'function');
    assert.equal(typeof provider.cleanupFailedConnect, 'function');
    assert.equal(typeof provider.disconnect, 'function');
    assert.equal(typeof provider.captureDisplay, 'function');
    assert.equal(typeof provider.sendPointer, 'function');
    assert.equal(typeof provider.sendKey, 'function');
    assert.equal(typeof provider.sendText, 'function');
  }
});

test('provider seam does not grow clipboard or file-transfer authority implicitly', () => {
  const provider = new ContractProvider('rdp') as unknown as Record<string, unknown>;
  assert.equal('clipboard' in provider, false);
  assert.equal('readClipboard' in provider, false);
  assert.equal('writeClipboard' in provider, false);
  assert.equal('uploadFile' in provider, false);
  assert.equal('downloadFile' in provider, false);
});
