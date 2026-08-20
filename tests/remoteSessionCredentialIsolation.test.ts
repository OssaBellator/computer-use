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
import { RemoteDesktopRemoteSessionBackend } from '../src/computer/remoteDesktopRemoteSessionBackend.js';
import type {
  RemoteDesktopProviderFrame,
  RemoteDesktopProviderSession,
  RemoteDesktopTransportProvider,
} from '../src/computer/remoteDesktopTransportProvider.js';
import {
  RemoteSessionAdapter,
  type RemoteCommandInvocation,
  type RemoteCommandResult,
  type RemoteDispatchOutcome,
  type RemoteEndpointIdentity,
  type RemoteSecretHandle,
} from '../src/computer/remoteSessionAdapter.js';

class CredentialSshProvider implements SshTransportProvider {
  seenConnect?: SshProviderConnectRequest;
  async connect(request: SshProviderConnectRequest): Promise<SshProviderSession> {
    this.seenConnect = request;
    return { providerSessionId: 'credential-ssh-provider', remoteHostId: 'credential-ssh-host' };
  }
  async cleanupFailedConnect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async executeArgv(_session: SshProviderSession, _invocation: RemoteCommandInvocation, _limits: SshProviderExecLimits): Promise<RemoteDispatchOutcome<RemoteCommandResult>> {
    return { dispatch: 'dispatched-once', status: 'completed', value: { exitCode: 0 } };
  }
}

class CredentialDesktopProvider implements RemoteDesktopTransportProvider {
  readonly protocol = 'vnc' as const;
  seenCredential?: RemoteSecretHandle;
  async connect(_endpoint: RemoteEndpointIdentity, credential?: RemoteSecretHandle): Promise<RemoteDesktopProviderSession> {
    this.seenCredential = credential;
    return { providerSessionId: 'credential-vnc-provider', remoteHostId: 'credential-vnc-host' };
  }
  async cleanupFailedConnect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async captureDisplay(): Promise<RemoteDesktopProviderFrame> {
    return { width: 1, height: 1, format: 'rgba', byteLength: 4, copyBytes: () => new Uint8Array(4) };
  }
  async sendPointer(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
  async sendKey(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
  async sendText(): Promise<RemoteDispatchOutcome<void>> { return { dispatch: 'dispatched-once', status: 'completed' }; }
}

function hostileHandle(onSecretRead: () => void) {
  const value = {
    kind: 'secret-handle' as const,
    handleId: 'vault:remote-session-fixture',
    password: 'must-not-cross-boundary',
  } as Record<string, unknown>;
  Object.defineProperty(value, 'token', {
    enumerable: true,
    get() { onSecretRead(); return 'must-not-be-read'; },
  });
  return value;
}

test('SSH credential resolution receives only the frozen secret-handle snapshot', async () => {
  const provider = new CredentialSshProvider();
  let secretAccessorCalls = 0;
  let resolvedHandle: RemoteSecretHandle | undefined;
  const resolver: SshCredentialResolver = {
    async resolve(handle) {
      resolvedHandle = handle;
      return { identityFile: '/controlled/identity' };
    },
  };
  const adapter = new RemoteSessionAdapter(
    'ssh-credential-isolation',
    Object.freeze({ endpointId: 'ssh-credential-endpoint', protocol: 'ssh', host: 'fixture.invalid', port: 22 }),
    new SshRemoteSessionBackend(provider, resolver),
  );
  const raw = hostileHandle(() => { secretAccessorCalls++; });
  await adapter.connect(raw as unknown as RemoteSecretHandle);

  assert.deepEqual(resolvedHandle, { kind: 'secret-handle', handleId: 'vault:remote-session-fixture' });
  assert.equal(Object.isFrozen(resolvedHandle), true);
  assert.equal('password' in (resolvedHandle as unknown as Record<string, unknown>), false);
  assert.equal('token' in (resolvedHandle as unknown as Record<string, unknown>), false);
  assert.equal(secretAccessorCalls, 0);
  assert.deepEqual(provider.seenConnect?.credential, { identityFile: '/controlled/identity' });
  assert.equal(JSON.stringify(adapter.state()).includes('must-not-cross-boundary'), false);
});

test('RDP/VNC provider connect receives only the frozen secret-handle snapshot', async () => {
  const provider = new CredentialDesktopProvider();
  let secretAccessorCalls = 0;
  const adapter = new RemoteSessionAdapter(
    'vnc-credential-isolation',
    Object.freeze({ endpointId: 'vnc-credential-endpoint', protocol: 'vnc', host: 'fixture.invalid', port: 5900 }),
    new RemoteDesktopRemoteSessionBackend(provider),
  );
  const raw = hostileHandle(() => { secretAccessorCalls++; });
  await adapter.connect(raw as unknown as RemoteSecretHandle);

  assert.deepEqual(provider.seenCredential, { kind: 'secret-handle', handleId: 'vault:remote-session-fixture' });
  assert.equal(Object.isFrozen(provider.seenCredential), true);
  assert.equal('password' in (provider.seenCredential as unknown as Record<string, unknown>), false);
  assert.equal('token' in (provider.seenCredential as unknown as Record<string, unknown>), false);
  assert.equal(secretAccessorCalls, 0);
  assert.equal(JSON.stringify(adapter.state()).includes('must-not-cross-boundary'), false);
});
