import { spawn } from 'node:child_process';
import type { DesktopBridgeExecutor, NativeDesktopBridgeCommand } from './nativeDesktopJsonBridge.js';

const DEFAULT_MAX_REQUEST_BYTES = 65_536;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_EXECUTABLE_BYTES = 4_096;
const MAX_ARG_ITEMS = 64;
const MAX_ARG_BYTES = 4_096;
const MAX_ARG_TOTAL_BYTES = 32_768;
const MAX_ENV_ITEMS = 128;
const MAX_ENV_KEY_BYTES = 256;
const MAX_ENV_VALUE_BYTES = 8_192;
const MAX_ENV_TOTAL_BYTES = 65_536;
const MAX_STDERR_BYTES = 4_096;
const TERMINATION_ACK_TIMEOUT_MS = 500;

export interface NativeDesktopStdioCommand extends NativeDesktopBridgeCommand {
  /** Hard cap applied before spawning a helper. */
  maxRequestBytes?: number;
  /**
   * Environment entries to overlay on the inherited process environment.
   * The configured entries are snapshotted at executor construction.
   */
  env?: Readonly<Record<string, string>>;
}

interface FrozenCommand {
  executable: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  maxRequestBytes: number;
  maxResponseBytes: number;
  timeoutMs: number;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && utf8Bytes(value) <= maxBytes && !value.includes('\0');
}

function positiveBounded(value: number | undefined, fallback: number, hardMax: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('native desktop helper limit invalid');
  return Math.min(value, hardMax);
}

function snapshotCommand(command: NativeDesktopStdioCommand): FrozenCommand {
  if (!boundedString(command.executable, MAX_EXECUTABLE_BYTES)) throw new Error('native desktop helper executable invalid');
  const args = command.args ?? [];
  if (!Array.isArray(args) || args.length > MAX_ARG_ITEMS) throw new Error('native desktop helper arguments invalid');
  let argBytes = 0;
  const frozenArgs = args.map((arg) => {
    if (!boundedString(arg, MAX_ARG_BYTES)) throw new Error('native desktop helper argument invalid');
    argBytes += utf8Bytes(arg);
    if (argBytes > MAX_ARG_TOTAL_BYTES) throw new Error('native desktop helper arguments too large');
    return arg;
  });

  let frozenEnv: Readonly<Record<string, string>> | undefined;
  if (command.env !== undefined) {
    const entries = Object.entries(command.env);
    if (entries.length > MAX_ENV_ITEMS) throw new Error('native desktop helper environment too large');
    let envBytes = 0;
    const copy: Record<string, string> = Object.create(null);
    for (const [key, value] of entries) {
      if (!boundedString(key, MAX_ENV_KEY_BYTES) || !boundedString(value, MAX_ENV_VALUE_BYTES)) {
        throw new Error('native desktop helper environment invalid');
      }
      envBytes += utf8Bytes(key) + utf8Bytes(value);
      if (envBytes > MAX_ENV_TOTAL_BYTES) throw new Error('native desktop helper environment too large');
      copy[key] = value;
    }
    frozenEnv = Object.freeze(copy);
  }

  return Object.freeze({
    executable: command.executable,
    args: Object.freeze([...frozenArgs]),
    ...(frozenEnv ? { env: frozenEnv } : {}),
    maxRequestBytes: positiveBounded(command.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 1_000_000),
    maxResponseBytes: positiveBounded(command.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 16_000_000),
    timeoutMs: positiveBounded(command.timeoutMs, DEFAULT_TIMEOUT_MS, 30_000),
  });
}

/**
 * Process transport that keeps desktop action payloads out of argv/process-list
 * surfaces. One versioned JSON request is written to stdin; stdout is acquired
 * under a byte ceiling before parsing. Stderr is consumed only under a small
 * bound and is never copied into thrown errors, neutral evidence, or results.
 *
 * A dispatch-side transport error is deliberately not classified here. The
 * caller must conservatively assume native input may have been emitted once the
 * helper invocation started. Failure paths do not settle until helper exit is
 * acknowledged or a separate finite termination deadline expires.
 */
