import { randomUUID } from 'node:crypto';
import {
  RemoteDispatchError,
  type RemoteDispatchOutcome,
  type RemoteDisplayCaptureLimits,
  type RemoteDisplayFrame,
  type RemoteEndpointIdentity,
  type RemoteMetadataItem,
  type RemoteSecretHandle,
  type RemoteSessionBackend,
  type RemoteSessionConnection,
  type RemoteVisualInput,
} from './remoteSessionAdapter.js';
import {
  dispatchRemoteDesktopInput,
  type RemoteDesktopProviderFrame,
  type RemoteDesktopProviderSession,
  type RemoteDesktopTransportProvider,
} from './remoteDesktopTransportProvider.js';

const MAX_PROVIDER_ID_BYTES = 256;
const MAX_FRAME_ID_BYTES = 256;
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 16_777_216;
const MAX_BYTES = 67_108_864;
const MAX_EVIDENCE_BYTES = 128;

function bytes(value: string): number { return Buffer.byteLength(value, 'utf8'); }
function finiteString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && bytes(value) <= max && !/[\0\r\n]/.test(value);
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch { return false; }
}
function ownData(record: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
function snapshotProviderSession(value: unknown): Readonly<RemoteDesktopProviderSession> | undefined {
  if (!plainRecord(value)) return undefined;
  const providerSessionId = ownData(value, 'providerSessionId');
  const remoteHostId = ownData(value, 'remoteHostId');
  if (!finiteString(providerSessionId, MAX_PROVIDER_ID_BYTES) || !finiteString(remoteHostId, MAX_PROVIDER_ID_BYTES)) return undefined;
  return Object.freeze({ providerSessionId, remoteHostId });
}
function snapshotOutcome(value: unknown): Readonly<RemoteDispatchOutcome<void>> | undefined {
  if (!plainRecord(value)) return undefined;
  const dispatch = ownData(value, 'dispatch');
  const status = ownData(value, 'status');
  const evidence = ownData(value, 'evidence');
  const rawValue = ownData(value, 'value');
  if (dispatch === 'not-dispatched' && status === 'failed' && finiteString(evidence, MAX_EVIDENCE_BYTES) && rawValue === undefined) {
    return Object.freeze({ dispatch, status, evidence });
  }
  if (dispatch === 'unknown' && status === 'unknown' && finiteString(evidence, MAX_EVIDENCE_BYTES) && rawValue === undefined) {
    return Object.freeze({ dispatch, status, evidence });
  }
  if (dispatch === 'dispatched-once' && status === 'completed' && rawValue === undefined && (evidence === undefined || finiteString(evidence, MAX_EVIDENCE_BYTES))) {
    return Object.freeze({ dispatch, status, ...(evidence === undefined ? {} : { evidence }) });
  }
  return undefined;
}
function snapshotFrame(value: unknown, limits: RemoteDisplayCaptureLimits): Readonly<RemoteDisplayFrame> | undefined {
  if (!plainRecord(value)) return undefined;
  const width = ownData(value, 'width');
  const height = ownData(value, 'height');
  const format = ownData(value, 'format');
  const byteLength = ownData(value, 'byteLength');
  const frameId = ownData(value, 'frameId');
  const truncated = ownData(value, 'truncated');
  const copyBytes = ownData(value, 'copyBytes');
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) < 1 || (height as number) < 1) return undefined;
  if ((width as number) > MAX_DIMENSION || (height as number) > MAX_DIMENSION) return undefined;
  const pixels = (width as number) * (height as number);
  const pixelLimit = Math.min(limits.maxPixels, MAX_PIXELS);
  const byteLimit = Math.min(limits.maxBytes, MAX_BYTES);
  if (!Number.isSafeInteger(pixels) || pixels > pixelLimit) throw new Error('remote desktop frame exceeds acquisition pixel bound');
  if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0 || (byteLength as number) > byteLimit) throw new Error('remote desktop frame exceeds acquisition byte bound');
  if (format !== 'rgba' && format !== 'png') return undefined;
  if (format === 'rgba' && (byteLength as number) !== pixels * 4) return undefined;
  if (frameId !== undefined && !finiteString(frameId, MAX_FRAME_ID_BYTES)) return undefined;
  if (truncated !== undefined && typeof truncated !== 'boolean') return undefined;
  if (typeof copyBytes !== 'function') return undefined;

  let rawBytes: unknown;
  try { rawBytes = Reflect.apply(copyBytes as Function, value, []); } catch { return undefined; }
  if (!(rawBytes instanceof Uint8Array) || rawBytes.byteLength !== byteLength) return undefined;
  let copied: Uint8Array;
  try { copied = Uint8Array.prototype.slice.call(rawBytes) as Uint8Array; } catch { return undefined; }
  return Object.freeze({
    width: width as number,
    height: height as number,
    format: format === 'rgba' ? 'synthetic-rgba' : 'synthetic-png',
    bytes: copied,
    ...(frameId === undefined ? {} : { frameId: frameId as string }),
    ...(truncated === undefined ? {} : { truncated: truncated as boolean }),
  });
}

