import { readdir, readFile, readlink } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEntityRef,
  ComputerEnvironmentAdapter,
  ComputerEnvironmentAdapterDescriptor,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from './environmentAdapter.js';
import { validateComputerActionRequest, validateComputerObservationRequest } from './environmentAdapter.js';

const DEFAULT_PROCESS_ITEMS = 64;
const MAX_PROCESS_ITEMS = 256;
const MAX_NAME_BYTES = 160;
const SYNTHETIC_GENERATION_BASE = Number.MAX_SAFE_INTEGER - 1_000_000;

export type ProcessState = 'running' | 'sleeping' | 'waiting' | 'stopped' | 'zombie' | 'dead' | 'unknown';

export interface ProcessRecord {
  pid: number;
  parentPid?: number;
  startTicks: number;
  name: string;
  executable?: string;
  state: ProcessState;
  cpuTimeTicks?: number;
  rssBytes?: number;
}

export interface BoundedProcessSnapshot {
  ref: ComputerEntityRef;
  pid: number;
  parentPid?: number;
  name: string;
  executable?: string;
  state: ProcessState;
  cpuTimeTicks?: number;
  rssBytes?: number;
}

export interface ProcessObservationData {
  processes: readonly BoundedProcessSnapshot[];
  identity?: 'current' | 'replaced' | 'exited';
}

export interface ProcessSnapshotSource {
  listPids(): Promise<readonly number[]>;
  inspect(pid: number): Promise<ProcessRecord | undefined>;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '');
}

