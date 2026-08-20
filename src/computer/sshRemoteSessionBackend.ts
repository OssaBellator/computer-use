import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  RemoteCommandInvocation,
  RemoteCommandResult,
  RemoteDispatchOutcome,
  RemoteEndpointIdentity,
  RemoteMetadataItem,
  RemoteSecretHandle,
  RemoteSessionBackend,
  RemoteSessionConnection,
} from './remoteSessionAdapter.js';
import { RemoteDispatchError } from './remoteSessionAdapter.js';

export interface SshCredentialMaterial {
  readonly identityFile?: string;
  readonly certificateFile?: string;
  readonly agentSocket?: string;
}

export interface SshCredentialResolver {
  resolve(handle: RemoteSecretHandle): Promise<SshCredentialMaterial>;
}

export interface SshProviderConnectRequest {
  readonly endpoint: RemoteEndpointIdentity;
  readonly credential?: SshCredentialMaterial;
}

export interface SshProviderSession {
  readonly providerSessionId: string;
  readonly remoteHostId: string;
}

export interface SshProviderExecLimits {
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

export interface SshTransportProvider {
  connect(request: SshProviderConnectRequest): Promise<SshProviderSession>;
  disconnect(session: SshProviderSession): Promise<void>;
  executeArgv(session: SshProviderSession, invocation: RemoteCommandInvocation, limits: SshProviderExecLimits): Promise<RemoteDispatchOutcome<RemoteCommandResult>>;
  observeMetadata?(session: SshProviderSession, limits: { readonly maxItems: number; readonly maxTextBytes: number }): Promise<readonly RemoteMetadataItem[]>;
}

const MAX_PATH_BYTES = 4096;
const MAX_PROVIDER_ID_BYTES = 256;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_METADATA_ITEMS = 64;
const MAX_METADATA_TEXT_BYTES = 16_384;
const MAX_COMMAND_BYTES = 4096;
const MAX_COMMAND_ARGS = 128;
const MAX_COMMAND_ARG_BYTES = 4096;
const MAX_COMMAND_TOTAL_BYTES = 65_536;

function byteLength(value: string): number { return Buffer.byteLength(value, 'utf8'); }
function finiteString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && byteLength(value) <= max && !/[\0\r\n]/.test(value);
}
function safePath(value: unknown): value is string { return finiteString(value, MAX_PATH_BYTES); }
function snapshotCredentialMaterial(value: unknown): Readonly<SshCredentialMaterial> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const record = value as Record<string, unknown>;
  const out: SshCredentialMaterial = {};
  for (const key of ['identityFile', 'certificateFile', 'agentSocket'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) continue;
    if (!('value' in descriptor) || !safePath(descriptor.value)) return undefined;
    out[key] = descriptor.value;
  }
  return Object.freeze(out);
}
function snapshotInvocation(value: RemoteCommandInvocation): Readonly<RemoteCommandInvocation> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const commandDescriptor = Object.getOwnPropertyDescriptor(value, 'command');
  const argsDescriptor = Object.getOwnPropertyDescriptor(value, 'args');
  if (!commandDescriptor || !('value' in commandDescriptor) || !finiteString(commandDescriptor.value, MAX_COMMAND_BYTES)) return undefined;
  const command = commandDescriptor.value;
  const argsValue = argsDescriptor && 'value' in argsDescriptor ? argsDescriptor.value : undefined;
  if (argsValue !== undefined && !Array.isArray(argsValue)) return undefined;
  const args: string[] = [];
  if (argsValue !== undefined) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(argsValue, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > MAX_COMMAND_ARGS) return undefined;
    for (let index = 0; index < lengthDescriptor.value; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(argsValue, String(index));
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string' || byteLength(descriptor.value) > MAX_COMMAND_ARG_BYTES || descriptor.value.includes('\0')) return undefined;
      args.push(descriptor.value);
    }
  }
  let total = byteLength(command);
  for (const arg of args) total += byteLength(arg);
  if (total > MAX_COMMAND_TOTAL_BYTES) return undefined;
  return Object.freeze({ command, args: Object.freeze(args) });
}
function snapshotProviderSession(value: unknown): Readonly<SshProviderSession> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const providerSessionId = Object.getOwnPropertyDescriptor(value, 'providerSessionId');
  const remoteHostId = Object.getOwnPropertyDescriptor(value, 'remoteHostId');
  if (!providerSessionId || !remoteHostId || !('value' in providerSessionId) || !('value' in remoteHostId)) return undefined;
  if (!finiteString(providerSessionId.value, MAX_PROVIDER_ID_BYTES) || !finiteString(remoteHostId.value, MAX_PROVIDER_ID_BYTES)) return undefined;
  return Object.freeze({ providerSessionId: providerSessionId.value, remoteHostId: remoteHostId.value });
}
function snapshotOutcome(value: unknown): RemoteDispatchOutcome<RemoteCommandResult> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const dispatch = Object.getOwnPropertyDescriptor(record, 'dispatch');
  const status = Object.getOwnPropertyDescriptor(record, 'status');
  const evidence = Object.getOwnPropertyDescriptor(record, 'evidence');
  const result = Object.getOwnPropertyDescriptor(record, 'value');
  if (!dispatch || !status || !('value' in dispatch) || !('value' in status)) return undefined;
  if (dispatch.value === 'not-dispatched' && status.value === 'failed' && evidence && 'value' in evidence && finiteString(evidence.value, 128)) {
    return Object.freeze({ dispatch: 'not-dispatched', status: 'failed', evidence: evidence.value });
  }
  if (dispatch.value === 'unknown' && status.value === 'unknown' && evidence && 'value' in evidence && finiteString(evidence.value, 128)) {
    return Object.freeze({ dispatch: 'unknown', status: 'unknown', evidence: evidence.value });
  }
  if (dispatch.value !== 'dispatched-once' || status.value !== 'completed') return undefined;
  if (!result || !('value' in result) || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) return undefined;
  const resultRecord = result.value as Record<string, unknown>;
  const exitCode = Object.getOwnPropertyDescriptor(resultRecord, 'exitCode');
  const stdout = Object.getOwnPropertyDescriptor(resultRecord, 'stdout');
  const stderr = Object.getOwnPropertyDescriptor(resultRecord, 'stderr');
  const stdoutTruncated = Object.getOwnPropertyDescriptor(resultRecord, 'stdoutTruncated');
  const stderrTruncated = Object.getOwnPropertyDescriptor(resultRecord, 'stderrTruncated');
  if (!exitCode || !('value' in exitCode) || !(exitCode.value === null || (Number.isSafeInteger(exitCode.value) && (exitCode.value as number) >= 0 && (exitCode.value as number) <= 255))) return undefined;
  if (stdout && (!('value' in stdout) || typeof stdout.value !== 'string' || byteLength(stdout.value) > MAX_OUTPUT_BYTES)) return undefined;
  if (stderr && (!('value' in stderr) || typeof stderr.value !== 'string' || byteLength(stderr.value) > MAX_OUTPUT_BYTES)) return undefined;
  if (stdoutTruncated && (!('value' in stdoutTruncated) || typeof stdoutTruncated.value !== 'boolean')) return undefined;
  if (stderrTruncated && (!('value' in stderrTruncated) || typeof stderrTruncated.value !== 'boolean')) return undefined;
  return Object.freeze({
    dispatch: 'dispatched-once', status: 'completed',
    value: Object.freeze({
      exitCode: exitCode.value as number | null,
      ...(stdout ? { stdout: stdout.value as string } : {}),
      ...(stderr ? { stderr: stderr.value as string } : {}),
      ...(stdoutTruncated ? { stdoutTruncated: stdoutTruncated.value as boolean } : {}),
      ...(stderrTruncated ? { stderrTruncated: stderrTruncated.value as boolean } : {}),
    }),
  });
}

