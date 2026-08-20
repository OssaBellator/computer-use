import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchRemoteDesktopInput,
  type RemoteDesktopProviderFrame,
  type RemoteDesktopProviderSession,
  type RemoteDesktopTransportProvider,
} from '../src/computer/remoteDesktopTransportProvider.js';
import type { RemoteDispatchOutcome, RemoteVisualInput } from '../src/computer/remoteSessionAdapter.js';

class InputProvider implements RemoteDesktopTransportProvider {
  readonly protocol = 'vnc' as const;
  pointerCalls = 0;
  keyCalls = 0;
  textCalls = 0;
  seen: unknown;
  async connect(): Promise<RemoteDesktopProviderSession> { return { providerSessionId: 'input-provider', remoteHostId: 'input-host' }; }
  async cleanupFailedConnect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async captureDisplay(): Promise<RemoteDesktopProviderFrame> { return { width: 1, height: 1, format: 'rgba', byteLength: 4, copyBytes: () => new Uint8Array(4) }; }
  async sendPointer(_session: RemoteDesktopProviderSession, input: Readonly<{ kind: 'pointer'; x: number; y: number }>): Promise<RemoteDispatchOutcome<void>> {
    this.pointerCalls++; this.seen = input; return { dispatch: 'dispatched-once', status: 'completed' };
  }
  async sendKey(_session: RemoteDesktopProviderSession, input: Readonly<{ kind: 'key'; key: string }>): Promise<RemoteDispatchOutcome<void>> {
    this.keyCalls++; this.seen = input; return { dispatch: 'dispatched-once', status: 'completed' };
  }
  async sendText(_session: RemoteDesktopProviderSession, input: Readonly<{ kind: 'text'; text: string }>): Promise<RemoteDispatchOutcome<void>> {
    this.textCalls++; this.seen = input; return { dispatch: 'dispatched-once', status: 'completed' };
  }
}

const session = Object.freeze({ providerSessionId: 'input-provider', remoteHostId: 'input-host' });

const invalidInputs: readonly RemoteVisualInput[] = [
  { kind: 'pointer', x: Number.NaN, y: 0 },
  { kind: 'pointer', x: Number.POSITIVE_INFINITY, y: 0 },
  { kind: 'pointer', x: -1, y: 0 },
  { kind: 'pointer', x: 1_000_001, y: 0 },
  { kind: 'key', key: '' },
  { kind: 'key', key: 'Enter\nInjected' },
  { kind: 'key', key: 'x'.repeat(129) },
  { kind: 'text', text: 'before\0after' },
  { kind: 'text', text: 'x'.repeat(4_097) },
];

test('direct provider dispatcher rejects invalid input before native dispatch', async () => {
  const provider = new InputProvider();
  for (const input of invalidInputs) {
    const outcome = await dispatchRemoteDesktopInput(provider, session, input);
    assert.deepEqual(outcome, { dispatch: 'not-dispatched', status: 'failed', evidence: 'remote-desktop.invalid-input' });
  }
  assert.equal(provider.pointerCalls, 0);
  assert.equal(provider.keyCalls, 0);
  assert.equal(provider.textCalls, 0);
});

test('direct provider dispatcher accepts exact finite boundaries and freezes provider payloads', async () => {
  const provider = new InputProvider();

  assert.equal((await dispatchRemoteDesktopInput(provider, session, { kind: 'pointer', x: 1_000_000, y: 0 })).dispatch, 'dispatched-once');
  assert.deepEqual(provider.seen, { kind: 'pointer', x: 1_000_000, y: 0 });
  assert.equal(Object.isFrozen(provider.seen), true);

  const key = 'k'.repeat(128);
  assert.equal((await dispatchRemoteDesktopInput(provider, session, { kind: 'key', key })).dispatch, 'dispatched-once');
  assert.deepEqual(provider.seen, { kind: 'key', key });
  assert.equal(Object.isFrozen(provider.seen), true);

  const text = `${'t'.repeat(4_095)}\n`;
  assert.equal((await dispatchRemoteDesktopInput(provider, session, { kind: 'text', text })).dispatch, 'dispatched-once');
  assert.deepEqual(provider.seen, { kind: 'text', text });
  assert.equal(Object.isFrozen(provider.seen), true);

  assert.equal(provider.pointerCalls, 1);
  assert.equal(provider.keyCalls, 1);
  assert.equal(provider.textCalls, 1);
});
