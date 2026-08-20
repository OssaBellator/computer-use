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

/** argv-style invocation: command/args are distinct strings; no shell parsing is implied. */
export interface RemoteCommandInvocation {
  command: string;
  args?: readonly string[];
}

export interface RemoteCommandResult {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  /** Adapter-owned truncation markers. Backends need not set or trust these. */
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
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
const MAX_DISPLAY_DIMENSION = 16_384;
const MAX_DISPLAY_PIXELS = 4_194_304;
const MAX_DISPLAY_BYTES = 16_777_216;
const MAX_COMMAND_BYTES = 4_096;
const MAX_COMMAND_ARGS = 128;
const MAX_COMMAND_ARG_BYTES = 4_096;
const MAX_COMMAND_TOTAL_BYTES = 65_536;
const MAX_COMMAND_OUTPUT_BYTES = 65_536;
const MAX_VISUAL_COORDINATE = 1_000_000;
const MAX_VISUAL_KEY_BYTES = 128;
const MAX_VISUAL_TEXT_BYTES = 4_096;
const MACHINE_EVIDENCE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
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
    if (!bounded(item.key, 128) || typeof item.value !== 'string') { truncated = true; continue; }
    const itemBytes = utf8Bytes(item.key) + utf8Bytes(item.value);
    if (bytes + itemBytes > maxTextBytes) { truncated = true; break; }
    out.push({ key: item.key, value: item.value });
    bytes += itemBytes;
  }
  return { items: out, truncated };
}
function safeDisplayFrame(frame: RemoteDisplayFrame, maxPixels: number, maxBytes: number): { frame: RemoteDisplayFrame; truncated: boolean } {
  if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width < 1 || frame.height < 1 ||
      frame.width > MAX_DISPLAY_DIMENSION || frame.height > MAX_DISPLAY_DIMENSION ||
      (frame.format !== 'synthetic-rgba' && frame.format !== 'synthetic-png') ||
      (frame.frameId !== undefined && !bounded(frame.frameId))) {
    throw new Error('invalid remote display frame');
  }
  const pixels = frame.width * frame.height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_DISPLAY_PIXELS) throw new Error('remote display frame exceeds hard pixel bound');
  const byteLimit = Math.min(maxBytes, MAX_DISPLAY_BYTES);
  const pixelLimit = Math.min(maxPixels, MAX_DISPLAY_PIXELS);
  let truncated = pixels > pixelLimit;
  let bytes: Uint8Array | undefined;
  if (frame.bytes !== undefined) {
    if (!(frame.bytes instanceof Uint8Array)) throw new Error('invalid remote display bytes');
    if (frame.format === 'synthetic-rgba' && frame.bytes.byteLength !== pixels * 4) throw new Error('invalid synthetic rgba byte length');
    if (frame.bytes.byteLength <= byteLimit && pixels <= pixelLimit) bytes = frame.bytes.slice();
    else truncated = true;
  }
  return { frame: { width: frame.width, height: frame.height, format: frame.format, frameId: frame.frameId, ...(bytes ? { bytes } : {}) }, truncated };
}
function validCommandInvocation(value: unknown): value is RemoteCommandInvocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const invocation = value as { command?: unknown; args?: unknown };
  if (typeof invocation.command !== 'string' || !bounded(invocation.command, MAX_COMMAND_BYTES)) return false;
  if (invocation.args === undefined) return true;
  if (!Array.isArray(invocation.args) || invocation.args.length > MAX_COMMAND_ARGS) return false;
  let totalBytes = utf8Bytes(invocation.command);
  for (const arg of invocation.args) {
    if (typeof arg !== 'string' || utf8Bytes(arg) > MAX_COMMAND_ARG_BYTES || /\0/.test(arg)) return false;
    totalBytes += utf8Bytes(arg);
    if (totalBytes > MAX_COMMAND_TOTAL_BYTES) return false;
  }
  return true;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) => key === 'kind' || key in value);
}
function validVisualInput(value: unknown): value is RemoteVisualInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (input.kind === 'pointer') {
    return exactKeys(input, ['kind', 'x', 'y']) && typeof input.x === 'number' && typeof input.y === 'number' &&
      Number.isFinite(input.x) && Number.isFinite(input.y) && input.x >= 0 && input.y >= 0 &&
      input.x <= MAX_VISUAL_COORDINATE && input.y <= MAX_VISUAL_COORDINATE;
  }
  if (input.kind === 'key') {
    return exactKeys(input, ['kind', 'key']) && typeof input.key === 'string' && bounded(input.key, MAX_VISUAL_KEY_BYTES);
  }
  if (input.kind === 'text') {
    return exactKeys(input, ['kind', 'text']) && typeof input.text === 'string' && utf8Bytes(input.text) <= MAX_VISUAL_TEXT_BYTES && !/\0/.test(input.text);
  }
  return false;
}
function safeEvidenceCode(value: unknown): string {
  return typeof value === 'string' && MACHINE_EVIDENCE_PATTERN.test(value) ? value : 'remote-backend-evidence-invalid';
}
function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  let used = 0;
  let out = '';
  for (const char of value) {
    const size = utf8Bytes(char);
    if (used + size > maxBytes) return { value: out, truncated: true };
    out += char;
    used += size;
  }
  return { value: out, truncated: false };
}
function safeCommandResult(value: RemoteCommandResult): RemoteCommandResult {
  if (!value || typeof value !== 'object' || (value.exitCode !== null && !Number.isSafeInteger(value.exitCode))) {
    return { exitCode: null, stdoutTruncated: true, stderrTruncated: true };
  }
  const stdout = typeof value.stdout === 'string' ? truncateUtf8(value.stdout, MAX_COMMAND_OUTPUT_BYTES) : undefined;
  const stderr = typeof value.stderr === 'string' ? truncateUtf8(value.stderr, MAX_COMMAND_OUTPUT_BYTES) : undefined;
  return {
    exitCode: value.exitCode,
    ...(stdout ? { stdout: stdout.value, stdoutTruncated: stdout.truncated || value.stdoutTruncated === true } : {}),
    ...(stderr ? { stderr: stderr.value, stderrTruncated: stderr.truncated || value.stderrTruncated === true } : {}),
  };
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
    const prior = this.connection;
    this.lifecycle = prior ? 'reconnecting' : 'connecting';
    let candidate: RemoteSessionConnection | undefined;
    try {
      candidate = await this.backend.connect(this.endpoint, credential);
      if (!bounded(candidate.sessionId) || !bounded(candidate.remoteHostId) || !Array.isArray(candidate.capabilities)) throw new Error('invalid remote identity');
      const committed = Object.freeze({ ...candidate, capabilities: safeCapabilities(candidate.capabilities) });
      if (prior) {
        try { await this.backend.disconnect(prior); }
        catch (error) {
          await this.backend.disconnect(candidate).catch(() => undefined);
          this.connection = prior;
          this.lifecycle = 'connected';
          throw error;
        }
      }
      this.connection = committed;
      this.generation += 1;
      this.discoveredCapabilities = committed.capabilities;
      this.lifecycle = 'connected';
      return Object.freeze(this.currentAuthority());
    } catch (error) {
      if (candidate && candidate !== prior && this.connection !== candidate) await this.backend.disconnect(candidate).catch(() => undefined);
      if (prior) {
        this.connection = prior;
        this.discoveredCapabilities = safeCapabilities(prior.capabilities);
        this.lifecycle = 'connected';
      } else {
        this.connection = undefined;
        this.discoveredCapabilities = [];
        this.lifecycle = 'failed';
      }
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
      const maxPixels = clampLimit(request.limits?.maxItems, MAX_DISPLAY_PIXELS, MAX_DISPLAY_PIXELS);
      const maxBytes = clampLimit(request.limits?.maxTextBytes, MAX_DISPLAY_BYTES, MAX_DISPLAY_BYTES);
      const boundedFrame = safeDisplayFrame(await this.backend.captureDisplay(connection), maxPixels, maxBytes);
      return { ...base, complete: !boundedFrame.truncated, truncated: boundedFrame.truncated, surface: this.surfaceRef(), data: boundedFrame.frame };
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
      if (!validCommandInvocation(invocation)) return this.reject('remote-command-invalid');
      try {
        return this.fromDispatch(await this.backend.executeRemoteCommand(connection, invocation), safeCommandResult);
      } catch (error) {
        return this.transportFailure(error);
      }
    }
    if (request.capability === 'remote.visual.input') {
      if ((this.endpoint.protocol !== 'rdp' && this.endpoint.protocol !== 'vnc') || !this.backend.sendVisualInput) return this.unsupported('remote-visual-input-unavailable');
      const input = payload?.input;
      if (!validVisualInput(input)) return this.reject('remote-input-invalid');
      let mapped: ComputerActionResult;
      try {
        mapped = this.fromDispatch(await this.backend.sendVisualInput(connection, input));
      } catch (error) {
        mapped = this.transportFailure(error);
      }
      if (mapped.status === 'completed') {
        // Transport acceptance / changed pixels cannot prove an application-level side effect.
        return { ...mapped, status: 'unknown', verification: 'unverified', evidence: [...(mapped.evidence ?? []), 'remote-visual-effect-unverified'] };
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
      return { status: 'failed', dispatch: 'not-dispatched', verification: 'unverified', evidence: [safeEvidenceCode(error.evidence)] };
    }
    const evidence = error instanceof RemoteDispatchError ? safeEvidenceCode(error.evidence) : 'remote-transport-failure-ambiguous';
    return { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: [evidence] };
  }
  private fromDispatch<T>(result: RemoteDispatchOutcome<T>, mapValue?: (value: T) => unknown): ComputerActionResult {
    if (result.dispatch === 'not-dispatched') return { status: 'failed', dispatch: 'not-dispatched', verification: 'unverified', evidence: [safeEvidenceCode(result.evidence)] };
    if (result.dispatch === 'unknown') return { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: [safeEvidenceCode(result.evidence)] };
    const details = result.value === undefined ? undefined : (mapValue ? mapValue(result.value) : result.value);
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'not-applicable', evidence: result.evidence ? [safeEvidenceCode(result.evidence)] : undefined, details };
  }
}
