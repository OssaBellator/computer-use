import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SshRemoteSessionBackend,
  type SshProviderConnectRequest,
  type SshProviderExecLimits,
  type SshProviderSession,
  type SshTransportProvider,
} from '../src/computer/sshRemoteSessionBackend.js';
import { RemoteDesktopRemoteSessionBackend } from '../src/computer/remoteDesktopRemoteSessionBackend.js';
import type {
  RemoteDesktopProviderFrame,
  RemoteDesktopProviderSession,
  RemoteDesktopTransportProvider,
} from '../src/computer/remoteDesktopTransportProvider.js';
import type {
  RemoteCommandInvocation,
  RemoteCommandResult,
  RemoteDispatchOutcome,
  RemoteEndpointIdentity,
} from '../src/computer/remoteSessionAdapter.js';

const sshEndpoint: RemoteEndpointIdentity = Object.freeze({ endpointId: 'ssh-owner', protocol: 'ssh', host: 'fixture.invalid', port: 22 });
const vncEndpoint: RemoteEndpointIdentity = Object.freeze({ endpointId: 'vnc-owner', protocol: 'vnc', host: 'fixture.invalid', port: 5900 });

class OwnershipSshProvider implements SshTransportProvider {
  disconnectCalls = 0;
  async connect(_request: SshProviderConnectRequest): Promise<SshProviderSession> {
    return { providerSessionId: 'ssh-provider-private', remoteHostId: 'ssh-host' };
  }
  async disconnect(_session: SshProviderSession): Promise<void> { this.disconnectCalls++; }
  async executeArgv(_session: SshProviderSession, _invocation: RemoteCommandInvocation, _limits: SshProviderExecLimits): Promise<RemoteDispatchOutcome<RemoteCommandResult>> {
    return { dispatch: 'dispatched-once', status: 'completed', value: { exitCode: 0 } };
  }
}

class OwnershipDesktopProvider implements RemoteDesktopTransportProvider {
  readonly protocol = 'vnc' as const;
  disconnectCalls = 0;
  cleanupCalls = 0;
  async connect(): Promise<RemoteDesktopProviderSession> {
    return { providerSessionId: 'vnc-provider-private', remoteHostId: 'vnc-host' };
  }
  async cleanupFailedConnect(_candidate: unknown): Promise<void> { this.cleanupCalls++; }
  async disconnect(_session: RemoteDesktopProviderSession): Promise<void> { this.disconnectCalls++; }
  async captureDisplay(): Promise<RemoteDesktopProviderFrame> {
    return { width: 1, height: 1, format: 'rgba', byteLength: 4, copyBytes: () => new Uint8Array(4) };
  }
  async sendPointer(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
  async sendKey(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
  async sendText(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
}

test('SSH failed-candidate cleanup ignores a semantic clone and follows private object identity', async () => {
  const provider = new OwnershipSshProvider();
  const backend = new SshRemoteSessionBackend(provider);
  const connection = await backend.connect(sshEndpoint);
  const forgedClone = {
    sessionId: connection.sessionId,
    remoteHostId: connection.remoteHostId,
    capabilities: [...connection.capabilities],
  };
  await backend.cleanupFailedConnection(forgedClone);
  assert.equal(provider.disconnectCalls, 0);
  await backend.disconnect(connection);
  assert.equal(provider.disconnectCalls, 1);
});

test('SSH cleanup of the exact returned candidate consumes ownership', async () => {
  const provider = new OwnershipSshProvider();
  const backend = new SshRemoteSessionBackend(provider);
  const connection = await backend.connect(sshEndpoint);
  await backend.cleanupFailedConnection(connection);
  assert.equal(provider.disconnectCalls, 1);
  await assert.rejects(() => backend.disconnect(connection), /unknown ssh session/);
});

test('remote desktop failed-candidate cleanup ignores a semantic clone', async () => {
  const provider = new OwnershipDesktopProvider();
  const backend = new RemoteDesktopRemoteSessionBackend(provider);
  const connection = await backend.connect(vncEndpoint);
  const forgedClone = {
    sessionId: connection.sessionId,
    remoteHostId: connection.remoteHostId,
    capabilities: [...connection.capabilities],
  };
  await backend.cleanupFailedConnection(forgedClone);
  assert.equal(provider.disconnectCalls, 0);
  assert.equal(provider.cleanupCalls, 0);
  await backend.disconnect(connection);
  assert.equal(provider.disconnectCalls, 1);
});

test('remote desktop cleanup of the exact returned candidate consumes ownership', async () => {
  const provider = new OwnershipDesktopProvider();
  const backend = new RemoteDesktopRemoteSessionBackend(provider);
  const connection = await backend.connect(vncEndpoint);
  await backend.cleanupFailedConnection(connection);
  assert.equal(provider.disconnectCalls, 1);
  await assert.rejects(() => backend.disconnect(connection), /unknown remote desktop session/);
});
