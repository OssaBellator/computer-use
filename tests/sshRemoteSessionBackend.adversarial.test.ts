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
  RemoteSessionAdapter,
  type RemoteCommandInvocation,
  type RemoteCommandResult,
  type RemoteDispatchOutcome,
  type RemoteEndpointIdentity,
  type RemoteMetadataItem,
} from '../src/computer/remoteSessionAdapter.js';

const endpoint: RemoteEndpointIdentity = Object.freeze({ endpointId: 'ssh-adversarial', protocol: 'ssh', host: 'fixture.invalid', port: 22 });

class AdversarialSshProvider implements SshTransportProvider {
  connectCalls = 0;
  cleanupCalls = 0;
  disconnectCalls = 0;
  execCalls = 0;
  nextSession: unknown = { providerSessionId: 'provider-1', remoteHostId: 'host-1' };
  outcome: unknown = { dispatch: 'dispatched-once', status: 'completed', value: { exitCode: 0 } };
  metadata: unknown = [];

  async connect(_request: SshProviderConnectRequest): Promise<SshProviderSession> {
    this.connectCalls++;
    return this.nextSession as SshProviderSession;
  }
  async cleanupFailedConnect(_candidate: unknown): Promise<void> { this.cleanupCalls++; }
  async disconnect(_session: SshProviderSession): Promise<void> { this.disconnectCalls++; }
  async executeArgv(_session: SshProviderSession, _invocation: RemoteCommandInvocation, _limits: SshProviderExecLimits): Promise<RemoteDispatchOutcome<RemoteCommandResult>> {
    this.execCalls++;
    return this.outcome as RemoteDispatchOutcome<RemoteCommandResult>;
  }
  async observeMetadata(_session: SshProviderSession, _limits: { readonly maxItems: number; readonly maxTextBytes: number }): Promise<readonly RemoteMetadataItem[]> {
    return this.metadata as readonly RemoteMetadataItem[];
  }
}

function action(adapter: RemoteSessionAdapter, authority: unknown, invocation: unknown) {
  return adapter.act({
    adapterId: adapter.adapterId,
    actionId: 'ssh-adversarial-action',
    capability: 'remote.ssh.execute',
    effect: 'remote-execution',
    idempotency: 'non-idempotent',
    payload: { authority, invocation },
  });
}

test('credential material accessors are rejected before provider connect', async () => {
  const provider = new AdversarialSshProvider();
  let accessorCalls = 0;
  const resolver: SshCredentialResolver = {
    async resolve() {
      const material = {} as Record<string, unknown>;
      Object.defineProperty(material, 'identityFile', {
        enumerable: true,
        get() { accessorCalls++; return '/should/not/be/read'; },
      });
      return material;
    },
  };
  const adapter = new RemoteSessionAdapter('ssh', endpoint, new SshRemoteSessionBackend(provider, resolver));
  await assert.rejects(() => adapter.connect({ kind: 'secret-handle', handleId: 'vault:test' }), /invalid ssh credential material/);
  assert.equal(accessorCalls, 0);
  assert.equal(provider.connectCalls, 0);
  assert.equal(adapter.state().authority, undefined);
});

test('provider session accessors are not invoked and malformed candidate uses raw cleanup once', async () => {
  const provider = new AdversarialSshProvider();
  let accessorCalls = 0;
  const candidate = { remoteHostId: 'host-1' } as Record<string, unknown>;
  Object.defineProperty(candidate, 'providerSessionId', {
    enumerable: true,
    get() { accessorCalls++; return 'provider-secret'; },
  });
  provider.nextSession = candidate;
  const adapter = new RemoteSessionAdapter('ssh', endpoint, new SshRemoteSessionBackend(provider));
  await assert.rejects(() => adapter.connect(), /invalid ssh provider session/);
  assert.equal(accessorCalls, 0);
  assert.equal(provider.cleanupCalls, 1);
  assert.equal(provider.disconnectCalls, 0);
  assert.equal(adapter.state().authority, undefined);
});

test('provider prototype trap fails closed and still reaches raw-candidate cleanup', async () => {
  const provider = new AdversarialSshProvider();
  let prototypeTrapCalls = 0;
  const candidate = new Proxy({}, {
    getPrototypeOf() {
      prototypeTrapCalls++;
      throw new Error('hostile prototype trap');
    },
  });
  provider.nextSession = candidate;
  const adapter = new RemoteSessionAdapter('ssh', endpoint, new SshRemoteSessionBackend(provider));
  await assert.rejects(() => adapter.connect(), /invalid ssh provider session/);
  assert.equal(prototypeTrapCalls, 1);
  assert.equal(provider.cleanupCalls, 1);
  assert.equal(provider.disconnectCalls, 0);
  assert.equal(adapter.state().authority, undefined);
});

test('post-dispatch accessor result becomes uncertainty without evaluating accessor or redispatching', async () => {
  const provider = new AdversarialSshProvider();
  let accessorCalls = 0;
  const outcome = { dispatch: 'dispatched-once', status: 'completed' } as Record<string, unknown>;
  Object.defineProperty(outcome, 'value', {
    enumerable: true,
    get() { accessorCalls++; return { exitCode: 0 }; },
  });
  provider.outcome = outcome;
  const adapter = new RemoteSessionAdapter('ssh', endpoint, new SshRemoteSessionBackend(provider));
  const authority = await adapter.connect();
  const result = await action(adapter, authority, { command: 'do-once' });
  assert.equal(result.dispatch, 'unknown');
  assert.equal(result.status, 'unknown');
  assert.equal(accessorCalls, 0);
  assert.equal(provider.execCalls, 1);
});

test('invocation accessor is rejected before transport dispatch', async () => {
  const provider = new AdversarialSshProvider();
  const adapter = new RemoteSessionAdapter('ssh', endpoint, new SshRemoteSessionBackend(provider));
  const authority = await adapter.connect();
  let accessorCalls = 0;
  const invocation = { command: 'printf' } as Record<string, unknown>;
  Object.defineProperty(invocation, 'args', {
    enumerable: true,
    get() { accessorCalls++; return ['secret']; },
  });
  const result = await action(adapter, authority, invocation);
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(result.status, 'failed');
  assert.equal(accessorCalls, 0);
  assert.equal(provider.execCalls, 0);
});

test('metadata item accessors are rejected without invoking them', async () => {
  const provider = new AdversarialSshProvider();
  let accessorCalls = 0;
  const item = { key: 'safe' } as Record<string, unknown>;
  Object.defineProperty(item, 'value', {
    enumerable: true,
    get() { accessorCalls++; return 'hidden'; },
  });
  provider.metadata = [item];
  const adapter = new RemoteSessionAdapter('ssh', endpoint, new SshRemoteSessionBackend(provider));
  await adapter.connect();
  await assert.rejects(() => adapter.observe({ adapterId: 'ssh', channel: 'terminal', limits: { maxItems: 1, maxTextBytes: 32 } }), /acquisition bound exceeded/);
  assert.equal(accessorCalls, 0);
});
