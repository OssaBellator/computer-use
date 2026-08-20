import { opendir, readFile, readlink } from 'node:fs/promises';
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
const PROCESS_CANDIDATE_MULTIPLIER = 4;
const MAX_PROCESS_CANDIDATES = MAX_PROCESS_ITEMS * PROCESS_CANDIDATE_MULTIPLIER;
const MAX_NAME_BYTES = 160;
const DEFAULT_PROCESS_TEXT_BYTES = 16 * 1024;
const MAX_PROCESS_TEXT_BYTES = 64 * 1024;
const SPAWN_ACKNOWLEDGEMENT_TIMEOUT_MS = 50;
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

export interface BoundedProcessPidBatch {
  pids: readonly number[];
  truncated: boolean;
}

export interface ProcessSnapshotSource {
  listPids(maxCandidates: number): Promise<BoundedProcessPidBatch>;
  inspect(pid: number): Promise<ProcessRecord | undefined>;
}

function utf8Bytes(value: string): number { return Buffer.byteLength(value, 'utf8'); }
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
function safeGeneration(startTicks: number): number { return Number.isSafeInteger(startTicks) && startTicks >= 0 ? startTicks : 0; }
const PROCESS_STATES = new Set<ProcessState>(['running', 'sleeping', 'waiting', 'stopped', 'zombie', 'dead', 'unknown']);
const PROCESS_RECORD_KEYS = new Set(['pid', 'parentPid', 'startTicks', 'name', 'executable', 'state', 'cpuTimeTicks', 'rssBytes']);
function snapshotProcessRecordForPid(value: unknown, requestedPid: number): Readonly<ProcessRecord> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!PROCESS_RECORD_KEYS.has(key) || !('value' in descriptor)) return undefined;
  }
  const field = (key: string): unknown => descriptors[key] && 'value' in descriptors[key]! ? descriptors[key]!.value : undefined;
  const pid = field('pid');
  const parentPid = field('parentPid');
  const startTicks = field('startTicks');
  const name = field('name');
  const executable = field('executable');
  const state = field('state');
  const cpuTimeTicks = field('cpuTimeTicks');
  const rssBytes = field('rssBytes');
  if (pid !== requestedPid || !Number.isSafeInteger(pid) || (pid as number) <= 0) return undefined;
  if (!Number.isSafeInteger(startTicks) || (startTicks as number) < 0) return undefined;
  if (typeof name !== 'string' || typeof state !== 'string' || !PROCESS_STATES.has(state as ProcessState)) return undefined;
  if (parentPid !== undefined && (!Number.isSafeInteger(parentPid) || (parentPid as number) < 0)) return undefined;
  if (executable !== undefined && typeof executable !== 'string') return undefined;
  if (cpuTimeTicks !== undefined && (typeof cpuTimeTicks !== 'number' || !Number.isFinite(cpuTimeTicks) || cpuTimeTicks < 0)) return undefined;
  if (rssBytes !== undefined && (typeof rssBytes !== 'number' || !Number.isFinite(rssBytes) || rssBytes < 0)) return undefined;
  return Object.freeze({
    pid: pid as number,
    ...(parentPid === undefined ? {} : { parentPid: parentPid as number }),
    startTicks: startTicks as number,
    name,
    ...(executable === undefined ? {} : { executable }),
    state: state as ProcessState,
    ...(cpuTimeTicks === undefined ? {} : { cpuTimeTicks }),
    ...(rssBytes === undefined ? {} : { rssBytes }),
  });
}

