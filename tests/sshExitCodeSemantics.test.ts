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
  RemoteSessionAdapter,
  type RemoteCommandInvocation,
  type RemoteCommandResult,
  type RemoteDispatchOutcome,
  type RemoteEndpointIdentity,
} from '../src/computer/remoteSessionAdapter.js';

class ExitCodeProvider implements SshTransportProvider {
  execCalls = 0;
  async connect(_request: SshProviderConnectRequest): Promise<SshProviderSession> {
    return { providerSessionId: 'exit-provider', remoteHostId: 'exit-host' };
  }
  async cleanupFailedConnect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async executeArgv(_session: SshProviderSession, _invocation: RemoteCommandInvocation, _limits: SshProviderExecLimits): Promise<RemoteDispatchOutcome<RemoteCommandResult>> {
    this.execCalls++;
    return {
      dispatch: 'dispatched-once',
      status: 'completed',
      value: { exitCode: 23, stdout: '', stderr: 'remote command reported failure' },
    };
  }
}

const endpoint: RemoteEndpointIdentity = Object.freeze({ endpointId: 'exit-semantics', protocol: 'ssh', host: 'fixture.invalid', port: 22 });

test('nonzero SSH exit code proves command-process completion only, not domain effect', async () => {
  const provider = new ExitCodeProvider();
  const adapter = new RemoteSessionAdapter('ssh-exit-semantics', endpoint, new SshRemoteSessionBackend(provider));
  const authority = await adapter.connect();
  const result = await adapter.act({
    adapterId: adapter.adapterId,
    actionId: 'nonzero-exit',
    capability: 'remote.ssh.execute',
    effect: 'remote-execution',
    idempotency: 'non-idempotent',
    payload: { authority, invocation: { command: 'domain-operation', args: [] } },
  });

  assert.equal(provider.execCalls, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(result.verification, 'not-applicable');
  assert.deepEqual(result.details, { exitCode: 23, stdout: '', stderr: 'remote command reported failure' });
  assert.equal(result.evidence, undefined);
});
