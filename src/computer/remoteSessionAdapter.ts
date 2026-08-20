import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEnvironmentAdapter,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
  ComputerSurfaceRef,
} from './environmentAdapter.js';

export const REMOTE_PROTOCOL_KINDS = ['ssh', 'rdp', 'vnc'] as const;
export type RemoteProtocolKind = typeof REMOTE_PROTOCOL_KINDS[number];
export type RemoteConnectionLifecycle = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface RemoteEndpointIdentity {
  /** Caller-supplied opaque identity. It must uniquely identify the intended host endpoint. */
  endpointId: string;
  protocol: RemoteProtocolKind;
  host: string;
  port: number;
}

/** Opaque reference only. Implementations may resolve it inside a trusted credential boundary. */
export interface RemoteSecretHandle {
  readonly kind: 'secret-handle';
  readonly handleId: string;
}

export interface RemoteSessionConnection {
  sessionId: string;
  /** Backend-observed identity for the peer actually reached. */
  remoteHostId: string;
  capabilities: readonly string[];
}

export interface RemoteSessionAuthority {
  endpointId: string;
  remoteHostId: string;
  sessionId: string;
  generation: number;
}

export interface RemoteMetadataItem {
  key: string;
  value: string;
}

export interface RemoteDisplayFrame {
  width: number;
  height: number;
  format: 'synthetic-rgba' | 'synthetic-png';
  /** Synthetic/test transports may provide bytes. Production backends can use a bounded opaque frame token instead. */
  bytes?: Uint8Array;
  frameId?: string;
}

export interface RemoteVisualInput {
  kind: 'pointer' | 'key' | 'text';
  x?: number;
  y?: number;
  key?: string;
  text?: string;
}

export interface RemoteCommandInvocation {
  command: string;
  args?: readonly string[];
}

export interface RemoteCommandResult {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}

export class RemoteDispatchError extends Error {
  constructor(readonly dispatch: 'not-dispatched' | 'unknown', readonly evidence: string) {
    super(evidence);
    this.name = 'RemoteDispatchError';
  }
}

export type RemoteDispatchOutcome<T> =
  | { dispatch: 'not-dispatched'; status: 'failed'; evidence: string }
  | { dispatch: 'dispatched-once'; status: 'completed'; value?: T; evidence?: string }
  | { dispatch: 'unknown'; status: 'unknown'; evidence: string };

export interface RemoteSessionBackend {
  readonly protocol: RemoteProtocolKind;
  connect(endpoint: RemoteEndpointIdentity, credential?: RemoteSecretHandle): Promise<RemoteSessionConnection>;
  disconnect(connection: RemoteSessionConnection): Promise<void>;
  observeMetadata(connection: RemoteSessionConnection, limits: { maxItems: number; maxTextBytes: number }): Promise<readonly RemoteMetadataItem[]>;
  captureDisplay?(connection: RemoteSessionConnection): Promise<RemoteDisplayFrame>;
  sendVisualInput?(connection: RemoteSessionConnection, input: RemoteVisualInput): Promise<RemoteDispatchOutcome<void>>;
  executeRemoteCommand?(connection: RemoteSessionConnection, invocation: RemoteCommandInvocation): Promise<RemoteDispatchOutcome<RemoteCommandResult>>;
}

const MAX_CAPABILITIES = 64;
const MAX_METADATA_ITEMS = 64;
const MAX_METADATA_TEXT_BYTES = 16_384;
const MAX_ID_BYTES = 256;
const MAX_HOST_BYTES = 512;
const REMOTE_CAPABILITY_PATTERN = /^remote\.(session\.observe|metadata\.observe|display\.observe|visual\.input|ssh\.execute)$/;

function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function bounded(value: string, max = MAX_ID_BYTES): boolean {
  return value.length > 0 && utf8Bytes(value) <= max && !/[\r\n\0]/.test(value);
}
function validEndpoint(endpoint: RemoteEndpointIdentity): boolean {
  return bounded(endpoint.endpointId) && REMOTE_PROTOCOL_KINDS.includes(endpoint.protocol) && bounded(endpoint.host, MAX_HOST_BYTES) &&
    Number.isSafeInteger(endpoint.port) && endpoint.port >= 1 && endpoint.port <= 65535;
}
function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}
function isAuthority(value: unknown): value is RemoteSessionAuthority {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<RemoteSessionAuthority>;
  return bounded(v.endpointId ?? '') && bounded(v.remoteHostId ?? '') && bounded(v.sessionId ?? '') &&
    Number.isSafeInteger(v.generation) && (v.generation ?? -1) >= 0;
}
function payloadObject(payload: unknown): Record<string, unknown> | undefined {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
}
function safeCapabilities(values: readonly string[]): readonly string[] {
  const unique: string[] = [];
  for (const value of values) {
    if (unique.length >= MAX_CAPABILITIES) break;
    if (REMOTE_CAPABILITY_PATTERN.test(value) && !unique.includes(value)) unique.push(value);
  }
  return Object.freeze(unique);
}
function safeMetadata(items: readonly RemoteMetadataItem[], maxItems: number, maxTextBytes: number): { items: RemoteMetadataItem[]; truncated: boolean } {
  const out: RemoteMetadataItem[] = [];
  let bytes = 0;
  let truncated = items.length > maxItems;
  for (const item of items.slice(0, maxItems)) {
    if (!bounded(item.key, 128)) { truncated = true; continue; }
    const itemBytes = utf8Bytes(item.key) + utf8Bytes(item.value);
    if (bytes + itemBytes > maxTextBytes) { truncated = true; break; }
    out.push({ key: item.key, value: item.value });
    bytes += itemBytes;
  }
  return { items: out, truncated };
}

