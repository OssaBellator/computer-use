import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Readable } from 'node:stream';
import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEffectClass,
  ComputerEntityRef,
  ComputerEnvironmentAdapter,
  ComputerEnvironmentAdapterDescriptor,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from './environmentAdapter.js';
import {
  sameComputerEntity,
  validateComputerActionRequest,
  validateComputerObservationRequest,
} from './environmentAdapter.js';
import { ProcessIdentityStore } from './processAdapter.js';

const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const TIMEOUT_CLEANUP_GRACE_MS = 250;
const MAX_ARGV_ITEMS = 128;
const MAX_ARG_BYTES = 4096;
const MAX_ARGV_BYTES = 32 * 1024;
const MAX_ENV_ITEMS = 64;
const MAX_ENV_VALUE_BYTES = 4096;
const MAX_ENV_BYTES = 16 * 1024;
const MAX_EXECUTABLE_BYTES = 4096;
const MAX_CWD_BYTES = 4096;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export const TERMINAL_COMMAND_CLASSIFICATIONS = [
  'local-compute',
  'filesystem-write',
  'system-configuration',
  'security-sensitive',
  'network-change',
  'remote-execution',
  'package-installation',
  'account-change',
  'unknown',
] as const;

export type TerminalCommandClassification = typeof TERMINAL_COMMAND_CLASSIFICATIONS[number];

interface TerminalExecutionBase {
  cwd: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  classification: TerminalCommandClassification;
}

export interface ArgvExecutionPayload extends TerminalExecutionBase {
  mode: 'argv';
  executable: string;
  argv: readonly string[];
}

export interface ShellExecutionPayload extends TerminalExecutionBase {
  mode: 'shell';
  shellExecutable: string;
  shellArgs: readonly string[];
  command: string;
}

export type TerminalExecutionPayload = ArgvExecutionPayload | ShellExecutionPayload;

export interface TerminalExecutionDetails {
  mode: 'argv' | 'shell';
  process?: ComputerEntityRef;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
}

export interface SpawnedProcessLike {
  pid?: number;
  stdout: Readable | null;
  stderr: Readable | null;
  once(event: string, listener: (...args: any[]) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ProcessSpawner {
  spawn(executable: string, argv: readonly string[], options: SpawnOptions): SpawnedProcessLike;
}

export interface ExecutionPathIdentity {
  realPath: string;
  kind: 'file' | 'directory';
  dev: string;
  ino: string;
  mode: string;
  size?: string;
  mtimeNs?: string;
  birthtimeNs?: string;
  ctimeNs?: string;
}

export interface ExecutionPathBinder {
  bind(path: string, kind: 'file' | 'directory'): Promise<ExecutionPathIdentity | undefined>;
}

export interface TerminalExecutionEffectResolver {
  requiredEffect(payload: Readonly<TerminalExecutionPayload>): ComputerEffectClass | undefined;
}

const defaultSpawner: ProcessSpawner = {
  spawn(executable, argv, options) {
    return spawn(executable, argv, options) as ChildProcess as SpawnedProcessLike;
  },
};

const hostPathBinder: ExecutionPathBinder = {
  async bind(path, kind) {
    try {
      const resolved = await realpath(path);
      const value = await stat(resolved, { bigint: true });
      if (kind === 'file' ? !value.isFile() : !value.isDirectory()) return undefined;
      return {
        realPath: resolved,
        kind,
        dev: value.dev.toString(),
        ino: value.ino.toString(),
        mode: value.mode.toString(),
        ...(kind === 'file' ? { size: value.size.toString(), mtimeNs: value.mtimeNs.toString() } : {}),
        birthtimeNs: value.birthtimeNs.toString(),
        ctimeNs: value.ctimeNs.toString(),
      };
    } catch {
      return undefined;
    }
  },
};

function sameExecutionPath(left: ExecutionPathIdentity, right: ExecutionPathIdentity): boolean {
  return left.realPath === right.realPath &&
    left.kind === right.kind &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs;
}

const conservativeEffectResolver: TerminalExecutionEffectResolver = {
  requiredEffect(payload) {
    return payload.classification === 'remote-execution' ? 'remote-execution' : 'security-sensitive';
  },
};

function isExecutionPayload(value: unknown): value is TerminalExecutionPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<TerminalExecutionPayload>;
  return payload.mode === 'argv' || payload.mode === 'shell';
}

function cloneEnv(value: unknown): Readonly<Record<string, string>> | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.freeze({ ...(value as Record<string, string>) });
}

