import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteDesktopRemoteSessionBackend } from '../src/computer/remoteDesktopRemoteSessionBackend.js';
import type {
  RemoteDesktopProviderFrame,
  RemoteDesktopProviderSession,
  RemoteDesktopTransportProvider,
} from '../src/computer/remoteDesktopTransportProvider.js';
import { RemoteSessionAdapter, type RemoteDispatchOutcome, type RemoteEndpointIdentity } from '../src/computer/remoteSessionAdapter.js';

class PngProvider implements RemoteDesktopTransportProvider {
  readonly protocol = 'vnc' as const;
  frame!: RemoteDesktopProviderFrame;
  async connect(): Promise<RemoteDesktopProviderSession> { return { providerSessionId: 'png-provider', remoteHostId: 'png-host' }; }
  async cleanupFailedConnect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async captureDisplay(): Promise<RemoteDesktopProviderFrame> { return this.frame; }
  async sendPointer(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
  async sendKey(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
  async sendText(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
}

const endpoint: RemoteEndpointIdentity = Object.freeze({ endpointId: 'png-boundary', protocol: 'vnc', host: 'fixture.invalid', port: 5900 });

async function observe(provider: PngProvider, maxBytes: number) {
  const adapter = new RemoteSessionAdapter('vnc', endpoint, new RemoteDesktopRemoteSessionBackend(provider));
  await adapter.connect();
  return adapter.observe({ adapterId: 'vnc', channel: 'visual', limits: { maxItems: 1, maxTextBytes: maxBytes } });
}

test('PNG declared byte overrun is rejected before copyBytes materialization', async () => {
  const provider = new PngProvider();
  let copyCalls = 0;
  provider.frame = {
    width: 1,
    height: 1,
    format: 'png',
    byteLength: 17,
    copyBytes() { copyCalls++; return new Uint8Array(17); },
  };
  await assert.rejects(() => observe(provider, 16), /acquisition byte bound/);
  assert.equal(copyCalls, 0);
});

test('PNG materialized bytes must exactly match the bounded declared byte length', async () => {
  const provider = new PngProvider();
  let copyCalls = 0;
  provider.frame = {
    width: 1,
    height: 1,
    format: 'png',
    byteLength: 4,
    copyBytes() { copyCalls++; return new Uint8Array(5); },
  };
  await assert.rejects(() => observe(provider, 16), /invalid remote desktop provider frame/);
  assert.equal(copyCalls, 1);
});

test('bounded PNG bytes are defensively copied into the neutral frame schema', async () => {
  const provider = new PngProvider();
  const native = new Uint8Array([1, 2, 3, 4]);
  provider.frame = { width: 1, height: 1, format: 'png', byteLength: 4, copyBytes: () => native };
  const observation = await observe(provider, 16);
  const frame = observation.data as { format: string; bytes?: Uint8Array };
  assert.equal(frame.format, 'synthetic-png');
  assert.deepEqual(Array.from(frame.bytes ?? []), [1, 2, 3, 4]);
  native[0] = 99;
  assert.equal(frame.bytes?.[0], 1);
});
