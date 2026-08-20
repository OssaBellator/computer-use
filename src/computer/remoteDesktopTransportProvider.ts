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

const MAX_VISUAL_COORDINATE = 1_000_000;
const MAX_VISUAL_KEY_BYTES = 128;
const MAX_VISUAL_TEXT_BYTES = 4_096;
function utf8Bytes(value: string): number { return Buffer.byteLength(value, 'utf8'); }
function validPointerCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_VISUAL_COORDINATE;
}
function validKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && utf8Bytes(value) <= MAX_VISUAL_KEY_BYTES && !/[\0\r\n]/.test(value);
}
function validText(value: unknown): value is string {
  return typeof value === 'string' && utf8Bytes(value) <= MAX_VISUAL_TEXT_BYTES && !value.includes('\0');
}

export function dispatchRemoteDesktopInput(
  provider: RemoteDesktopTransportProvider,
  session: RemoteDesktopProviderSession,
  input: RemoteVisualInput,
): Promise<RemoteDispatchOutcome<void>> {
  if (input.kind === 'pointer' && validPointerCoordinate(input.x) && validPointerCoordinate(input.y)) {
    return provider.sendPointer(session, Object.freeze({ kind: 'pointer', x: input.x, y: input.y }));
  }
  if (input.kind === 'key' && validKey(input.key)) {
    return provider.sendKey(session, Object.freeze({ kind: 'key', key: input.key }));
  }
  if (input.kind === 'text' && validText(input.text)) {
    return provider.sendText(session, Object.freeze({ kind: 'text', text: input.text }));
  }
  return Promise.resolve(Object.freeze({ dispatch: 'not-dispatched', status: 'failed', evidence: 'remote-desktop.invalid-input' }));
}
