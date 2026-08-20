import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SshRemoteSessionBackend,
  type SshProviderConnectRequest,
  type SshProviderExecLimits,
  type SshProviderSession,
  type SshTransportProvider,
} from '../src/computer/sshRemoteSessionBackend.js';
import {
  dispatchRemoteDesktopInput,
  type RemoteDesktopProviderFrame,
  type RemoteDesktopProviderSession,
  type RemoteDesktopTransportProvider,
} from '../src/computer/remoteDesktopTransportProvider.js';
import type {
  RemoteCommandInvocation,
  RemoteCommandResult,
  RemoteDispatchOutcome,
  RemoteEndpointIdentity,
} from '../src/computer/remoteSessionAdapter.js';

class Utf8SshProvider implements SshTransportProvider {
  execCalls = 0;
  async connect(_request: SshProviderConnectRequest): Promise<SshProviderSession> { return { providerSessionId: 'utf8-ssh', remoteHostId: 'utf8-host' }; }
  async cleanupFailedConnect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async executeArgv(_session: SshProviderSession, _invocation: RemoteCommandInvocation, _limits: SshProviderExecLimits): Promise<RemoteDispatchOutcome<RemoteCommandResult>> {
    this.execCalls++;
    return { dispatch: 'dispatched-once', status: 'completed', value: { exitCode: 0 } };
  }
}

class Utf8DesktopProvider implements RemoteDesktopTransportProvider {
  readonly protocol = 'vnc' as const;
  keyCalls = 0;
  textCalls = 0;
  async connect(): Promise<RemoteDesktopProviderSession> { return { providerSessionId: 'utf8-vnc', remoteHostId: 'utf8-vnc-host' }; }
  async cleanupFailedConnect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async captureDisplay(): Promise<RemoteDesktopProviderFrame> { return { width: 1, height: 1, format: 'rgba', byteLength: 4, copyBytes: () => new Uint8Array(4) }; }
  async sendPointer(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
  async sendKey(): Promise<RemoteDispatchOutcome<void>> { this.keyCalls++; return { dispatch: 'dispatched-once', status: 'completed' }; }
  async sendText(): Promise<RemoteDispatchOutcome<void>> { this.textCalls++; return { dispatch: 'dispatched-once', status: 'completed' }; }
}

const sshEndpoint: RemoteEndpointIdentity = Object.freeze({ endpointId: 'utf8-ssh-endpoint', protocol: 'ssh', host: 'fixture.invalid', port: 22 });

test('SSH argv limit is measured in UTF-8 bytes rather than JavaScript characters', async () => {
  const provider = new Utf8SshProvider();
  const backend = new SshRemoteSessionBackend(provider);
  const connection = await backend.connect(sshEndpoint);

  const exact = 'é'.repeat(2_048); // 4096 UTF-8 bytes.
  const accepted = await backend.executeRemoteCommand(connection, { command: 'printf', args: [exact] });
  assert.equal(accepted.dispatch, 'dispatched-once');
  assert.equal(provider.execCalls, 1);

  const oversized = 'é'.repeat(2_049); // 4098 UTF-8 bytes.
  const rejected = await backend.executeRemoteCommand(connection, { command: 'printf', args: [oversized] });
  assert.deepEqual(rejected, { dispatch: 'not-dispatched', status: 'failed', evidence: 'ssh.invalid-argv' });
  assert.equal(provider.execCalls, 1);
});

test('RDP/VNC key and text ceilings are measured in UTF-8 bytes', async () => {
  const provider = new Utf8DesktopProvider();
  const session = Object.freeze({ providerSessionId: 'utf8-vnc', remoteHostId: 'utf8-vnc-host' });

  assert.equal((await dispatchRemoteDesktopInput(provider, session, { kind: 'key', key: 'é'.repeat(64) })).dispatch, 'dispatched-once');
  assert.deepEqual(
    await dispatchRemoteDesktopInput(provider, session, { kind: 'key', key: 'é'.repeat(65) }),
    { dispatch: 'not-dispatched', status: 'failed', evidence: 'remote-desktop.invalid-input' },
  );
  assert.equal(provider.keyCalls, 1);

  assert.equal((await dispatchRemoteDesktopInput(provider, session, { kind: 'text', text: 'é'.repeat(2_048) })).dispatch, 'dispatched-once');
  assert.deepEqual(
    await dispatchRemoteDesktopInput(provider, session, { kind: 'text', text: 'é'.repeat(2_049) }),
    { dispatch: 'not-dispatched', status: 'failed', evidence: 'remote-desktop.invalid-input' },
  );
  assert.equal(provider.textCalls, 1);
});
