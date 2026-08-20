import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SshRemoteSessionBackend,
  type SshCredentialResolver,
  type SshProviderConnectRequest,
  type SshProviderExecLimits,
  type SshProviderSession,
  type SshTransportProvider,
} from '../src/computer/sshRemoteSessionBackend.js';
import {
  RemoteDispatchError,
  RemoteSessionAdapter,
  type RemoteCommandInvocation,
  type RemoteCommandResult,
  type RemoteDispatchOutcome,
  type RemoteEndpointIdentity,
  type RemoteMetadataItem,
} from '../src/computer/remoteSessionAdapter.js';
import { computerActionMayAutoRetry } from '../src/computer/environmentAdapter.js';

const endpoint: RemoteEndpointIdentity = Object.freeze({ endpointId: 'ssh-fixture', protocol: 'ssh', host: 'fixture.invalid', port: 22 });

class FakeSshProvider implements SshTransportProvider {
  connectCalls = 0;
  disconnectCalls = 0;
  execCalls = 0;
  seenConnect?: SshProviderConnectRequest;
  seenInvocation?: RemoteCommandInvocation;
  seenLimits?: SshProviderExecLimits;
  nextSession: unknown = { providerSessionId: 'provider-1', remoteHostId: 'host-1' };
  outcome: unknown = { dispatch: 'dispatched-once', status: 'completed', value: { exitCode: 0, stdout: 'ok', stderr: '' } };
  error: unknown;
  metadata: readonly RemoteMetadataItem[] = [];

  async connect(request: SshProviderConnectRequest): Promise<SshProviderSession> {
    this.connectCalls++;
    this.seenConnect = request;
    return this.nextSession as SshProviderSession;
  }
  async disconnect(_session: SshProviderSession): Promise<void> { this.disconnectCalls++; }
  async executeArgv(_session: SshProviderSession, invocation: RemoteCommandInvocation, limits: SshProviderExecLimits): Promise<RemoteDispatchOutcome<RemoteCommandResult>> {
    this.execCalls++;
    this.seenInvocation = invocation;
    this.seenLimits = limits;
    if (this.error) throw this.error;
    return this.outcome as RemoteDispatchOutcome<RemoteCommandResult>;
  }
  async observeMetadata(_session: SshProviderSession, _limits: { readonly maxItems: number; readonly maxTextBytes: number }): Promise<readonly RemoteMetadataItem[]> { return this.metadata; }
}

function sshAction(adapter: RemoteSessionAdapter, authority: unknown, invocation: unknown) {
  return adapter.act({
    adapterId: adapter.adapterId,
    actionId: 'ssh-action',
    capability: 'remote.ssh.execute',
    effect: 'remote-execution',
    idempotency: 'non-idempotent',
    payload: { authority, invocation },
  });
}

test('credential resolver receives only handle and provider receives finite material snapshot', async () => {
  const provider = new FakeSshProvider();
  let seenHandle: unknown;
  const resolver: SshCredentialResolver = {
    async resolve(handle) {
      seenHandle = handle;
      return { identityFile: '/controlled/id_ed25519', certificateFile: '/controlled/id_ed25519-cert.pub' };
    },
  };
  const backend = new SshRemoteSessionBackend(provider, resolver);
  const adapter = new RemoteSessionAdapter('ssh', endpoint, backend);
  const credential = { kind: 'secret-handle' as const, handleId: 'vault:ssh-prod' };
  await adapter.connect(credential);
  assert.deepEqual(seenHandle, credential);
  assert.notEqual(seenHandle, credential);
  assert.equal(Object.isFrozen(seenHandle), true);
  assert.deepEqual(provider.seenConnect?.credential, { identityFile: '/controlled/id_ed25519', certificateFile: '/controlled/id_ed25519-cert.pub' });
  assert.equal(Object.isFrozen(provider.seenConnect?.credential), true);
  assert.equal(JSON.stringify(adapter.state()).includes('vault:ssh-prod'), false);
});

