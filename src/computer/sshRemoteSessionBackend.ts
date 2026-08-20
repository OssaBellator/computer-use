import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
export interface SshCredentialResolver { resolve(handle: RemoteSecretHandle): Promise<SshCredentialMaterial>; }
export interface SshProviderConnectRequest { readonly endpoint: RemoteEndpointIdentity; readonly credential?: SshCredentialMaterial; }
export interface SshProviderSession { readonly providerSessionId: string; readonly remoteHostId: string; }
export interface SshProviderExecLimits { readonly maxStdoutBytes: number; readonly maxStderrBytes: number; }
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
const MAX_PROCESS_TIMEOUT_MS = 300_000;
const MAX_CLEANUP_ACK_TIMEOUT_MS = 5_000;
const DEFAULT_CLEANUP_ACK_TIMEOUT_MS = 1_000;

function bytes(value: string): number { return Buffer.byteLength(value, 'utf8'); }
function finiteString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && bytes(value) <= max && !/[\0\r\n]/.test(value);
}
function finiteTimeout(value: number | undefined, fallback: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max) throw new Error('invalid ssh process timeout');
  return resolved;
}
function ownData(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function snapshotCredentialMaterial(value: unknown): Readonly<SshCredentialMaterial> | undefined {
  if (!plainRecord(value)) return undefined;
  const out: { identityFile?: string; certificateFile?: string; agentSocket?: string } = {};
  for (const key of ['identityFile', 'certificateFile', 'agentSocket'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!('value' in descriptor) || !finiteString(descriptor.value, MAX_PATH_BYTES)) return undefined;
    out[key] = descriptor.value;
  }
  return Object.freeze(out);
}
function snapshotStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = ownData(value, 'length');
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > MAX_COMMAND_ARGS) return undefined;
  const out: string[] = [];
  for (let index = 0; index < (length as number); index++) {
    const item = ownData(value, String(index));
    if (typeof item !== 'string' || bytes(item) > MAX_COMMAND_ARG_BYTES || item.includes('\0')) return undefined;
    out.push(item);
  }
  return Object.freeze(out);
}
function snapshotInvocation(value: unknown): Readonly<RemoteCommandInvocation> | undefined {
  if (!plainRecord(value)) return undefined;
  const command = ownData(value, 'command');
  const rawArgs = ownData(value, 'args');
  if (!finiteString(command, MAX_COMMAND_BYTES)) return undefined;
  const args = rawArgs === undefined ? Object.freeze([] as string[]) : snapshotStringArray(rawArgs);
  if (!args) return undefined;
  let total = bytes(command);
  for (const arg of args) total += bytes(arg);
  if (total > MAX_COMMAND_TOTAL_BYTES) return undefined;
  return Object.freeze({ command, args });
}
function snapshotProviderSession(value: unknown): Readonly<SshProviderSession> | undefined {
  if (!plainRecord(value)) return undefined;
  const providerSessionId = ownData(value, 'providerSessionId');
  const remoteHostId = ownData(value, 'remoteHostId');
  if (!finiteString(providerSessionId, MAX_PROVIDER_ID_BYTES) || !finiteString(remoteHostId, MAX_PROVIDER_ID_BYTES)) return undefined;
  return Object.freeze({ providerSessionId, remoteHostId });
}
function snapshotOutcome(value: unknown): RemoteDispatchOutcome<RemoteCommandResult> | undefined {
  if (!plainRecord(value)) return undefined;
  const dispatch = ownData(value, 'dispatch');
  const status = ownData(value, 'status');
  const evidence = ownData(value, 'evidence');
  if (dispatch === 'not-dispatched' && status === 'failed' && finiteString(evidence, 128)) {
    return Object.freeze({ dispatch, status, evidence });
  }
  if (dispatch === 'unknown' && status === 'unknown' && finiteString(evidence, 128)) {
    return Object.freeze({ dispatch, status, evidence });
  }
  if (dispatch !== 'dispatched-once' || status !== 'completed') return undefined;
  const result = ownData(value, 'value');
  if (!plainRecord(result)) return undefined;
  const exitCode = ownData(result, 'exitCode');
  const stdout = ownData(result, 'stdout');
  const stderr = ownData(result, 'stderr');
  const stdoutTruncated = ownData(result, 'stdoutTruncated');
  const stderrTruncated = ownData(result, 'stderrTruncated');
  if (!(exitCode === null || (Number.isSafeInteger(exitCode) && (exitCode as number) >= 0 && (exitCode as number) <= 255))) return undefined;
  if (stdout !== undefined && (typeof stdout !== 'string' || bytes(stdout) > MAX_OUTPUT_BYTES)) return undefined;
  if (stderr !== undefined && (typeof stderr !== 'string' || bytes(stderr) > MAX_OUTPUT_BYTES)) return undefined;
  if (stdoutTruncated !== undefined && typeof stdoutTruncated !== 'boolean') return undefined;
  if (stderrTruncated !== undefined && typeof stderrTruncated !== 'boolean') return undefined;
  return Object.freeze({
    dispatch,
    status,
    value: Object.freeze({
      exitCode: exitCode as number | null,
      ...(stdout !== undefined ? { stdout } : {}),
      ...(stderr !== undefined ? { stderr } : {}),
      ...(stdoutTruncated !== undefined ? { stdoutTruncated } : {}),
      ...(stderrTruncated !== undefined ? { stderrTruncated } : {}),
    }),
  }) as RemoteDispatchOutcome<RemoteCommandResult>;
}
function snapshotMetadata(value: unknown, limits: { readonly maxItems: number; readonly maxTextBytes: number }): readonly Readonly<RemoteMetadataItem>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = ownData(value, 'length');
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > limits.maxItems) return undefined;
  let total = 0;
  const out: Readonly<RemoteMetadataItem>[] = [];
  for (let index = 0; index < (length as number); index++) {
    const item = ownData(value, String(index));
    if (!plainRecord(item)) return undefined;
    const key = ownData(item, 'key');
    const itemValue = ownData(item, 'value');
    if (typeof key !== 'string' || typeof itemValue !== 'string') return undefined;
    total += bytes(key) + bytes(itemValue);
    if (total > limits.maxTextBytes) return undefined;
    out.push(Object.freeze({ key, value: itemValue }));
  }
  return Object.freeze(out);
}