interface OwnedSession {
  readonly connection: Readonly<RemoteSessionConnection>;
  readonly providerSession: Readonly<SshProviderSession>;
}

export class SshRemoteSessionBackend implements RemoteSessionBackend {
  readonly protocol = 'ssh' as const;
  private readonly owned = new Map<string, OwnedSession>();
  private readonly rawCandidates = new WeakMap<object, OwnedSession>();

  constructor(private readonly provider: SshTransportProvider, private readonly credentials?: SshCredentialResolver) {}

  async connect(endpoint: RemoteEndpointIdentity, credential?: RemoteSecretHandle): Promise<RemoteSessionConnection> {
    let material: Readonly<SshCredentialMaterial> | undefined;
    if (credential) {
      if (!this.credentials) throw new Error('ssh credential resolver unavailable');
      material = snapshotCredentialMaterial(await this.credentials.resolve(credential));
      if (!material) throw new Error('invalid ssh credential material');
    }
    const providerCandidate = await this.provider.connect(Object.freeze({ endpoint, ...(material ? { credential: material } : {}) }));
    const providerSession = snapshotProviderSession(providerCandidate);
    if (!providerSession) {
      try { await this.provider.disconnect(providerCandidate as SshProviderSession); } catch { throw new Error('invalid ssh provider session; cleanup failed'); }
      throw new Error('invalid ssh provider session');
    }
    const sessionId = `ssh-${randomUUID()}`;
    const connection = Object.freeze({ sessionId, remoteHostId: providerSession.remoteHostId, capabilities: Object.freeze(['remote.session.observe', 'remote.metadata.observe', 'remote.ssh.execute']) });
    const owned = Object.freeze({ connection, providerSession });
    this.owned.set(sessionId, owned);
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
    const owned = this.owned.get(connection.sessionId);
    if (!owned) throw new Error('unknown ssh session');
    this.owned.delete(connection.sessionId);
    await this.provider.disconnect(owned.providerSession);
  }