export class HostProcessSnapshotSource implements ProcessSnapshotSource {
  private readonly currentStartTicks = Math.max(0, Math.floor(Date.now() - process.uptime() * 1000));
  async listPids(maxCandidates: number): Promise<BoundedProcessPidBatch> {
    if (process.platform !== 'linux') return { pids: [process.pid].slice(0, maxCandidates), truncated: false };
    const directory = await opendir('/proc');
    const pids: number[] = [];
    let truncated = false;
    for await (const entry of directory) {
      if (!/^\d+$/u.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      if (pids.length >= maxCandidates) {
        truncated = true;
        break;
      }
      pids.push(pid);
    }
    pids.sort((left, right) => left - right);
    return { pids, truncated };
  }
  async inspect(pid: number): Promise<ProcessRecord | undefined> {
    if (process.platform !== 'linux') {
      if (pid !== process.pid) return undefined;
      const memory = process.memoryUsage();
      return { pid, parentPid: process.ppid, startTicks: this.currentStartTicks, name: process.title || 'node', executable: basename(process.execPath), state: 'running', rssBytes: memory.rss };
    }
    try {
      const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
      const open = raw.indexOf('('); const close = raw.lastIndexOf(')');
      if (open < 0 || close <= open) return undefined;
      const name = raw.slice(open + 1, close); const fields = raw.slice(close + 2).trim().split(/\s+/u);
      if (fields.length < 22) return undefined;
      const startTicks = Number(fields[19]); if (!Number.isSafeInteger(startTicks) || startTicks < 0) return undefined;
      const parentPid = Number(fields[1]); const userTicks = Number(fields[11]); const systemTicks = Number(fields[12]); const rssPages = Number(fields[21]);
      let executable: string | undefined; try { executable = basename(await readlink(`/proc/${pid}/exe`)); } catch { executable = undefined; }
      return { pid, ...(Number.isSafeInteger(parentPid) && parentPid >= 0 ? { parentPid } : {}), startTicks, name, ...(executable ? { executable } : {}), state: mapLinuxState(fields[0] ?? ''), ...(Number.isFinite(userTicks) && Number.isFinite(systemTicks) ? { cpuTimeTicks: userTicks + systemTicks } : {}), ...(Number.isFinite(rssPages) && rssPages >= 0 ? { rssBytes: rssPages * 4096 } : {}) };
    } catch { return undefined; }
  }
}

export class ProcessIdentityStore {
  private syntheticCounter = 0; private readonly syntheticByPid = new Map<number, number>();
  constructor(readonly adapterId: string, private readonly source: ProcessSnapshotSource = new HostProcessSnapshotSource()) {}
  async list(limit: number): Promise<{ items: BoundedProcessSnapshot[]; truncated: boolean }> {
    const candidateLimit = Math.min(
      MAX_PROCESS_CANDIDATES,
      Math.max(limit + 1, limit * PROCESS_CANDIDATE_MULTIPLIER),
    );
    const acquired = await this.source.listPids(candidateLimit);
    const batch: BoundedProcessPidBatch = {
      pids: acquired.pids.slice(0, candidateLimit),
      truncated: acquired.truncated || acquired.pids.length > candidateLimit,
    };
    const items: BoundedProcessSnapshot[] = [];
    let inspected = 0;
    for (const pid of batch.pids) {
      if (items.length >= limit) break;
      inspected += 1;
      const record = snapshotProcessRecordForPid(await this.source.inspect(pid), pid);
      if (record) items.push(this.toSnapshot(record));
    }
    return { items, truncated: batch.truncated || inspected < batch.pids.length };
  }
  async inspect(pid: number): Promise<BoundedProcessSnapshot | undefined> { const record = snapshotProcessRecordForPid(await this.source.inspect(pid), pid); return record ? this.toSnapshot(record) : undefined; }
  async acknowledgeSpawn(pid: number): Promise<ComputerEntityRef> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const record = await Promise.race([
      this.source.inspect(pid).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(resolve, SPAWN_ACKNOWLEDGEMENT_TIMEOUT_MS);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    const snapshot = snapshotProcessRecordForPid(record, pid);
    if (snapshot) return this.toSnapshot(snapshot).ref;
    const generation = SYNTHETIC_GENERATION_BASE + (this.syntheticCounter++ % 1_000_000);
    this.syntheticByPid.set(pid, generation);
    return this.ref(pid, generation);
  }
  ref(pid: number, generation: number): ComputerEntityRef { return { adapterId: this.adapterId, environment: 'process', kind: 'process', entityId: `pid:${pid}`, generation }; }
  private toSnapshot(record: Readonly<ProcessRecord>): BoundedProcessSnapshot { const generation = safeGeneration(record.startTicks); this.syntheticByPid.delete(record.pid); return { ref: this.ref(record.pid, generation), pid: record.pid, ...(record.parentPid !== undefined ? { parentPid: record.parentPid } : {}), name: truncateUtf8(record.name, MAX_NAME_BYTES), ...(record.executable ? { executable: truncateUtf8(basename(record.executable), MAX_NAME_BYTES) } : {}), state: record.state, ...(record.cpuTimeTicks !== undefined ? { cpuTimeTicks: Math.max(0, Math.floor(record.cpuTimeTicks)) } : {}), ...(record.rssBytes !== undefined ? { rssBytes: Math.max(0, Math.floor(record.rssBytes)) } : {}) }; }
}

function applyTextBudget(items: readonly BoundedProcessSnapshot[], maxTextBytes: number): { items: BoundedProcessSnapshot[]; truncated: boolean } {
  let remaining = maxTextBytes; let truncated = false;
  const bounded = items.map((item) => {
    const name = truncateUtf8(item.name, remaining); const nameBytes = utf8Bytes(name); if (nameBytes < utf8Bytes(item.name)) truncated = true; remaining = Math.max(0, remaining - nameBytes);
    let executable: string | undefined;
    if (item.executable !== undefined) { executable = truncateUtf8(item.executable, remaining); const executableBytes = utf8Bytes(executable); if (executableBytes < utf8Bytes(item.executable)) truncated = true; remaining = Math.max(0, remaining - executableBytes); if (executable.length === 0 && item.executable.length > 0) executable = undefined; }
    return { ...item, name, ...(executable !== undefined ? { executable } : { executable: undefined }) };
  });
  return { items: bounded, truncated };
}
function parsePid(ref: ComputerEntityRef): number | undefined { if (ref.kind !== 'process' || ref.environment !== 'process') return undefined; const match = /^pid:(\d+)$/u.exec(ref.entityId); if (!match) return undefined; const pid = Number(match[1]); return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined; }

export class HostProcessAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor: ComputerEnvironmentAdapterDescriptor; private sequence = 0;
  constructor(readonly identities: ProcessIdentityStore, version = '1.0.0') { this.descriptor = { id: identities.adapterId, kind: 'process', version, capabilities: ['process.observe', 'process.inspect'] }; }
  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    const sequence = ++this.sequence; const invalid = validateComputerObservationRequest(request, this.descriptor);
    if (invalid.length > 0 || request.channel !== 'process') return { adapterId: this.descriptor.id, environment: 'process', channel: request.channel, sequence, complete: false, truncated: false, ...(request.target ? { target: request.target } : {}), data: { code: 'process.observation.invalid' } };
    if (request.target) {
      const pid = parsePid(request.target);
      if (pid === undefined) return { adapterId: this.descriptor.id, environment: 'process', channel: 'process', sequence, complete: false, truncated: false, target: request.target, data: { processes: [], identity: 'exited' } satisfies ProcessObservationData };
      const current = await this.identities.inspect(pid); const identity = current === undefined ? 'exited' : request.target.generation !== undefined && current.ref.generation !== request.target.generation ? 'replaced' : 'current';
      const textLimit = boundedInt(request.limits?.maxTextBytes, DEFAULT_PROCESS_TEXT_BYTES, MAX_PROCESS_TEXT_BYTES); const textBounded = applyTextBudget(identity === 'current' && current ? [current] : [], textLimit);
      return { adapterId: this.descriptor.id, environment: 'process', channel: 'process', sequence, complete: !textBounded.truncated, truncated: textBounded.truncated, target: request.target, data: { processes: textBounded.items, identity } satisfies ProcessObservationData };
    }
    const limit = boundedInt(request.limits?.maxItems, DEFAULT_PROCESS_ITEMS, MAX_PROCESS_ITEMS); const textLimit = boundedInt(request.limits?.maxTextBytes, DEFAULT_PROCESS_TEXT_BYTES, MAX_PROCESS_TEXT_BYTES); const observed = await this.identities.list(limit); const textBounded = applyTextBudget(observed.items, textLimit); const truncated = observed.truncated || textBounded.truncated;
    return { adapterId: this.descriptor.id, environment: 'process', channel: 'process', sequence, complete: !truncated, truncated, data: { processes: textBounded.items } satisfies ProcessObservationData };
  }
  async act(request: ComputerActionRequest): Promise<ComputerActionResult> { const invalid = validateComputerActionRequest(request, this.descriptor); return { status: invalid.length > 0 ? 'rejected' : 'unsupported', dispatch: 'not-dispatched', verification: invalid.length > 0 ? 'rejected' : 'not-applicable', evidence: [invalid.length > 0 ? 'process.action.invalid' : 'process.lifecycle.unsupported'] }; }
}