export class StdioDesktopBridgeExecutor implements DesktopBridgeExecutor {
  private readonly command: FrozenCommand;

  constructor(command: NativeDesktopStdioCommand) {
    this.command = snapshotCommand(command);
  }

  invoke(operation: string, payload: unknown, limits: { maxResponseBytes: number; timeoutMs: number }): Promise<unknown> {
    if (!boundedString(operation, 128)) return Promise.reject(new Error('native desktop helper operation invalid'));
    let request: string;
    try {
      request = JSON.stringify({ version: 1, operation, payload });
    } catch {
      return Promise.reject(new Error('native desktop helper request not serializable'));
    }
    const requestBytes = utf8Bytes(request);
    if (requestBytes > this.command.maxRequestBytes) return Promise.reject(new Error('native desktop helper request too large'));

    const maxResponseBytes = Math.min(this.command.maxResponseBytes, Math.max(1, limits.maxResponseBytes));
    const timeoutMs = Math.min(this.command.timeoutMs, Math.max(1, limits.timeoutMs));

    return new Promise((resolve, reject) => {
      let settled = false;
      let terminating = false;
      let terminationReason = 'native desktop helper process failed';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let terminationTimer:ReturnType<typeof setTimeout>|undefined;
      const stdout: Buffer[] = [];
      const child = spawn(this.command.executable, [...this.command.args], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.command.env ? { ...process.env, ...this.command.env } : process.env,
      });
      const clearTimers = () => {
        clearTimeout(timer);
        if (terminationTimer) clearTimeout(terminationTimer);
      };
      const finishReject = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(new Error(message));
      };
      const finishResolve = (value:unknown) => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve(value);
      };
      const terminateThenReject = (message:string) => {
        if (settled || terminating) return;
        terminating = true;
        terminationReason = message;
        clearTimeout(timer);
        child.stdin.destroy();
        child.stdout.pause();
        child.stderr.pause();
        if (child.exitCode !== null || child.signalCode !== null) {
          finishReject(message);
          return;
        }
        let accepted = false;
        try { accepted = child.kill('SIGKILL'); } catch { accepted = false; }
        if (!accepted) {
          finishReject(`${message}; native desktop helper termination unconfirmed`);
          return;
        }
        terminationTimer = setTimeout(() => {
          finishReject(`${message}; native desktop helper termination unconfirmed`);
        }, TERMINATION_ACK_TIMEOUT_MS);
        terminationTimer.unref?.();
      };
      const timer = setTimeout(() => {
        terminateThenReject('native desktop helper timed out');
      }, timeoutMs);
      timer.unref?.();

      child.once('error', () => {
        if (settled) return;
        if (child.pid === undefined) {
          finishReject('native desktop helper process failed');
          return;
        }
        terminateThenReject('native desktop helper process failed');
      });
      child.stdout.on('data', (chunk: Buffer | string) => {
        if (settled || terminating) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.byteLength;
        if (stdoutBytes > maxResponseBytes) {
          terminateThenReject('native desktop helper response too large');
          return;
        }
        stdout.push(Buffer.from(buffer));
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes = Math.min(MAX_STDERR_BYTES + 1, stderrBytes + buffer.byteLength);
        if (stderrBytes > MAX_STDERR_BYTES && !settled) child.stderr.pause();
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        if (terminating) {
          finishReject(terminationReason);
          return;
        }
        clearTimeout(timer);
        if (code !== 0 || signal !== null) {
          finishReject('native desktop helper exited unsuccessfully');
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(Buffer.concat(stdout, stdoutBytes).toString('utf8'));
        } catch {
          finishReject('native desktop helper response malformed');
          return;
        }
        finishResolve(value);
      });

      child.stdin.once('error', () => {
        terminateThenReject('native desktop helper request failed');
      });
      child.stdin.end(request, 'utf8');
    });
  }
}