  async observeMetadata(connection: RemoteSessionConnection, limits: { maxItems: number; maxTextBytes: number }): Promise<readonly RemoteMetadataItem[]> {
    const owned = this.requireOwned(connection);
    const boundedLimits = Object.freeze({ maxItems: Math.min(limits.maxItems, MAX_METADATA_ITEMS), maxTextBytes: Math.min(limits.maxTextBytes, MAX_METADATA_TEXT_BYTES) });
    if (!this.provider.observeMetadata) return Object.freeze([
      Object.freeze({ key: 'transport', value: 'ssh' }),
      Object.freeze({ key: 'remoteHostId', value: owned.providerSession.remoteHostId }),
    ].slice(0, boundedLimits.maxItems));
    const result = await this.provider.observeMetadata(owned.providerSession, boundedLimits);
    if (!Array.isArray(result) || result.length > boundedLimits.maxItems) throw new Error('invalid ssh metadata result');
    let bytes = 0;
    const out: Readonly<RemoteMetadataItem>[] = [];
    for (let index = 0; index < result.length; index++) {
      const item = result[index];
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid ssh metadata result');
      const key = Object.getOwnPropertyDescriptor(item, 'key');
      const value = Object.getOwnPropertyDescriptor(item, 'value');
      if (!key || !value || !('value' in key) || !('value' in value) || typeof key.value !== 'string' || typeof value.value !== 'string') throw new Error('invalid ssh metadata result');
      bytes += byteLength(key.value) + byteLength(value.value);
      if (bytes > boundedLimits.maxTextBytes) throw new Error('ssh metadata acquisition bound exceeded');
      out.push(Object.freeze({ key: key.value, value: value.value }));
    }
    return Object.freeze(out);
  }

  async executeRemoteCommand(connection: RemoteSessionConnection, invocation: RemoteCommandInvocation): Promise<RemoteDispatchOutcome<RemoteCommandResult>> {
    const owned = this.requireOwned(connection);
    const safeInvocation = snapshotInvocation(invocation);
    if (!safeInvocation) return Object.freeze({ dispatch: 'not-dispatched', status: 'failed', evidence: 'ssh.invalid-argv' });
    let raw: unknown;
    try {
      raw = await this.provider.executeArgv(owned.providerSession, safeInvocation, Object.freeze({ maxStdoutBytes: MAX_OUTPUT_BYTES, maxStderrBytes: MAX_OUTPUT_BYTES }));
    } catch (error) {
      if (error instanceof RemoteDispatchError) throw error;
      throw new RemoteDispatchError('unknown', 'ssh.provider-exception');
    }
    const outcome = snapshotOutcome(raw);
    if (!outcome) throw new RemoteDispatchError('unknown', 'ssh.malformed-provider-result');
    return outcome;
  }

  private requireOwned(connection: RemoteSessionConnection): OwnedSession {
    const owned = this.owned.get(connection.sessionId);
    if (!owned || owned.connection.remoteHostId !== connection.remoteHostId) throw new Error('unknown ssh session');
    return owned;
  }
}

export interface OpenSshProcessProviderOptions {
  readonly executable?: string;
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly knownHostsFile?: string;
  readonly strictHostKeyChecking?: 'yes' | 'accept-new';
}

interface OpenSshOwnedSession extends SshProviderSession {
  readonly endpoint: RemoteEndpointIdentity;
  readonly controlDirectory: string;
  readonly controlPath: string;
  readonly credential?: Readonly<SshCredentialMaterial>;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function remoteArgvCommand(invocation: RemoteCommandInvocation): string {
  return [invocation.command, ...(invocation.args ?? [])].map(shellQuote).join(' ');
}

export class OpenSshProcessProvider implements SshTransportProvider {
  private readonly sessions = new Map<string, OpenSshOwnedSession>();
  private readonly executable: string;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly knownHostsFile?: string;
  private readonly strictHostKeyChecking: 'yes' | 'accept-new';

  constructor(options: OpenSshProcessProviderOptions = {}) {
    this.executable = options.executable ?? 'ssh';
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 60_000;
    this.knownHostsFile = options.knownHostsFile;
    this.strictHostKeyChecking = options.strictHostKeyChecking ?? 'yes';
  }

