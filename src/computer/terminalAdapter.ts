import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { stat } from 'node:fs/promises';
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
import { validateComputerActionRequest, validateComputerObservationRequest } from './environmentAdapter.js';
import { ProcessIdentityStore } from './processAdapter.js';

const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
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

export type TerminalCommandClassification =
  | 'local-compute'
  | 'filesystem-write'
  | 'system-configuration'
  | 'security-sensitive'
  | 'network-change'
  | 'remote-execution'
  | 'package-installation'
  | 'account-change'
  | 'unknown';

interface TerminalExecutionBase {
  cwd: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  classification: TerminalCommandClassification;
  approvedEffects: readonly ComputerEffectClass[];
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

const defaultSpawner: ProcessSpawner = {
  spawn(executable, argv, options) {
    return spawn(executable, argv, options) as ChildProcess as SpawnedProcessLike;
  },
};

function classificationEffects(classification: TerminalCommandClassification): readonly ComputerEffectClass[] {
  switch (classification) {
    case 'local-compute': return ['process-execution'];
    case 'filesystem-write': return ['process-execution', 'local-destructive'];
    case 'system-configuration': return ['process-execution', 'system-configuration'];
    case 'security-sensitive': return ['process-execution', 'security-sensitive'];
    case 'network-change': return ['process-execution', 'system-configuration'];
    case 'remote-execution': return ['process-execution', 'remote-execution'];
    case 'package-installation': return ['process-execution', 'system-configuration', 'security-sensitive'];
    case 'account-change': return ['process-execution', 'system-configuration', 'security-sensitive'];
    case 'unknown': return ['process-execution', 'security-sensitive'];
  }
}

function primaryEffect(payload: TerminalExecutionPayload): ComputerEffectClass {
  const effects = [...classificationEffects(payload.classification)];
  if (payload.mode === 'shell' && !effects.includes('security-sensitive')) effects.push('security-sensitive');
  return effects.find((effect) => effect !== 'process-execution') ?? 'process-execution';
}

function requiredEffects(payload: TerminalExecutionPayload): readonly ComputerEffectClass[] {
  const effects = [...classificationEffects(payload.classification)];
  if (payload.mode === 'shell' && !effects.includes('security-sensitive')) effects.push('security-sensitive');
  return effects;
}

function isExecutionPayload(value: unknown): value is TerminalExecutionPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<TerminalExecutionPayload>;
  return payload.mode === 'argv' || payload.mode === 'shell';
}

function validateString(value: string, maxBytes: number): boolean {
  return value.length > 0 && utf8Bytes(value) <= maxBytes && !value.includes('\0');
}

function validateExecutionPayload(payload: TerminalExecutionPayload): string | undefined {
  if (!isAbsolute(payload.cwd) || !validateString(payload.cwd, MAX_CWD_BYTES)) return 'terminal.cwd.invalid';
  if (!Array.isArray(payload.approvedEffects)) return 'terminal.effects.invalid';
  const required = requiredEffects(payload);
  if (required.some((effect) => !payload.approvedEffects.includes(effect))) return 'terminal.effects.insufficient';
  if (payload.mode === 'argv') {
    if (!isAbsolute(payload.executable) || !validateString(payload.executable, MAX_EXECUTABLE_BYTES)) return 'terminal.executable.invalid';
    if (!Array.isArray(payload.argv) || payload.argv.length > MAX_ARGV_ITEMS) return 'terminal.argv.invalid';
    let bytes = 0;
    for (const arg of payload.argv) {
      if (typeof arg !== 'string' || utf8Bytes(arg) > MAX_ARG_BYTES || arg.includes('\0')) return 'terminal.argv.invalid';
      bytes += utf8Bytes(arg);
    }
    if (bytes > MAX_ARGV_BYTES) return 'terminal.argv.invalid';
  } else {
    if (!isAbsolute(payload.shellExecutable) || !validateString(payload.shellExecutable, MAX_EXECUTABLE_BYTES)) return 'terminal.shell.invalid';
    if (!Array.isArray(payload.shellArgs) || payload.shellArgs.length > MAX_ARGV_ITEMS) return 'terminal.shell.invalid';
    if (!validateString(payload.command, MAX_ARGV_BYTES)) return 'terminal.shell.invalid';
    for (const arg of payload.shellArgs) {
      if (typeof arg !== 'string' || utf8Bytes(arg) > MAX_ARG_BYTES || arg.includes('\0')) return 'terminal.shell.invalid';
    }
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

async function validateCwd(cwd: string): Promise<boolean> {
  try {
    return (await stat(cwd)).isDirectory();
  } catch {
    return false;
  }
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
    const valid = invalid.length === 0 && request.channel === 'terminal';
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
        : { code: 'terminal.observation.invalid' },
    };
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    const invalid = validateComputerActionRequest(request, this.descriptor);
    if (invalid.length > 0) return this.prelaunchFailure('terminal.action.invalid');
    if (request.capability !== 'terminal.execute.argv' && request.capability !== 'terminal.execute.shell') {
      return {
        status: 'unsupported',
        dispatch: 'not-dispatched',
        verification: 'not-applicable',
        evidence: ['terminal.capability.unsupported'],
      };
    }
    if (!isExecutionPayload(request.payload)) return this.prelaunchFailure('terminal.payload.invalid');
    const payload = request.payload;
    if ((request.capability === 'terminal.execute.argv') !== (payload.mode === 'argv')) {
      return this.prelaunchFailure('terminal.mode.mismatch');
    }
    const payloadError = validateExecutionPayload(payload);
    if (payloadError) return this.prelaunchFailure(payloadError);
    if (request.effect !== primaryEffect(payload)) return this.prelaunchFailure('terminal.effect.mismatch');
    if (!(await validateCwd(payload.cwd))) return this.prelaunchFailure('terminal.cwd.unavailable');

    const executable = payload.mode === 'argv' ? payload.executable : payload.shellExecutable;
    const argv = payload.mode === 'argv' ? [...payload.argv] : [...payload.shellArgs, payload.command];
    const outputLimit = payload.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    const timeoutMs = payload.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const stdout = new BoundedCapture(outputLimit);
    const stderr = new BoundedCapture(outputLimit);
    let child: SpawnedProcessLike;
    let invocationStarted = false;

    try {
      invocationStarted = true;
      child = this.spawner.spawn(executable, argv, {
        cwd: payload.cwd,
        env: { ...(payload.env ?? {}) },
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
      const finish = (outcome: Outcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      child.once('error', () => finish({ kind: 'error', timedOut }));
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        finish({ kind: 'close', code, signal, timedOut });
      });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
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
      mode: payload.mode,
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
    return {
      status: outcome.timedOut ? 'failed' : 'completed',
      dispatch: 'dispatched-once',
      verification: 'verified',
      evidence: [outcome.timedOut ? 'terminal.execution.timeout' : 'terminal.execution.exited'],
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