function snapshotExecutionPayload(value: unknown): TerminalExecutionPayload | undefined {
  if (!isExecutionPayload(value)) return undefined;
  const raw = value as TerminalExecutionPayload;
  const env = cloneEnv(raw.env);
  if (env === null) return undefined;
  if (raw.mode === 'argv') {
    const snapshot: ArgvExecutionPayload = {
      mode: 'argv',
      executable: raw.executable,
      argv: Object.freeze(Array.isArray(raw.argv) ? [...raw.argv] : raw.argv),
      cwd: raw.cwd,
      ...(env === undefined ? {} : { env }),
      ...(raw.timeoutMs === undefined ? {} : { timeoutMs: raw.timeoutMs }),
      ...(raw.maxOutputBytes === undefined ? {} : { maxOutputBytes: raw.maxOutputBytes }),
      classification: raw.classification,
    };
    return Object.freeze(snapshot);
  }
  const snapshot: ShellExecutionPayload = {
    mode: 'shell',
    shellExecutable: raw.shellExecutable,
    shellArgs: Object.freeze(Array.isArray(raw.shellArgs) ? [...raw.shellArgs] : raw.shellArgs),
    command: raw.command,
    cwd: raw.cwd,
    ...(env === undefined ? {} : { env }),
    ...(raw.timeoutMs === undefined ? {} : { timeoutMs: raw.timeoutMs }),
    ...(raw.maxOutputBytes === undefined ? {} : { maxOutputBytes: raw.maxOutputBytes }),
    classification: raw.classification,
  };
  return Object.freeze(snapshot);
}

function validateString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && utf8Bytes(value) <= maxBytes && !value.includes('\0');
}

function validateExecutionPayload(payload: TerminalExecutionPayload): string | undefined {
  if (!validateString(payload.cwd, MAX_CWD_BYTES) || !isAbsolute(payload.cwd)) return 'terminal.cwd.invalid';
  if (!TERMINAL_COMMAND_CLASSIFICATIONS.includes(payload.classification)) return 'terminal.classification.invalid';
  if (payload.mode === 'argv') {
    if (!validateString(payload.executable, MAX_EXECUTABLE_BYTES) || !isAbsolute(payload.executable)) return 'terminal.executable.invalid';
    if (!Array.isArray(payload.argv) || payload.argv.length > MAX_ARGV_ITEMS) return 'terminal.argv.invalid';
    let bytes = 0;
    for (const arg of payload.argv) {
      if (typeof arg !== 'string' || utf8Bytes(arg) > MAX_ARG_BYTES || arg.includes('\0')) return 'terminal.argv.invalid';
      bytes += utf8Bytes(arg);
    }
    if (bytes > MAX_ARGV_BYTES) return 'terminal.argv.invalid';
  } else {
    if (!validateString(payload.shellExecutable, MAX_EXECUTABLE_BYTES) || !isAbsolute(payload.shellExecutable)) return 'terminal.shell.invalid';
    if (!Array.isArray(payload.shellArgs) || payload.shellArgs.length > MAX_ARGV_ITEMS) return 'terminal.shell.invalid';
    if (!validateString(payload.command, MAX_ARGV_BYTES)) return 'terminal.shell.invalid';
    let bytes = utf8Bytes(payload.command);
    for (const arg of payload.shellArgs) {
      if (typeof arg !== 'string' || utf8Bytes(arg) > MAX_ARG_BYTES || arg.includes('\0')) return 'terminal.shell.invalid';
      bytes += utf8Bytes(arg);
    }
    if (bytes > MAX_ARGV_BYTES) return 'terminal.shell.invalid';
  }
  if (payload.timeoutMs !== undefined && (!Number.isSafeInteger(payload.timeoutMs) || payload.timeoutMs < 1 || payload.timeoutMs > MAX_TIMEOUT_MS)) {
    return 'terminal.timeout.invalid';
  }
  if (payload.maxOutputBytes !== undefined && (!Number.isSafeInteger(payload.maxOutputBytes) || payload.maxOutputBytes < 1 || payload.maxOutputBytes > MAX_OUTPUT_BYTES)) {
    return 'terminal.output-limit.invalid';
  }
  const entries = Object.entries(payload.env ?? {});
  if (entries.length > MAX_ENV_ITEMS) return 'terminal.env.invalid';
  let envBytes = 0;
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string' || utf8Bytes(value) > MAX_ENV_VALUE_BYTES || value.includes('\0')) {
      return 'terminal.env.invalid';
    }
    envBytes += utf8Bytes(key) + utf8Bytes(value);
  }
  if (envBytes > MAX_ENV_BYTES) return 'terminal.env.invalid';
  return undefined;
}

