import type { Readable, Writable } from 'node:stream';
import type {
  CdpMultiplexConnectionLike,
  CdpMultiplexEventListener,
} from '../browser/cdpSessionRouter.js';

export interface CdpPipeConnectionOptions {
  /** Maximum UTF-8 bytes in one inbound/outbound CDP JSON frame. */
  maxMessageBytes?: number;
  /** Hard cap on commands awaiting responses. */
  maxPendingCommands?: number;
  /** Per-command timeout. Set to 0 to disable. */
  commandTimeoutMs?: number;
  /** Listener failures are isolated from transport parsing and may be surfaced here. */
  onListenerError?: (error: unknown, method: string) => void;
}

interface PendingCommand {
  method: string;
  resolve: (value: any) => void;
  reject: (reason: unknown) => void;
  timer?: NodeJS.Timeout;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: any;
  sessionId?: string;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export class CdpProtocolError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(`CDP ${method} failed${code === undefined ? '' : ` (${code})`}: ${message}`);
    this.name = 'CdpProtocolError';
  }
}

/**
 * Chromium `--remote-debugging-pipe` transport implemented only with Node streams.
 *
 * Chromium uses UTF-8 JSON messages terminated by a NUL byte on fd 3/4. Flattened
 * target sessions use the same top-level `sessionId` shape as websocket CDP, so
 * this connection plugs directly into `CdpTargetSessionRouter`.
 */
export class CdpPipeConnection implements CdpMultiplexConnectionLike {
  private readonly maxMessageBytes: number;
  private readonly maxPendingCommands: number;
  private readonly commandTimeoutMs: number;
  private readonly listeners = new Map<string, Set<CdpMultiplexEventListener>>();
  private readonly pending = new Map<number, PendingCommand>();
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private disposed = false;
  private failure?: Error;

  private readonly onDataBound = (chunk: Buffer | string) => this.consume(chunk);
  private readonly onReadableEndBound = () => this.fail(new Error('CDP pipe readable stream ended'));
  private readonly onReadableErrorBound = (error: Error) => this.fail(error);
  private readonly onWritableErrorBound = (error: Error) => this.fail(error);

  constructor(
    private readonly readable: Readable,
    private readonly writable: Writable,
    private readonly options: CdpPipeConnectionOptions = {},
  ) {
    this.maxMessageBytes = positiveInteger(
      'maxMessageBytes',
      options.maxMessageBytes ?? 32 * 1024 * 1024,
    );
    this.maxPendingCommands = positiveInteger(
      'maxPendingCommands',
      options.maxPendingCommands ?? 2048,
    );
    this.commandTimeoutMs = nonNegativeInteger(
      'commandTimeoutMs',
      options.commandTimeoutMs ?? 30_000,
    );
    readable.on('data', this.onDataBound);
    readable.once('end', this.onReadableEndBound);
    readable.once('error', this.onReadableErrorBound);
    writable.once('error', this.onWritableErrorBound);
  }