function boundedInt(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function mapLinuxState(value: string): ProcessState {
  if (value === 'R') return 'running';
  if (value === 'S' || value === 'I') return 'sleeping';
  if (value === 'D') return 'waiting';
  if (value === 'T' || value === 't') return 'stopped';
  if (value === 'Z') return 'zombie';
  if (value === 'X' || value === 'x') return 'dead';
  return 'unknown';
}

function safeGeneration(startTicks: number): number {
  return Number.isSafeInteger(startTicks) && startTicks >= 0 ? startTicks : 0;
}

export class HostProcessSnapshotSource implements ProcessSnapshotSource {
  async listPids(): Promise<readonly number[]> {
    if (process.platform !== 'linux') return [process.pid];
    const entries = await readdir('/proc');
    return entries
      .filter((entry) => /^\d+$/u.test(entry))
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
      .sort((left, right) => left - right);
  }

  async inspect(pid: number): Promise<ProcessRecord | undefined> {
    if (process.platform !== 'linux') {
      if (pid !== process.pid) return undefined;
      const memory = process.memoryUsage();
      return {
        pid,
        parentPid: process.ppid,
        startTicks: Math.max(0, Math.floor(Date.now() - process.uptime() * 1000)),
        name: process.title || 'node',
        executable: basename(process.execPath),
        state: 'running',
        rssBytes: memory.rss,
      };
    }

    try {
      const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
      const open = raw.indexOf('(');
      const close = raw.lastIndexOf(')');
      if (open < 0 || close <= open) return undefined;
      const name = raw.slice(open + 1, close);
      const fields = raw.slice(close + 2).trim().split(/\s+/u);
      if (fields.length < 22) return undefined;
      const startTicks = Number(fields[19]);
      if (!Number.isSafeInteger(startTicks) || startTicks < 0) return undefined;
      const parentPid = Number(fields[1]);
      const userTicks = Number(fields[11]);
      const systemTicks = Number(fields[12]);
      const rssPages = Number(fields[21]);
      let executable: string | undefined;
      try {
        executable = basename(await readlink(`/proc/${pid}/exe`));
      } catch {
        executable = undefined;
      }
      return {
        pid,
        ...(Number.isSafeInteger(parentPid) && parentPid >= 0 ? { parentPid } : {}),
        startTicks,
        name,
        ...(executable ? { executable } : {}),
        state: mapLinuxState(fields[0] ?? ''),
        ...(Number.isFinite(userTicks) && Number.isFinite(systemTicks) ? { cpuTimeTicks: userTicks + systemTicks } : {}),
        ...(Number.isFinite(rssPages) && rssPages >= 0 ? { rssBytes: rssPages * 4096 } : {}),
      };
    } catch {
      return undefined;
    }
  }
}

export class ProcessIdentityStore {
  private syntheticCounter = 0;
  private readonly syntheticByPid = new Map<number, number>();

  constructor(
    readonly adapterId: string,
    private readonly source: ProcessSnapshotSource = new HostProcessSnapshotSource(),
  ) {}

  async list(limit: number): Promise<{ items: BoundedProcessSnapshot[]; truncated: boolean }> {
    const pids = await this.source.listPids();
    const items: BoundedProcessSnapshot[] = [];
    for (const pid of pids) {
      if (items.length >= limit) break;
      const record = await this.source.inspect(pid);
      if (record) items.push(this.toSnapshot(record));
    }
    return { items, truncated: pids.length > items.length };
  }

  async inspect(pid: number): Promise<BoundedProcessSnapshot | undefined> {
    const record = await this.source.inspect(pid);
    return record ? this.toSnapshot(record) : undefined;
  }

  async acknowledgeSpawn(pid: number): Promise<ComputerEntityRef> {
    const observed = await this.inspect(pid);
    if (observed) return observed.ref;
    const generation = SYNTHETIC_GENERATION_BASE + (this.syntheticCounter++ % 1_000_000);
    this.syntheticByPid.set(pid, generation);
    return this.ref(pid, generation);
  }

  ref(pid: number, generation: number): ComputerEntityRef {
    return {
      adapterId: this.adapterId,
      environment: 'process',
      kind: 'process',
      entityId: `pid:${pid}`,
      generation,
    };
  }

  private toSnapshot(record: ProcessRecord): BoundedProcessSnapshot {
    const generation = safeGeneration(record.startTicks);
    this.syntheticByPid.delete(record.pid);
    return {
      ref: this.ref(record.pid, generation),
      pid: record.pid,
      ...(record.parentPid !== undefined ? { parentPid: record.parentPid } : {}),
      name: truncateUtf8(record.name, MAX_NAME_BYTES),
      ...(record.executable ? { executable: truncateUtf8(basename(record.executable), MAX_NAME_BYTES) } : {}),
      state: record.state,
      ...(record.cpuTimeTicks !== undefined ? { cpuTimeTicks: Math.max(0, Math.floor(record.cpuTimeTicks)) } : {}),
      ...(record.rssBytes !== undefined ? { rssBytes: Math.max(0, Math.floor(record.rssBytes)) } : {}),
    };
  }
}

function parsePid(ref: ComputerEntityRef): number | undefined {
  if (ref.kind !== 'process' || ref.environment !== 'process') return undefined;
  const match = /^pid:(\d+)$/u.exec(ref.entityId);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export class HostProcessAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor: ComputerEnvironmentAdapterDescriptor;
  private sequence = 0;

  constructor(
    readonly identities: ProcessIdentityStore,
    version = '1.0.0',
  ) {
    this.descriptor = {
      id: identities.adapterId,
      kind: 'process',
      version,
      capabilities: ['process.observe', 'process.inspect'],
    };
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    const sequence = ++this.sequence;
    const invalid = validateComputerObservationRequest(request, this.descriptor);
    if (invalid.length > 0 || request.channel !== 'process') {
      return {
        adapterId: this.descriptor.id,
        environment: 'process',
        channel: request.channel,
        sequence,
        complete: false,
        truncated: false,
        ...(request.target ? { target: request.target } : {}),
        data: { code: 'process.observation.invalid' },
      };
    }

    if (request.target) {
      const pid = parsePid(request.target);
      if (pid === undefined) {
        return {
          adapterId: this.descriptor.id,
          environment: 'process',
          channel: 'process',
          sequence,
          complete: false,
          truncated: false,
          target: request.target,
          data: { processes: [], identity: 'exited' } satisfies ProcessObservationData,
        };
      }
      const current = await this.identities.inspect(pid);
      const identity = current === undefined
        ? 'exited'
        : request.target.generation !== undefined && current.ref.generation !== request.target.generation
          ? 'replaced'
          : 'current';
      return {
        adapterId: this.descriptor.id,
        environment: 'process',
        channel: 'process',
        sequence,
        complete: true,
        truncated: false,
        target: request.target,
        data: {
          processes: identity === 'current' && current ? [current] : [],
          identity,
        } satisfies ProcessObservationData,
      };
    }

    const limit = boundedInt(request.limits?.maxItems, DEFAULT_PROCESS_ITEMS, MAX_PROCESS_ITEMS);
    const observed = await this.identities.list(limit);
    return {
      adapterId: this.descriptor.id,
      environment: 'process',
      channel: 'process',
      sequence,
      complete: !observed.truncated,
      truncated: observed.truncated,
      data: { processes: observed.items } satisfies ProcessObservationData,
    };
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    const invalid = validateComputerActionRequest(request, this.descriptor);
    return {
      status: invalid.length > 0 ? 'rejected' : 'unsupported',
      dispatch: 'not-dispatched',
      verification: invalid.length > 0 ? 'rejected' : 'not-applicable',
      evidence: [invalid.length > 0 ? 'process.action.invalid' : 'process.lifecycle.unsupported'],
    };
  }
}