  async connect(request: SshProviderConnectRequest): Promise<SshProviderSession> {
    const controlDirectory = await mkdtemp(join(tmpdir(), 'computer-use-ssh-'));
    const controlPath = join(controlDirectory, 'control.sock');
    const providerSessionId = randomUUID();
    const owned: OpenSshOwnedSession = Object.freeze({ providerSessionId, remoteHostId: request.endpoint.endpointId, endpoint: request.endpoint, controlDirectory, controlPath, credential: request.credential });
    try {
      const argv = [...this.baseArgs(owned), '-o', 'ControlMaster=yes', '-o', 'ControlPersist=no', '-S', controlPath, '-N', '-f', '--', request.endpoint.host];
      const result = await runBoundedProcess(this.executable, argv, this.connectTimeoutMs, 4096, 4096);
      if (!result.spawned || result.error) throw new Error('ssh connect launch failed');
      if (result.timedOut || result.exitCode !== 0) throw new Error('ssh connect failed');
      this.sessions.set(providerSessionId, owned);
      return Object.freeze({ providerSessionId, remoteHostId: owned.remoteHostId });
    } catch (error) {
      await rm(controlDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async disconnect(session: SshProviderSession): Promise<void> {
    const owned = this.sessions.get(session.providerSessionId);
    if (!owned) throw new Error('unknown openssh session');
    this.sessions.delete(session.providerSessionId);
    let ambiguous = false;
    try {
      const argv = [...this.baseArgs(owned), '-S', owned.controlPath, '-O', 'exit', '--', owned.endpoint.host];
      const result = await runBoundedProcess(this.executable, argv, this.connectTimeoutMs, 4096, 4096);
      ambiguous = !result.spawned || Boolean(result.error) || result.timedOut || result.exitCode !== 0;
    } finally {
      await rm(owned.controlDirectory, { recursive: true, force: true });
    }
    if (ambiguous) throw new Error('ssh disconnect ambiguous');
  }

  async executeArgv(session: SshProviderSession, invocation: RemoteCommandInvocation, limits: SshProviderExecLimits): Promise<RemoteDispatchOutcome<RemoteCommandResult>> {
    const owned = this.sessions.get(session.providerSessionId);
    if (!owned) return Object.freeze({ dispatch: 'not-dispatched', status: 'failed', evidence: 'ssh.session-not-owned' });
    const argv = [...this.baseArgs(owned), '-S', owned.controlPath, '--', owned.endpoint.host, remoteArgvCommand(invocation)];
    const result = await runBoundedProcess(this.executable, argv, this.commandTimeoutMs, limits.maxStdoutBytes, limits.maxStderrBytes);
    if (!result.spawned) return Object.freeze({ dispatch: 'not-dispatched', status: 'failed', evidence: 'ssh.spawn-failed' });
    if (result.error || result.timedOut || result.stdoutExceeded || result.stderrExceeded || result.exitCode === null) {
      return Object.freeze({ dispatch: 'unknown', status: 'unknown', evidence: result.timedOut ? 'ssh.command-timeout' : (result.stdoutExceeded || result.stderrExceeded) ? 'ssh.output-bound' : 'ssh.command-ambiguous' });
    }
    return Object.freeze({ dispatch: 'dispatched-once', status: 'completed', value: Object.freeze({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }) });
  }

  private baseArgs(session: OpenSshOwnedSession): string[] {
    const args = ['-o', 'BatchMode=yes', '-o', `StrictHostKeyChecking=${this.strictHostKeyChecking}`, '-p', String(session.endpoint.port)];
    if (this.knownHostsFile) args.push('-o', `UserKnownHostsFile=${this.knownHostsFile}`);
    if (session.credential?.identityFile) args.push('-i', session.credential.identityFile);
    if (session.credential?.certificateFile) args.push('-o', `CertificateFile=${session.credential.certificateFile}`);
    return args;
  }
}

interface ProcessResult {
  readonly spawned: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutExceeded: boolean;
  readonly stderrExceeded: boolean;
  readonly timedOut: boolean;
  readonly error?: Error;
}

function runBoundedProcess(executable: string, argv: readonly string[], timeoutMs: number, maxStdoutBytes: number, maxStderrBytes: number): Promise<ProcessResult> {
  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(executable, argv, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams; }
    catch (error) { resolve({ spawned: false, exitCode: null, stdout: '', stderr: '', stdoutExceeded: false, stderrExceeded: false, timedOut: false, error: error as Error }); return; }
    let spawned = false, settled = false, timedOut = false, stdoutExceeded = false, stderrExceeded = false;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, processError: Error | undefined;
    const kill = () => { try { child.kill('SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.once('spawn', () => { spawned = true; });
    child.once('error', error => { processError = error; });
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutExceeded) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) { stdoutExceeded = true; kill(); return; }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrExceeded) return;
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxStderrBytes) { stderrExceeded = true; kill(); return; }
      stderr.push(Buffer.from(chunk));
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ spawned, exitCode: typeof code === 'number' ? code : null, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), stdoutExceeded, stderrExceeded, timedOut, ...(processError ? { error: processError } : {}) });
    });
  });
}