export class RemoteSessionAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  private lifecycle: RemoteConnectionLifecycle = 'disconnected';
  private connection?: RemoteSessionConnection;
  private generation = 0;
  private sequence = 0;
  private discoveredCapabilities: readonly string[] = [];

  constructor(
    readonly adapterId: string,
    readonly endpoint: RemoteEndpointIdentity,
    private readonly backend: RemoteSessionBackend,
  ) {
    if (!bounded(adapterId) || !validEndpoint(endpoint) || backend.protocol !== endpoint.protocol) {
      throw new Error('invalid remote-session adapter configuration');
    }
    this.descriptor = Object.freeze({
      id: adapterId,
      kind: 'remote-session' as const,
      version: '0.1.0',
      capabilities: Object.freeze([
        'remote.session.observe', 'remote.metadata.observe',
        ...(endpoint.protocol === 'ssh' ? ['remote.ssh.execute'] : ['remote.display.observe', 'remote.visual.input']),
      ]),
    });
  }

  state(): Readonly<{ lifecycle: RemoteConnectionLifecycle; endpoint: RemoteEndpointIdentity; authority?: RemoteSessionAuthority; capabilities: readonly string[] }> {
    return Object.freeze({
      lifecycle: this.lifecycle,
      endpoint: Object.freeze({ ...this.endpoint }),
      authority: this.connection ? Object.freeze(this.currentAuthority()) : undefined,
      capabilities: this.discoveredCapabilities,
    });
  }

  async connect(credential?: RemoteSecretHandle): Promise<RemoteSessionAuthority> {
    if (credential && (credential.kind !== 'secret-handle' || !bounded(credential.handleId))) throw new Error('invalid secret handle');
    this.lifecycle = this.connection ? 'reconnecting' : 'connecting';
    const prior = this.connection;
    try {
      const connection = await this.backend.connect(this.endpoint, credential);
      if (!bounded(connection.sessionId) || !bounded(connection.remoteHostId)) throw new Error('invalid remote identity');
      if (prior) await this.backend.disconnect(prior).catch(() => undefined);
      this.connection = Object.freeze({ ...connection, capabilities: safeCapabilities(connection.capabilities) });
      this.generation += 1;
      this.discoveredCapabilities = safeCapabilities(connection.capabilities);
      this.lifecycle = 'connected';
      return Object.freeze(this.currentAuthority());
    } catch (error) {
      this.connection = undefined;
      this.discoveredCapabilities = [];
      this.lifecycle = 'failed';
      throw error;
    }
  }

  async reconnect(credential?: RemoteSecretHandle): Promise<RemoteSessionAuthority> { return this.connect(credential); }

  async disconnect(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.discoveredCapabilities = [];
    this.lifecycle = 'disconnected';
    if (connection) await this.backend.disconnect(connection);
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    this.assertRequestAdapter(request.adapterId);
    const base = { adapterId: this.adapterId, environment: 'remote-session' as const, channel: request.channel, sequence: ++this.sequence };
    if (request.channel === 'network') {
      return { ...base, complete: true, truncated: false, data: this.state() };
    }
    const connection = this.requireConnection();
    this.assertSurfaceAuthority(request.surface);
    if (request.channel === 'terminal' && this.endpoint.protocol === 'ssh') {
      const maxItems = clampLimit(request.limits?.maxItems, 16, MAX_METADATA_ITEMS);
      const maxTextBytes = clampLimit(request.limits?.maxTextBytes, 4096, MAX_METADATA_TEXT_BYTES);
      const boundedMetadata = safeMetadata(await this.backend.observeMetadata(connection, { maxItems, maxTextBytes }), maxItems, maxTextBytes);
      return { ...base, complete: !boundedMetadata.truncated, truncated: boundedMetadata.truncated, surface: this.surfaceRef(), data: { metadata: boundedMetadata.items } };
    }
    if (request.channel === 'visual' && (this.endpoint.protocol === 'rdp' || this.endpoint.protocol === 'vnc') && this.backend.captureDisplay) {
      const frame = await this.backend.captureDisplay(connection);
      return { ...base, complete: true, truncated: false, surface: this.surfaceRef(), data: frame };
    }
    throw new Error('observation channel unsupported for remote protocol');
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    if (request.adapterId !== this.adapterId) return this.reject('remote-adapter-mismatch');
    if (request.effect !== 'remote-execution') return this.reject('remote-effect-required');
    const connection = this.connection;
    if (!connection || this.lifecycle !== 'connected') return this.reject('remote-session-not-connected');
    const payload = payloadObject(request.payload);
    const authority = payload?.authority;
    if (!isAuthority(authority)) return this.reject('remote-authority-required');
    const authorityError = this.authorityError(authority);
    if (authorityError) return this.reject(authorityError);

    if (request.capability === 'remote.ssh.execute') {
      if (this.endpoint.protocol !== 'ssh' || !this.backend.executeRemoteCommand) return this.unsupported('remote-ssh-unavailable');
      const invocation = payload?.invocation;
      if (!invocation || typeof invocation !== 'object' || typeof (invocation as RemoteCommandInvocation).command !== 'string') return this.reject('remote-command-invalid');
      try {
        return this.fromDispatch(await this.backend.executeRemoteCommand(connection, invocation as RemoteCommandInvocation));
      } catch (error) {
        return this.transportFailure(error);
      }
    }
    if (request.capability === 'remote.visual.input') {
      if ((this.endpoint.protocol !== 'rdp' && this.endpoint.protocol !== 'vnc') || !this.backend.sendVisualInput) return this.unsupported('remote-visual-input-unavailable');
      const input = payload?.input;
      if (!input || typeof input !== 'object') return this.reject('remote-input-invalid');
      let mapped: ComputerActionResult;
      try {
        mapped = this.fromDispatch(await this.backend.sendVisualInput(connection, input as RemoteVisualInput));
      } catch (error) {
        mapped = this.transportFailure(error);
      }
      if (mapped.status === 'completed') {
        // Transport acceptance / changed pixels cannot prove an application-level side effect.
        return { ...mapped, verification: 'unverified', evidence: [...(mapped.evidence ?? []), 'remote-visual-effect-unverified'] };
      }
      return mapped;
    }
    return this.unsupported('remote-capability-unsupported');
  }

  private currentAuthority(): RemoteSessionAuthority {
    const connection = this.requireConnection();
    return { endpointId: this.endpoint.endpointId, remoteHostId: connection.remoteHostId, sessionId: connection.sessionId, generation: this.generation };
  }
  private surfaceRef(): ComputerSurfaceRef {
    const connection = this.requireConnection();
    return { adapterId: this.adapterId, environment: 'remote-session', surfaceId: connection.sessionId, generation: this.generation, parentSurfaceId: connection.remoteHostId };
  }
  private requireConnection(): RemoteSessionConnection {
    if (!this.connection || this.lifecycle !== 'connected') throw new Error('remote session is not connected');
    return this.connection;
  }
  private assertRequestAdapter(adapterId: string): void { if (adapterId !== this.adapterId) throw new Error('remote adapter mismatch'); }
  private assertSurfaceAuthority(surface: ComputerSurfaceRef | undefined): void {
    if (!surface) return;
    const current = this.surfaceRef();
    if (surface.adapterId !== current.adapterId || surface.environment !== current.environment || surface.surfaceId !== current.surfaceId || surface.generation !== current.generation || surface.parentSurfaceId !== current.parentSurfaceId) {
      throw new Error('stale or mismatched remote surface');
    }
  }
  private authorityError(authority: RemoteSessionAuthority): string | undefined {
    const current = this.currentAuthority();
    if (authority.endpointId !== current.endpointId || authority.remoteHostId !== current.remoteHostId) return 'remote-host-mismatch';
    if (authority.sessionId !== current.sessionId) return 'remote-session-replaced';
    if (authority.generation !== current.generation) return 'remote-session-stale-generation';
    return undefined;
  }
  private reject(evidence: string): ComputerActionResult { return { status: 'rejected', dispatch: 'not-dispatched', verification: 'unverified', evidence: [evidence] }; }
  private unsupported(evidence: string): ComputerActionResult { return { status: 'unsupported', dispatch: 'not-dispatched', verification: 'unverified', evidence: [evidence] }; }
  private transportFailure(error: unknown): ComputerActionResult {
    if (error instanceof RemoteDispatchError && error.dispatch === 'not-dispatched') {
      return { status: 'failed', dispatch: 'not-dispatched', verification: 'unverified', evidence: [error.evidence] };
    }
    const evidence = error instanceof RemoteDispatchError ? error.evidence : 'remote-transport-failure-ambiguous';
    return { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: [evidence] };
  }
  private fromDispatch<T>(result: RemoteDispatchOutcome<T>): ComputerActionResult {
    if (result.dispatch === 'not-dispatched') return { status: 'failed', dispatch: 'not-dispatched', verification: 'unverified', evidence: [result.evidence] };
    if (result.dispatch === 'unknown') return { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: [result.evidence] };
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'not-applicable', evidence: result.evidence ? [result.evidence] : undefined, details: result.value };
  }
}