interface OwnedSession {
  readonly connection: Readonly<RemoteSessionConnection>;
  readonly providerSession: Readonly<RemoteDesktopProviderSession>;
}

export class RemoteDesktopRemoteSessionBackend implements RemoteSessionBackend {
  readonly protocol: 'rdp' | 'vnc';
  private readonly owned = new Map<string, OwnedSession>();
  private readonly rawCandidates = new WeakMap<object, OwnedSession>();

  constructor(private readonly provider: RemoteDesktopTransportProvider) {
    this.protocol = provider.protocol;
  }

  async connect(endpoint: RemoteEndpointIdentity, credential?: RemoteSecretHandle): Promise<RemoteSessionConnection> {
    if (endpoint.protocol !== this.protocol) throw new Error('remote desktop protocol mismatch');
    const rawCandidate: unknown = await this.provider.connect(endpoint, credential);
    const providerSession = snapshotProviderSession(rawCandidate);
    if (!providerSession) {
      try { await this.provider.cleanupFailedConnect(rawCandidate); }
      catch { throw new Error('invalid remote desktop provider session; cleanup failed'); }
      throw new Error('invalid remote desktop provider session');
    }
    const connection = Object.freeze({
      sessionId: `${this.protocol}-${randomUUID()}`,
      remoteHostId: providerSession.remoteHostId,
      capabilities: Object.freeze(['remote.session.observe', 'remote.metadata.observe', 'remote.display.observe', 'remote.visual.input']),
    });
    const owned = Object.freeze({ connection, providerSession });
    this.owned.set(connection.sessionId, owned);
    this.rawCandidates.set(connection, owned);
    return connection;
  }

  async cleanupFailedConnection(candidate: unknown): Promise<void> {
    if (!candidate || typeof candidate !== 'object') return;
    const owned = this.rawCandidates.get(candidate);
    if (!owned) return;
    this.owned.delete(owned.connection.sessionId);
    await this.provider.disconnect(owned.providerSession);
  }

  async disconnect(connection: RemoteSessionConnection): Promise<void> {
    const owned = this.requireOwned(connection);
    this.owned.delete(connection.sessionId);
    await this.provider.disconnect(owned.providerSession);
  }

  async observeMetadata(connection: RemoteSessionConnection, limits: { maxItems: number; maxTextBytes: number }): Promise<readonly RemoteMetadataItem[]> {
    const owned = this.requireOwned(connection);
    const items = [
      Object.freeze({ key: 'transport', value: this.protocol }),
      Object.freeze({ key: 'remoteHostId', value: owned.providerSession.remoteHostId }),
    ];
    let used = 0;
    const out: Readonly<RemoteMetadataItem>[] = [];
    for (const item of items) {
      if (out.length >= limits.maxItems) break;
      const next = bytes(item.key) + bytes(item.value);
      if (used + next > limits.maxTextBytes) break;
      out.push(item); used += next;
    }
    return Object.freeze(out);
  }

  async captureDisplay(connection: RemoteSessionConnection, limits: RemoteDisplayCaptureLimits): Promise<RemoteDisplayFrame> {
    const owned = this.requireOwned(connection);
    const boundedLimits = Object.freeze({ maxPixels: Math.min(limits.maxPixels, MAX_PIXELS), maxBytes: Math.min(limits.maxBytes, MAX_BYTES) });
    const raw = await this.provider.captureDisplay(owned.providerSession, boundedLimits);
    const frame = snapshotFrame(raw, boundedLimits);
    if (!frame) throw new Error('invalid remote desktop provider frame');
    return frame;
  }

  async sendVisualInput(connection: RemoteSessionConnection, input: RemoteVisualInput): Promise<RemoteDispatchOutcome<void>> {
    const owned = this.requireOwned(connection);
    let raw: unknown;
    try { raw = await dispatchRemoteDesktopInput(this.provider, owned.providerSession, input); }
    catch (error) {
      if (error instanceof RemoteDispatchError) throw error;
      throw new RemoteDispatchError('unknown', 'remote-desktop.provider-exception');
    }
    const outcome = snapshotOutcome(raw);
    if (!outcome) throw new RemoteDispatchError('unknown', 'remote-desktop.malformed-provider-result');
    return outcome;
  }

  private requireOwned(connection: RemoteSessionConnection): OwnedSession {
    const owned = this.owned.get(connection.sessionId);
    if (!owned || owned.connection.remoteHostId !== connection.remoteHostId) throw new Error('unknown remote desktop session');
    return owned;
  }
}
