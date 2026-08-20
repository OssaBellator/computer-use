import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteDesktopRemoteSessionBackend } from '../src/computer/remoteDesktopRemoteSessionBackend.js';
import type {
  RemoteDesktopProviderFrame,
  RemoteDesktopProviderSession,
  RemoteDesktopTransportProvider,
} from '../src/computer/remoteDesktopTransportProvider.js';
import { RemoteSessionAdapter, type RemoteDispatchOutcome, type RemoteEndpointIdentity } from '../src/computer/remoteSessionAdapter.js';

class SymmetryProvider implements RemoteDesktopTransportProvider {
  disconnectCalls = 0;
  constructor(readonly protocol: 'rdp' | 'vnc') {}
  async connect(): Promise<RemoteDesktopProviderSession> {
    return { providerSessionId: `${this.protocol}-provider`, remoteHostId: `${this.protocol}-host` };
  }
  async cleanupFailedConnect(): Promise<void> {}
  async disconnect(): Promise<void> { this.disconnectCalls++; }
  async captureDisplay(): Promise<RemoteDesktopProviderFrame> {
    return { width: 1, height: 1, format: 'rgba', byteLength: 4, copyBytes: () => new Uint8Array([1, 2, 3, 4]) };
  }
  async sendPointer(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
  async sendKey(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
  async sendText(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
}

for (const protocol of ['rdp', 'vnc'] as const) {
  test(`${protocol} backend exposes identical conservative authority/capture behavior`, async () => {
    const endpoint: RemoteEndpointIdentity = Object.freeze({ endpointId: `${protocol}-endpoint`, protocol, host: 'fixture.invalid', port: protocol === 'rdp' ? 3389 : 5900 });
    const provider = new SymmetryProvider(protocol);
    const backend = new RemoteDesktopRemoteSessionBackend(provider);
    const adapter = new RemoteSessionAdapter(protocol, endpoint, backend);
    const authority = await adapter.connect();
    assert.equal(authority.remoteHostId, `${protocol}-host`);
    assert.equal(authority.generation, 1);
    const observation = await adapter.observe({ adapterId: protocol, channel: 'visual', limits: { maxItems: 1, maxTextBytes: 4 } });
    assert.equal(observation.channel, 'visual');
    assert.equal(observation.complete, true);
    const frame = observation.data as { width: number; height: number; format: string; bytes?: Uint8Array };
    assert.equal(frame.width, 1);
    assert.equal(frame.height, 1);
    assert.equal(frame.format, 'synthetic-rgba');
    assert.deepEqual(Array.from(frame.bytes ?? []), [1, 2, 3, 4]);
    await adapter.disconnect();
    assert.equal(provider.disconnectCalls, 1);
  });
}
