import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SshRemoteSessionBackend,
  type SshCredentialMaterial,
  type SshCredentialResolver,
  type SshProviderConnectRequest,
  type SshProviderExecLimits,
  type SshProviderSession,
  type SshTransportProvider,
} from '../src/computer/sshRemoteSessionBackend.js';
import {
  RemoteSessionAdapter,
  type RemoteCommandInvocation,
  type RemoteCommandResult,
  type RemoteDispatchOutcome,
  type RemoteEndpointIdentity,
} from '../src/computer/remoteSessionAdapter.js';

class CredentialBoundProvider implements SshTransportProvider {
  connectCalls = 0;
  seenConnect?: SshProviderConnectRequest;
  async connect(request: SshProviderConnectRequest): Promise<SshProviderSession> {
    this.connectCalls++;
    this.seenConnect = request;
    return { providerSessionId: 'credential-bound-provider', remoteHostId: 'credential-bound-host' };
  }
  async cleanupFailedConnect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async executeArgv(_session: SshProviderSession, _invocation: RemoteCommandInvocation, _limits: SshProviderExecLimits): Promise<RemoteDispatchOutcome<RemoteCommandResult>> {
    return { dispatch: 'dispatched-once', status: 'completed', value: { exitCode: 0 } };
  }
}

const endpoint: RemoteEndpointIdentity = Object.freeze({ endpointId: 'credential-bound-endpoint', protocol: 'ssh', host: 'fixture.invalid', port: 22 });
const handle = Object.freeze({ kind: 'secret-handle' as const, handleId: 'vault:bounded-material' });

async function connectWith(material: SshCredentialMaterial) {
  const provider = new CredentialBoundProvider();
  const resolver: SshCredentialResolver = { async resolve() { return material; } };
  const adapter = new RemoteSessionAdapter('ssh-credential-material', endpoint, new SshRemoteSessionBackend(provider, resolver));
  return { provider, adapter, connect: () => adapter.connect(handle) };
}

test('credential material references over 4096 UTF-8 bytes are rejected before provider connect', async () => {
  for (const field of ['identityFile', 'certificateFile', 'agentSocket'] as const) {
    const fixture = await connectWith({ [field]: 'é'.repeat(2_049) });
    await assert.rejects(fixture.connect, /invalid ssh credential material/);
    assert.equal(fixture.provider.connectCalls, 0);
    assert.equal(fixture.adapter.state().authority, undefined);
  }
});

test('credential material references containing NUL or line breaks are rejected before provider connect', async () => {
  for (const value of ['/controlled/id\0suffix', '/controlled/id\nInjected', '/controlled/id\rInjected']) {
    const fixture = await connectWith({ identityFile: value });
    await assert.rejects(fixture.connect, /invalid ssh credential material/);
    assert.equal(fixture.provider.connectCalls, 0);
  }
});

test('credential material at the exact 4096-byte ceiling is snapshotted and frozen', async () => {
  const exact = 'é'.repeat(2_048);
  const fixture = await connectWith({ identityFile: exact, agentSocket: '/controlled/agent.sock' });
  await fixture.connect();
  assert.equal(fixture.provider.connectCalls, 1);
  assert.deepEqual(fixture.provider.seenConnect?.credential, { identityFile: exact, agentSocket: '/controlled/agent.sock' });
  assert.equal(Object.isFrozen(fixture.provider.seenConnect?.credential), true);
});