test('malformed provider connection is cleaned and never becomes adapter authority', async () => {
  const provider = new FakeSshProvider();
  provider.nextSession = { providerSessionId: '', remoteHostId: 'host-1' };
  const adapter = new RemoteSessionAdapter('ssh', endpoint, new SshRemoteSessionBackend(provider));
  await assert.rejects(() => adapter.connect(), /invalid ssh provider session/);
  assert.equal(provider.disconnectCalls, 1);
  assert.equal(adapter.state().authority, undefined);
  assert.equal(adapter.state().lifecycle, 'failed');
});

test('argv and output budgets reach provider as frozen acquisition ceilings', async () => {
  const provider = new FakeSshProvider();
  const adapter = new RemoteSessionAdapter('ssh', endpoint, new SshRemoteSessionBackend(provider));
  const authority = await adapter.connect();
  const result = await sshAction(adapter, authority, { command: 'printf', args: ['%s', 'hello world'] });
  assert.equal(result.dispatch, 'dispatched-once');
  assert.deepEqual(provider.seenInvocation, { command: 'printf', args: ['%s', 'hello world'] });
  assert.equal(Object.isFrozen(provider.seenInvocation), true);
  assert.equal(Object.isFrozen(provider.seenInvocation?.args), true);
  assert.deepEqual(provider.seenLimits, { maxStdoutBytes: 65_536, maxStderrBytes: 65_536 });
  assert.equal(Object.isFrozen(provider.seenLimits), true);
});

test('provider exception after invocation is sticky uncertainty and is never redispatched by adapter', async () => {
  const provider = new FakeSshProvider();
  provider.error = new Error('lost transport after send');
  const adapter = new RemoteSessionAdapter('ssh', endpoint, new SshRemoteSessionBackend(provider));
  const authority = await adapter.connect();
  const result = await sshAction(adapter, authority, { command: 'do-once', args: [] });
  assert.equal(result.dispatch, 'unknown');
  assert.equal(provider.execCalls, 1);
  assert.equal(computerActionMayAutoRetry({ effect: 'remote-execution', idempotency: 'non-idempotent' } as any, result), false);
  assert.equal(provider.execCalls, 1);
});

test('malformed post-dispatch result becomes uncertainty, not retry-safe failure', async () => {
  const provider = new FakeSshProvider();
  provider.outcome = { dispatch: 'dispatched-once', status: 'completed', value: { exitCode: 0, stdout: 'x'.repeat(70_000) } };
  const adapter = new RemoteSessionAdapter('ssh', endpoint, new SshRemoteSessionBackend(provider));
  const authority = await adapter.connect();
  const result = await sshAction(adapter, authority, { command: 'bounded' });
  assert.equal(result.dispatch, 'unknown');
  assert.equal(result.status, 'unknown');
  assert.equal(provider.execCalls, 1);
});

test('explicit provider not-dispatched result remains retry-safe transport failure', async () => {
  const provider = new FakeSshProvider();
  provider.outcome = { dispatch: 'not-dispatched', status: 'failed', evidence: 'ssh.spawn-failed' };
  const adapter = new RemoteSessionAdapter('ssh', endpoint, new SshRemoteSessionBackend(provider));
  const authority = await adapter.connect();
  const result = await sshAction(adapter, authority, { command: 'never-sent' });
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(provider.execCalls, 1);
});

test('RemoteDispatchError preserves provider knowledge without downgrading unknown dispatch', async () => {
  const provider = new FakeSshProvider();
  provider.error = new RemoteDispatchError('unknown', 'ssh.transport-unknown');
  const adapter = new RemoteSessionAdapter('ssh', endpoint, new SshRemoteSessionBackend(provider));
  const authority = await adapter.connect();
  const result = await sshAction(adapter, authority, { command: 'once' });
  assert.equal(result.dispatch, 'unknown');
  assert.deepEqual(result.evidence, ['ssh.transport-unknown']);
});

test('metadata provider cannot exceed producer-side item/text budgets', async () => {
  const provider = new FakeSshProvider();
  provider.metadata = [{ key: 'k', value: 'v'.repeat(100) }];
  const adapter = new RemoteSessionAdapter('ssh', endpoint, new SshRemoteSessionBackend(provider));
  await adapter.connect();
  await assert.rejects(() => adapter.observe({ adapterId: 'ssh', channel: 'terminal', limits: { maxItems: 1, maxTextBytes: 8 } }), /acquisition bound exceeded/);
});
