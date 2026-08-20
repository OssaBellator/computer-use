import type {
  RemoteDispatchOutcome,
  RemoteDisplayCaptureLimits,
  RemoteEndpointIdentity,
  RemoteSecretHandle,
  RemoteVisualInput,
} from './remoteSessionAdapter.js';

/**
 * Provider seam for production RDP/VNC integrations. Implementations own native
 * handles and credentials; callers receive only finite semantic session identity.
 * Clipboard and file transfer are intentionally absent.
 */
export interface RemoteDesktopProviderSession {
  readonly providerSessionId: string;
  readonly remoteHostId: string;
}

export interface RemoteDesktopProviderFrame {
  readonly width: number;
  readonly height: number;
  readonly format: 'rgba' | 'png';
  readonly byteLength: number;
  /** Must materialize at most byteLength bytes and only after limits were checked by the provider. */
  copyBytes(): Uint8Array;
  readonly frameId?: string;
  readonly truncated?: boolean;
}

export interface RemoteDesktopTransportProvider {
  readonly protocol: 'rdp' | 'vnc';
  connect(endpoint: RemoteEndpointIdentity, credential?: RemoteSecretHandle): Promise<RemoteDesktopProviderSession>;
  /** Must release any native state represented by a malformed/partial connect result. */
  cleanupFailedConnect(candidate: unknown): Promise<void>;
  disconnect(session: RemoteDesktopProviderSession): Promise<void>;
  /** Acquisition limits are producer-side ceilings, not post-copy hints. */
  captureDisplay(session: RemoteDesktopProviderSession, limits: RemoteDisplayCaptureLimits): Promise<RemoteDesktopProviderFrame>;
  sendPointer(session: RemoteDesktopProviderSession, input: Readonly<{ kind: 'pointer'; x: number; y: number }>): Promise<RemoteDispatchOutcome<void>>;
  sendKey(session: RemoteDesktopProviderSession, input: Readonly<{ kind: 'key'; key: string }>): Promise<RemoteDispatchOutcome<void>>;
  sendText(session: RemoteDesktopProviderSession, input: Readonly<{ kind: 'text'; text: string }>): Promise<RemoteDispatchOutcome<void>>;
}

export function dispatchRemoteDesktopInput(
  provider: RemoteDesktopTransportProvider,
  session: RemoteDesktopProviderSession,
  input: RemoteVisualInput,
): Promise<RemoteDispatchOutcome<void>> {
  if (input.kind === 'pointer' && typeof input.x === 'number' && typeof input.y === 'number') {
    return provider.sendPointer(session, Object.freeze({ kind: 'pointer', x: input.x, y: input.y }));
  }
  if (input.kind === 'key' && typeof input.key === 'string') {
    return provider.sendKey(session, Object.freeze({ kind: 'key', key: input.key }));
  }
  if (input.kind === 'text' && typeof input.text === 'string') {
    return provider.sendText(session, Object.freeze({ kind: 'text', text: input.text }));
  }
  return Promise.resolve(Object.freeze({ dispatch: 'not-dispatched', status: 'failed', evidence: 'remote-desktop.invalid-input' }));
}