class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  add(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.bytes >= this.maxBytes) {
      this.truncated = true;
      return;
    }
    const remaining = this.maxBytes - this.bytes;
    const kept = buffer.subarray(0, remaining);
    if (kept.length > 0) {
      this.chunks.push(kept);
      this.bytes += kept.length;
    }
    if (kept.length < buffer.length) this.truncated = true;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

export class HostTerminalAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor: ComputerEnvironmentAdapterDescriptor;
  private sequence = 0;
  private readonly sessionRef: ComputerEntityRef;

  constructor(
    adapterId: string,
    private readonly identities: ProcessIdentityStore,
    private readonly spawner: ProcessSpawner = defaultSpawner,
    private readonly pathBinder: ExecutionPathBinder = hostPathBinder,
    private readonly effectResolver: TerminalExecutionEffectResolver = conservativeEffectResolver,
    version = '1.0.0',
  ) {
    this.descriptor = {
      id: adapterId,
      kind: 'terminal',
      version,
      capabilities: ['terminal.execute.argv', 'terminal.execute.shell'],
    };
    this.sessionRef = {
      adapterId,
      environment: 'terminal',
      kind: 'terminal-session',
      entityId: 'session:local-exec',
      generation: 0,
    };
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    const sequence = ++this.sequence;
    const invalid = validateComputerObservationRequest(request, this.descriptor);
    const channelValid = invalid.length === 0 && request.channel === 'terminal';
    const targetValid = request.target === undefined || sameComputerEntity(request.target, this.sessionRef);
    const valid = channelValid && targetValid;
    return {
      adapterId: this.descriptor.id,
      environment: 'terminal',
      channel: request.channel,
      sequence,
      complete: valid,
      truncated: false,
      ...(request.target ? { target: request.target } : {}),
      data: valid
        ? { session: this.sessionRef, state: 'ready' }
        : { code: channelValid ? 'terminal.session.stale' : 'terminal.observation.invalid' },
    };
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    const invalid = validateComputerActionRequest(request, this.descriptor);
    if (invalid.length > 0) return this.prelaunchFailure('terminal.action.invalid');
    const capability = request.capability;
    const requestedEffect = request.effect;
    if (capability !== 'terminal.execute.argv' && capability !== 'terminal.execute.shell') {
      return {
        status: 'unsupported',
        dispatch: 'not-dispatched',
        verification: 'not-applicable',
        evidence: ['terminal.capability.unsupported'],
      };
    }

    const payload = snapshotExecutionPayload(request.payload);
    if (!payload) return this.prelaunchFailure('terminal.payload.invalid');
    if ((capability === 'terminal.execute.argv') !== (payload.mode === 'argv')) {
      return this.prelaunchFailure('terminal.mode.mismatch');
    }
    const payloadError = validateExecutionPayload(payload);
    if (payloadError) return this.prelaunchFailure(payloadError);
    const requiredEffect = this.effectResolver.requiredEffect(payload);
    if (!requiredEffect || requestedEffect !== requiredEffect) return this.prelaunchFailure('terminal.effect.mismatch');
    const exitStatusVerifiesDomain = requiredEffect === 'process-execution';

    const executableInput = payload.mode === 'argv' ? payload.executable : payload.shellExecutable;
    const cwdInput = payload.cwd;
    const argv = payload.mode === 'argv' ? [...payload.argv] : [...payload.shellArgs, payload.command];
    const env = { ...(payload.env ?? {}) };
    const outputLimit = payload.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    const timeoutMs = payload.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const mode = payload.mode;

    const preflightExecutable = await this.pathBinder.bind(executableInput, 'file');
    if (!preflightExecutable) return this.prelaunchFailure('terminal.executable.unavailable');
    const preflightCwd = await this.pathBinder.bind(cwdInput, 'directory');
    if (!preflightCwd) return this.prelaunchFailure('terminal.cwd.unavailable');

    const executable = preflightExecutable.realPath;
    const cwd = preflightCwd.realPath;
    const stdout = new BoundedCapture(outputLimit);
    const stderr = new BoundedCapture(outputLimit);
    let child: SpawnedProcessLike;
    let invocationStarted = false;

    const refreshedExecutable = await this.pathBinder.bind(executableInput, 'file');
    const refreshedCwd = await this.pathBinder.bind(cwdInput, 'directory');
    if (!refreshedExecutable || !sameExecutionPath(preflightExecutable, refreshedExecutable)) {
      return this.prelaunchFailure('terminal.executable.replaced');
    }
    if (!refreshedCwd || !sameExecutionPath(preflightCwd, refreshedCwd)) {
      return this.prelaunchFailure('terminal.cwd.replaced');
    }

    try {
      invocationStarted = true;
      child = this.spawner.spawn(executable, argv, {
        cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      return {
        status: 'unknown',
        dispatch: invocationStarted ? 'unknown' : 'not-dispatched',
        verification: 'unverified',
        evidence: ['terminal.launch.ambiguous'],
      };
    }

    if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0) {
      child.once('error', () => {});
      return {
        status: 'unknown',
        dispatch: 'unknown',
        verification: 'unverified',
        evidence: ['terminal.launch.unacknowledged'],
      };
    }

    child.stdout?.on('data', (chunk: Buffer | string) => stdout.add(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.add(chunk));

    type Outcome =
      | { kind: 'close'; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }
      | { kind: 'error'; timedOut: boolean }
      | { kind: 'cleanup-ambiguous'; timedOut: true };

    const outcomePromise = new Promise<Outcome>((resolve) => {
      let settled = false;
      let timedOut = false;
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      let executionTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: Outcome): void => {
        if (settled) return;
        settled = true;
        if (executionTimer) clearTimeout(executionTimer);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        resolve(outcome);
      };
      child.once('error', () => finish({ kind: 'error', timedOut }));
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        finish({ kind: 'close', code, signal, timedOut });
      });
      executionTimer = setTimeout(() => {
        timedOut = true;
        try {
          if (!child.kill('SIGKILL')) {
            finish({ kind: 'cleanup-ambiguous', timedOut: true });
            return;
          }
          cleanupTimer = setTimeout(() => finish({ kind: 'cleanup-ambiguous', timedOut: true }), TIMEOUT_CLEANUP_GRACE_MS);
        } catch {
          finish({ kind: 'cleanup-ambiguous', timedOut: true });
        }
      }, timeoutMs);
    });

    const [processRef, outcome] = await Promise.all([
      this.identities.acknowledgeSpawn(child.pid!),
      outcomePromise,
    ]);
    const details: TerminalExecutionDetails = {
      mode,
      process: processRef,
      ...(outcome.kind === 'close' ? { exitCode: outcome.code, signal: outcome.signal } : {}),
      stdout: stdout.text(),
      stderr: stderr.text(),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut: outcome.timedOut,
    };
    if (outcome.kind === 'cleanup-ambiguous') {
      return {
        status: 'unknown',
        dispatch: 'dispatched-once',
        verification: 'unverified',
        evidence: ['terminal.timeout.cleanup-ambiguous'],
        details,
      };
    }
    if (outcome.kind === 'error') {
      return {
        status: 'unknown',
        dispatch: 'dispatched-once',
        verification: 'unverified',
        evidence: ['terminal.execution.ambiguous'],
        details,
      };
    }
    if (outcome.timedOut) {
      return {
        status: 'failed',
        dispatch: 'dispatched-once',
        verification: exitStatusVerifiesDomain ? 'verified' : 'not-applicable',
        evidence: [exitStatusVerifiesDomain ? 'terminal.execution.timeout' : 'terminal.execution.timeout-domain-unverified'],
        details,
      };
    }
    if (outcome.code === 0) {
      return {
        status: 'completed',
        dispatch: 'dispatched-once',
        verification: exitStatusVerifiesDomain ? 'verified' : 'not-applicable',
        evidence: [exitStatusVerifiesDomain ? 'terminal.execution.exited-zero' : 'terminal.execution.exited-zero-domain-unverified'],
        details,
      };
    }
    return {
      status: 'failed',
      dispatch: 'dispatched-once',
      verification: exitStatusVerifiesDomain ? 'verified' : 'not-applicable',
      evidence: [
        outcome.code === null
          ? (exitStatusVerifiesDomain ? 'terminal.execution.signaled' : 'terminal.execution.signaled-domain-unverified')
          : (exitStatusVerifiesDomain ? 'terminal.execution.nonzero-exit' : 'terminal.execution.nonzero-exit-domain-unverified'),
      ],
      details,
    };
  }

  private prelaunchFailure(code: string): ComputerActionResult {
    return {
      status: 'rejected',
      dispatch: 'not-dispatched',
      verification: 'rejected',
      evidence: [code],
    };
  }
}