interface OwnedSession { readonly connection: Readonly<RemoteSessionConnection>; readonly providerSession: Readonly<SshProviderSession>; }

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
      try { await this.provider.disconnect(providerCandidate); }
      catch { throw new Error('invalid ssh provider session; cleanup failed'); }
      throw new Error('invalid ssh provider session');
    }
    const sessionId = `ssh-${randomUUID()}`;
    const connection = Object.freeze({
      sessionId,
      remoteHostId: providerSession.remoteHostId,
      capabilities: Object.freeze(['remote.session.observe', 'remote.metadata.observe', 'remote.ssh.execute']),
    });
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
    const owned = this.requireOwned(connection);
    this.owned.delete(connection.sessionId);
    await this.provider.disconnect(owned.providerSession);
  }

  async observeMetadata(connection: RemoteSessionConnection, limits: { maxItems: number; maxTextBytes: number }): Promise<readonly RemoteMetadataItem[]> {
    const owned = this.requireOwned(connection);
    const boundedLimits = Object.freeze({
      maxItems: Math.min(limits.maxItems, MAX_METADATA_ITEMS),
      maxTextBytes: Math.min(limits.maxTextBytes, MAX_METADATA_TEXT_BYTES),
    });
    if (!this.provider.observeMetadata) {
      return Object.freeze([
        Object.freeze({ key: 'transport', value: 'ssh' }),
        Object.freeze({ key: 'remoteHostId', value: owned.providerSession.remoteHostId }),
      ].slice(0, boundedLimits.maxItems));
    }
    const result = snapshotMetadata(await this.provider.observeMetadata(owned.providerSession, boundedLimits), boundedLimits);
    if (!result) throw new Error('ssh metadata acquisition bound exceeded');
    return result;
  }

  async executeRemoteCommand(connection: RemoteSessionConnection, invocation: RemoteCommandInvocation): Promise<RemoteDispatchOutcome<RemoteCommandResult>> {
    const owned = this.requireOwned(connection);
    const safeInvocation = snapshotInvocation(invocation);
    if (!safeInvocation) return Object.freeze({ dispatch: 'not-dispatched', status: 'failed', evidence: 'ssh.invalid-argv' });
    let raw: unknown;
    try {
      raw = await this.provider.executeArgv(
        owned.providerSession,
        safeInvocation,
        Object.freeze({ maxStdoutBytes: MAX_OUTPUT_BYTES, maxStderrBytes: MAX_OUTPUT_BYTES }),
      );
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
  readonly cleanupAckTimeoutMs?: number;
  readonly knownHostsFile?: string;
  readonly strictHostKeyChecking?: 'yes' | 'accept-new';
  /** Test/integration seam; defaults to node:child_process.spawn. */
  readonly processSpawner?: typeof spawn;
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
  private readonly cleanupAckTimeoutMs: number;
  private readonly knownHostsFile?: string;
  private readonly strictHostKeyChecking: 'yes' | 'accept-new';
  private readonly processSpawner: typeof spawn;

  constructor(options: OpenSshProcessProviderOptions = {}) {
    this.executable = options.executable ?? 'ssh';
    this.connectTimeoutMs = finiteTimeout(options.connectTimeoutMs, 15_000, MAX_PROCESS_TIMEOUT_MS);
    this.commandTimeoutMs = finiteTimeout(options.commandTimeoutMs, 60_000, MAX_PROCESS_TIMEOUT_MS);
    this.cleanupAckTimeoutMs = finiteTimeout(options.cleanupAckTimeoutMs, DEFAULT_CLEANUP_ACK_TIMEOUT_MS, MAX_CLEANUP_ACK_TIMEOUT_MS);
    this.knownHostsFile = options.knownHostsFile;
    this.strictHostKeyChecking = options.strictHostKeyChecking ?? 'yes';
    this.processSpawner = options.processSpawner ?? spawn;
  }

  async connect(request: SshProviderConnectRequest): Promise<SshProviderSession> {
    const controlDirectory = await mkdtemp(join(tmpdir(), 'computer-use-ssh-'));
    const owned: OpenSshOwnedSession = Object.freeze({
      providerSessionId: randomUUID(),
      remoteHostId: request.endpoint.endpointId,
      endpoint: request.endpoint,
      controlDirectory,
      controlPath: join(controlDirectory, 'control.sock'),
      credential: request.credential,
    });
    const argv = [...this.baseArgs(owned), '-o', 'ControlMaster=yes', '-o', 'ControlPersist=no', '-S', owned.controlPath, '-N', '-f', '--', owned.endpoint.host];
    try {
      const result = await runBoundedProcess(this.executable, argv, this.connectTimeoutMs, 4096, 4096, this.environment(owned), this.cleanupAckTimeoutMs, this.processSpawner);
      if (!result.spawned || result.error || result.timedOut || result.stdoutExceeded || result.stderrExceeded || result.terminationAmbiguous || result.exitCode !== 0) throw new Error('ssh connect ambiguous');
      this.sessions.set(owned.providerSessionId, owned);
      return Object.freeze({ providerSessionId: owned.providerSessionId, remoteHostId: owned.remoteHostId });
    } catch (error) {
      await this.bestEffortControlExit(owned);
      await rm(owned.controlDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async disconnect(session: SshProviderSession): Promise<void> {
    const owned = this.sessions.get(session.providerSessionId);
    if (!owned) throw new Error('unknown openssh session');
    this.sessions.delete(session.providerSessionId);
    let ambiguous = false;
    try {
      const result = await this.controlExit(owned);
      ambiguous = !result.spawned || Boolean(result.error) || result.timedOut || result.stdoutExceeded || result.stderrExceeded || result.terminationAmbiguous || result.exitCode !== 0;
    } finally {
      await rm(owned.controlDirectory, { recursive: true, force: true });
    }
    if (ambiguous) throw new Error('ssh disconnect ambiguous');
  }

  async executeArgv(session: SshProviderSession, invocation: RemoteCommandInvocation, limits: SshProviderExecLimits): Promise<RemoteDispatchOutcome<RemoteCommandResult>> {
    const owned = this.sessions.get(session.providerSessionId);
    if (!owned) return Object.freeze({ dispatch: 'not-dispatched', status: 'failed', evidence: 'ssh.session-not-owned' });
    const argv = [...this.baseArgs(owned), '-S', owned.controlPath, '--', owned.endpoint.host, remoteArgvCommand(invocation)];
    const result = await runBoundedProcess(this.executable, argv, this.commandTimeoutMs, limits.maxStdoutBytes, limits.maxStderrBytes, this.environment(owned), this.cleanupAckTimeoutMs, this.processSpawner);
    if (!result.spawned) return Object.freeze({ dispatch: 'not-dispatched', status: 'failed', evidence: 'ssh.spawn-failed' });
    if (result.error || result.timedOut || result.stdoutExceeded || result.stderrExceeded || result.terminationAmbiguous || result.exitCode === null) {
      return Object.freeze({
        dispatch: 'unknown',
        status: 'unknown',
        evidence: result.timedOut ? 'ssh.command-timeout' : (result.stdoutExceeded || result.stderrExceeded) ? 'ssh.output-bound' : 'ssh.command-ambiguous',
      });
    }
    return Object.freeze({
      dispatch: 'dispatched-once',
      status: 'completed',
      value: Object.freeze({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }),
    });
  }

  private baseArgs(session: OpenSshOwnedSession): string[] {
    const args = ['-o', 'BatchMode=yes', '-o', `StrictHostKeyChecking=${this.strictHostKeyChecking}`, '-p', String(session.endpoint.port)];
    if (this.knownHostsFile) args.push('-o', `UserKnownHostsFile=${this.knownHostsFile}`);
    if (session.credential?.identityFile) args.push('-i', session.credential.identityFile);
    if (session.credential?.certificateFile) args.push('-o', `CertificateFile=${session.credential.certificateFile}`);
    return args;
  }
  private environment(session: OpenSshOwnedSession): Readonly<Record<string, string>> | undefined {
    return session.credential?.agentSocket ? Object.freeze({ SSH_AUTH_SOCK: session.credential.agentSocket }) : undefined;
  }
  private controlExit(session: OpenSshOwnedSession): Promise<ProcessResult> {
    return runBoundedProcess(
      this.executable,
      [...this.baseArgs(session), '-S', session.controlPath, '-O', 'exit', '--', session.endpoint.host],
      this.connectTimeoutMs,
      4096,
      4096,
      this.environment(session),
      this.cleanupAckTimeoutMs,
      this.processSpawner,
    );
  }
  private async bestEffortControlExit(session: OpenSshOwnedSession): Promise<void> {
    try { await this.controlExit(session); } catch {}
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
  readonly terminationRequested: boolean;
  readonly killAccepted?: boolean;
  readonly terminationAmbiguous: boolean;
  readonly error?: Error;
}
function runBoundedProcess(
  executable: string,
  argv: readonly string[],
  timeoutMs: number,
  maxStdoutBytes: number,
  maxStderrBytes: number,
  environment: Readonly<Record<string, string>> | undefined,
  cleanupAckTimeoutMs: number,
  processSpawner: typeof spawn,
): Promise<ProcessResult> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = processSpawner(executable, argv, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: environment ? { ...process.env, ...environment } : process.env,
      });
    } catch (error) {
      resolve({ spawned: false, exitCode: null, stdout: '', stderr: '', stdoutExceeded: false, stderrExceeded: false, timedOut: false, terminationRequested: false, terminationAmbiguous: false, error: error as Error });
      return;
    }
    let spawned = false;
    let timedOut = false;
    let stdoutExceeded = false;
    let stderrExceeded = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let processError: Error | undefined;
    let terminationRequested = false;
    let killAccepted: boolean | undefined;
    let settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, timeoutMs);
    const finish = (exitCode: number | null, terminationAmbiguous: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      resolve({
        spawned,
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdoutExceeded,
        stderrExceeded,
        timedOut,
        terminationRequested,
        ...(killAccepted === undefined ? {} : { killAccepted }),
        terminationAmbiguous,
        ...(processError ? { error: processError } : {}),
      });
    };
    const requestTermination = () => {
      if (terminationRequested || settled) return;
      terminationRequested = true;
      try { killAccepted = child.kill('SIGKILL'); }
      catch { killAccepted = false; }
      cleanupTimer = setTimeout(() => finish(null, true), cleanupAckTimeoutMs);
    };
    child.once('spawn', () => { spawned = true; });
    child.once('error', error => { processError = error; });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutExceeded || settled) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) { stdoutExceeded = true; requestTermination(); return; }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrExceeded || settled) return;
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxStderrBytes) { stderrExceeded = true; requestTermination(); return; }
      stderr.push(Buffer.from(chunk));
    });
    child.once('close', code => finish(typeof code === 'number' ? code : null, false));
  });
}