  get closed(): boolean {
    return this.disposed;
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<any> {
    if (!method.trim()) {
      return Promise.reject(new Error('CDP method must be a non-empty string'));
    }
    if (sessionId !== undefined && !sessionId) {
      return Promise.reject(new Error('sessionId must be non-empty when provided'));
    }
    if (this.disposed) {
      return Promise.reject(this.failure ?? new Error('CDP pipe connection is closed'));
    }
    if (this.pending.size >= this.maxPendingCommands) {
      return Promise.reject(
        new Error(`CDP pending command limit exceeded (${this.maxPendingCommands})`),
      );
    }

    const id = ++this.nextId;
    const payloadObject: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) payloadObject.sessionId = sessionId;
    const json = Buffer.from(JSON.stringify(payloadObject), 'utf8');
    if (json.byteLength > this.maxMessageBytes) {
      return Promise.reject(
        new Error(
          `CDP outbound message exceeds maxMessageBytes (${json.byteLength} > ${this.maxMessageBytes})`,
        ),
      );
    }
    const payload = Buffer.allocUnsafe(json.byteLength + 1);
    json.copy(payload, 0);
    payload[payload.length - 1] = 0;

    return new Promise((resolve, reject) => {
      const command: PendingCommand = { method, resolve, reject };
      if (this.commandTimeoutMs > 0) {
        command.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(
            new Error(`CDP command timed out after ${this.commandTimeoutMs}ms: ${method}`),
          );
        }, this.commandTimeoutMs);
        command.timer.unref?.();
      }
      this.pending.set(id, command);
      this.writable.write(payload, (error?: Error | null) => {
        if (!error) return;
        const current = this.pending.get(id);
        if (!current) return;
        this.pending.delete(id);
        if (current.timer) clearTimeout(current.timer);
        current.reject(error);
      });
    });
  }

  on(event: string, listener: CdpMultiplexEventListener): this {
    if (!event) throw new Error('CDP event name must be non-empty');
    if (this.disposed) {
      throw this.failure ?? new Error('CDP pipe connection is closed');
    }
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  off(event: string, listener: CdpMultiplexEventListener): this {
    const set = this.listeners.get(event);
    set?.delete(listener);
    if (set?.size === 0) this.listeners.delete(event);
    return this;
  }

  close(reason: Error = new Error('CDP pipe connection closed')): void {
    this.fail(reason);
    this.readable.destroy();
    this.writable.destroy();
  }

  private consume(chunk: Buffer | string): void {
    if (this.disposed) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, incoming])
      : incoming;

    while (!this.disposed) {
      const boundary = this.buffer.indexOf(0);
      if (boundary < 0) {
        if (this.buffer.length > this.maxMessageBytes) {
          this.fail(
            new Error(
              `CDP inbound message exceeds maxMessageBytes (${this.buffer.length} > ${this.maxMessageBytes})`,
            ),
          );
        }
        return;
      }
      if (boundary > this.maxMessageBytes) {
        this.fail(
          new Error(
            `CDP inbound message exceeds maxMessageBytes (${boundary} > ${this.maxMessageBytes})`,
          ),
        );
        return;
      }
      const frame = this.buffer.subarray(0, boundary);
      this.buffer = this.buffer.subarray(boundary + 1);
      if (!frame.length) continue;

      let message: CdpMessage;
      try {
        message = JSON.parse(frame.toString('utf8')) as CdpMessage;
      } catch (error) {
        this.fail(
          new Error(
            `Invalid JSON from CDP pipe: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: CdpMessage): void {
    if (typeof message.id === 'number') {
      const command = this.pending.get(message.id);
      if (!command) return;
      this.pending.delete(message.id);
      if (command.timer) clearTimeout(command.timer);
      if (message.error) {
        command.reject(
          new CdpProtocolError(
            command.method,
            typeof message.error.code === 'number' ? message.error.code : undefined,
            typeof message.error.message === 'string'
              ? message.error.message
              : 'unknown protocol error',
            message.error.data,
          ),
        );
      } else {
        command.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message.method !== 'string') return;
    const listeners = this.listeners.get(message.method);
    if (!listeners?.size) return;
    for (const listener of [...listeners]) {
      try {
        listener(
          message.params ?? {},
          typeof message.sessionId === 'string' ? message.sessionId : undefined,
        );
      } catch (error) {
        this.options.onListenerError?.(error, message.method);
      }
    }
  }

  private fail(reason: unknown): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failure = reason instanceof Error ? reason : new Error(String(reason));
    this.readable.off('data', this.onDataBound);
    this.readable.off('end', this.onReadableEndBound);
    this.readable.off('error', this.onReadableErrorBound);
    this.writable.off('error', this.onWritableErrorBound);
    for (const command of this.pending.values()) {
      if (command.timer) clearTimeout(command.timer);
      command.reject(this.failure);
    }
    this.pending.clear();
    this.listeners.clear();
    this.buffer = Buffer.alloc(0);
  }
}
