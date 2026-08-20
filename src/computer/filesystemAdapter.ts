import { constants as fsConstants } from 'node:fs';
import { open, lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEntityRef,
  ComputerEnvironmentAdapter,
  ComputerEnvironmentAdapterDescriptor,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
  ComputerSurfaceRef,
} from './environmentAdapter.js';

const DEFAULT_MAX_ITEMS = 256;
const HARD_MAX_ITEMS = 4096;
const DEFAULT_MAX_TEXT_BYTES = 64 * 1024;
const HARD_MAX_TEXT_BYTES = 1024 * 1024;

export type FilesystemEntryType = 'file' | 'directory' | 'symlink' | 'other';
export type FilesystemErrorCode =
  | 'filesystem-invalid-request'
  | 'filesystem-path-traversal'
  | 'filesystem-target-missing'
  | 'filesystem-target-inaccessible'
  | 'filesystem-target-stale'
  | 'filesystem-generation-mismatch'
  | 'filesystem-symlink-rejected'
  | 'filesystem-mount-boundary'
  | 'filesystem-target-kind-mismatch'
  | 'filesystem-race-detected'
  | 'filesystem-binary-content'
  | 'filesystem-limit-invalid';

export class FilesystemAdapterError extends Error {
  constructor(readonly code: FilesystemErrorCode, message: string) {
    super(message);
    this.name = 'FilesystemAdapterError';
  }
}

export interface FilesystemComputerEnvironmentAdapterOptions {
  adapterId: string;
  rootPath: string;
}

export interface FilesystemObjectMetadata {
  name: string;
  type: Exclude<FilesystemEntryType, 'symlink'>;
  size: number;
  modifiedMs: number;
  mode: number;
  linkCount: number;
  hardlinked: boolean;
  deviceId: string;
  mountBoundary: boolean;
}

export interface FilesystemDirectoryEntry {
  name: string;
  type: FilesystemEntryType;
  ref?: ComputerEntityRef;
  size?: number;
  modifiedMs?: number;
  linkCount?: number;
  hardlinked?: boolean;
  mountBoundary: boolean;
  symlink?: {
    target: string;
    targetWithinRoot: boolean;
    targetType?: Exclude<FilesystemEntryType, 'symlink'>;
  };
}

export interface FilesystemDirectoryObservation {
  kind: 'directory';
  metadata: FilesystemObjectMetadata;
  entries: readonly FilesystemDirectoryEntry[];
}

export interface FilesystemFileObservation {
  kind: 'file';
  metadata: FilesystemObjectMetadata;
  content?: string;
  contentEncoding?: 'utf8';
  contentBytes?: number;
}

interface IdentityRecord {
  path: string;
  kind: 'file' | 'directory';
  key: string;
  generation: number;
}

type BigStats = Awaited<ReturnType<typeof lstat>> & {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
};

function safeNumber(value: bigint | number): number {
  const n = typeof value === 'bigint' ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

function identityKey(stats: BigStats): string {
  return `fs1:${stats.dev.toString(36)}:${stats.ino.toString(36)}:${stats.birthtimeNs.toString(36)}`;
}

function statKind(stats: BigStats): 'file' | 'directory' | 'symlink' | 'other' {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'other';
}

function evidenceFor(error: unknown): FilesystemErrorCode {
  return error instanceof FilesystemAdapterError ? error.code : 'filesystem-target-inaccessible';
}

function mapFsError(error: unknown, path: string): never {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    throw new FilesystemAdapterError('filesystem-target-missing', `filesystem target is missing: ${path}`);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    throw new FilesystemAdapterError('filesystem-target-inaccessible', `filesystem target is inaccessible: ${path}`);
  }
  if (code === 'ELOOP') {
    throw new FilesystemAdapterError('filesystem-symlink-rejected', `symlink traversal rejected: ${path}`);
  }
  throw error;
}

function boundedLimit(value: number | undefined, fallback: number, hardMax: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > hardMax) {
    throw new FilesystemAdapterError('filesystem-limit-invalid', `limit must be between 1 and ${hardMax}`);
  }
  return selected;
}

function withinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export class FilesystemComputerEnvironmentAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor: ComputerEnvironmentAdapterDescriptor;
  private readonly rootInput: string;
  private initialized?: Promise<void>;
  private rootPath = '';
  private rootDevice = '';
  private rootIdentity?: IdentityRecord;
  private rootSurface?: ComputerSurfaceRef;
  private sequence = 0;
  private readonly identities = new Map<string, IdentityRecord>();

  constructor(options: FilesystemComputerEnvironmentAdapterOptions) {
    if (!options.adapterId || /[\r\n\0]/.test(options.adapterId)) {
      throw new FilesystemAdapterError('filesystem-invalid-request', 'adapterId must be a bounded opaque identifier');
    }
    this.rootInput = resolve(options.rootPath);
    this.descriptor = Object.freeze({
      id: options.adapterId,
      kind: 'filesystem' as const,
      version: '1',
      capabilities: Object.freeze(['filesystem.read']),
    });
  }

  async root(): Promise<{ surface: ComputerSurfaceRef; directory: ComputerEntityRef }> {
    await this.ensureInitialized();
    return {
      surface: { ...this.rootSurface! },
      directory: this.refFor(this.rootIdentity!),
    };
  }

  async resolvePath(relativePath: string): Promise<ComputerEntityRef> {
    await this.ensureInitialized();
    if (relativePath.includes('\0') || isAbsolute(relativePath)) {
      throw new FilesystemAdapterError('filesystem-path-traversal', 'absolute or NUL-containing paths are outside the scoped root');
    }
    const candidate = resolve(this.rootPath, relativePath);
    if (!withinRoot(this.rootPath, candidate)) {
      throw new FilesystemAdapterError('filesystem-path-traversal', 'path escapes the scoped filesystem root');
    }
    const rel = relative(this.rootPath, candidate);
    const segments = rel === '' ? [] : rel.split(sep);
    let current = this.rootPath;
    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index]);
      const stats = await this.safeLstat(current);
      const kind = statKind(stats);
      if (kind === 'symlink') {
        throw new FilesystemAdapterError('filesystem-symlink-rejected', 'path resolution does not follow symlinks');
      }
      if (stats.dev.toString() !== this.rootDevice) {
        throw new FilesystemAdapterError('filesystem-mount-boundary', 'path resolution crossed a mount/device boundary');
      }
      if (index < segments.length - 1 && kind !== 'directory') {
        throw new FilesystemAdapterError('filesystem-target-kind-mismatch', 'non-directory encountered during path resolution');
      }
    }
    const stats = await this.safeLstat(candidate);
    const kind = statKind(stats);
    if (kind !== 'file' && kind !== 'directory') {
      throw new FilesystemAdapterError('filesystem-target-kind-mismatch', 'only files and directories have resolvable entity refs');
    }
    return this.registerIdentity(candidate, kind, stats);
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    await this.ensureInitialized();
    this.validateObservationRequest(request);
    const record = request.target ? await this.recordForRef(request.target) : this.rootIdentity!;
    let data: FilesystemDirectoryObservation | FilesystemFileObservation;
    let truncated: boolean;
    if (record.kind === 'directory') {
      const directory = await this.observeDirectory(record, request.limits?.maxItems);
      data = directory.data;
      truncated = directory.truncated;
    } else {
      const file = await this.observeFile(record, request.limits?.maxTextBytes);
      data = file;
      truncated = typeof file.contentBytes === 'number' && file.metadata.size > file.contentBytes;
    }
    return {
      adapterId: this.descriptor.id,
      environment: 'filesystem',
      channel: 'filesystem',
      sequence: this.sequence++,
      complete: !truncated,
      truncated,
      surface: request.surface ? { ...request.surface } : { ...this.rootSurface! },
      target: request.target ? { ...request.target } : this.refFor(record),
      data,
    };
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    if (request.capability !== 'filesystem.read') {
      return { status: 'unsupported', dispatch: 'not-dispatched', verification: 'unverified', evidence: ['filesystem-capability-unsupported'] };
    }
    if (request.effect !== 'observe-only' || request.idempotency !== 'read-only' || !request.target || request.target.kind !== 'file') {
      return { status: 'rejected', dispatch: 'not-dispatched', verification: 'rejected', evidence: ['filesystem-read-request-rejected'] };
    }
    const payload = request.payload as { maxBytes?: unknown } | undefined;
    try {
      await this.ensureInitialized();
      const maxBytes = boundedLimit(typeof payload?.maxBytes === 'number' ? payload.maxBytes : undefined, DEFAULT_MAX_TEXT_BYTES, HARD_MAX_TEXT_BYTES);
      const record = await this.recordForRef(request.target);
      if (record.kind !== 'file') throw new FilesystemAdapterError('filesystem-target-kind-mismatch', 'read target is not a file');
      const details = await this.readFile(record, maxBytes);
      return { status: 'completed', dispatch: 'not-dispatched', verification: 'verified', evidence: ['filesystem-read-bounded'], details };
    } catch (error) {
      const code = evidenceFor(error);
      const rejected = code === 'filesystem-generation-mismatch' || code === 'filesystem-target-stale' || code === 'filesystem-limit-invalid';
      return { status: rejected ? 'rejected' : 'failed', dispatch: 'not-dispatched', verification: 'rejected', evidence: [code] };
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) this.initialized = this.initialize();
    await this.initialized;
  }

  private async initialize(): Promise<void> {
    const inputStats = await this.safeLstat(this.rootInput);
    if (inputStats.isSymbolicLink()) {
      throw new FilesystemAdapterError('filesystem-symlink-rejected', 'scoped root must not be a symlink');
    }
    if (!inputStats.isDirectory()) {
      throw new FilesystemAdapterError('filesystem-target-kind-mismatch', 'scoped root must be a directory');
    }
    const canonical = await realpath(this.rootInput).catch((error) => mapFsError(error, this.rootInput));
    const stats = await this.safeLstat(canonical);
    this.rootPath = canonical;
    this.rootDevice = stats.dev.toString();
    const ref = this.registerIdentity(canonical, 'directory', stats);
    this.rootIdentity = this.identities.get(ref.entityId)!;
    this.rootSurface = Object.freeze({
      adapterId: this.descriptor.id,
      environment: 'filesystem' as const,
      surfaceId: `mount:${identityKey(stats)}`,
      generation: 0,
    });
  }

  private validateObservationRequest(request: ComputerObservationRequest): void {
    if (request.adapterId !== this.descriptor.id || request.channel !== 'filesystem') {
      throw new FilesystemAdapterError('filesystem-invalid-request', 'filesystem adapter accepts only its own filesystem observation channel');
    }
    if (request.surface && (
      request.surface.adapterId !== this.descriptor.id ||
      request.surface.environment !== 'filesystem' ||
      request.surface.surfaceId !== this.rootSurface!.surfaceId ||
      request.surface.generation !== this.rootSurface!.generation
    )) {
      throw new FilesystemAdapterError('filesystem-target-stale', 'filesystem surface identity is stale or belongs to another adapter');
    }
    if (request.limits?.maxDepth !== undefined && request.limits.maxDepth !== 1) {
      throw new FilesystemAdapterError('filesystem-limit-invalid', 'filesystem directory observation is non-recursive and requires maxDepth=1 when specified');
    }
  }

  private async safeLstat(path: string): Promise<BigStats> {
    try {
      return await lstat(path, { bigint: true }) as unknown as BigStats;
    } catch (error) {
      mapFsError(error, path);
    }
  }

  private registerIdentity(path: string, kind: 'file' | 'directory', stats: BigStats): ComputerEntityRef {
    const key = identityKey(stats);
    const existing = this.identities.get(key);
    const record: IdentityRecord = existing ?? { path, kind, key, generation: 0 };
    if (!existing) this.identities.set(key, record);
    return this.refFor(record);
  }

  private refFor(record: IdentityRecord): ComputerEntityRef {
    return {
      adapterId: this.descriptor.id,
      environment: 'filesystem',
      kind: record.kind,
      entityId: record.key,
      surfaceId: this.rootSurface?.surfaceId,
      generation: record.generation,
    };
  }

  private async recordForRef(ref: ComputerEntityRef): Promise<IdentityRecord> {
    if (ref.adapterId !== this.descriptor.id || ref.environment !== 'filesystem' || (ref.kind !== 'file' && ref.kind !== 'directory')) {
      throw new FilesystemAdapterError('filesystem-invalid-request', 'target ref does not belong to this filesystem adapter');
    }
    if (ref.surfaceId !== this.rootSurface!.surfaceId) {
      throw new FilesystemAdapterError('filesystem-target-stale', 'target ref belongs to a stale filesystem surface');
    }
    const record = this.identities.get(ref.entityId);
    if (!record) throw new FilesystemAdapterError('filesystem-target-stale', 'target identity is unknown or stale');
    if (ref.generation !== record.generation) {
      throw new FilesystemAdapterError('filesystem-generation-mismatch', 'target generation does not match the known filesystem object');
    }
    if (ref.kind !== record.kind) throw new FilesystemAdapterError('filesystem-target-kind-mismatch', 'target kind does not match known identity');
    const stats = await this.safeLstat(record.path);
    if (statKind(stats) !== record.kind || identityKey(stats) !== record.key) {
      throw new FilesystemAdapterError('filesystem-target-stale', 'filesystem object was deleted or replaced');
    }
    if (stats.dev.toString() !== this.rootDevice) {
      throw new FilesystemAdapterError('filesystem-mount-boundary', 'target crossed the scoped root mount boundary');
    }
    return record;
  }

  private metadata(path: string, kind: 'file' | 'directory', stats: BigStats): FilesystemObjectMetadata {
    return {
      name: basename(path),
      type: kind,
      size: safeNumber(stats.size),
      modifiedMs: safeNumber(stats.mtimeMs),
      mode: safeNumber(stats.mode),
      linkCount: safeNumber(stats.nlink),
      hardlinked: safeNumber(stats.nlink) > 1,
      deviceId: stats.dev.toString(),
      mountBoundary: stats.dev.toString() !== this.rootDevice,
    };
  }

  private async observeDirectory(
    record: IdentityRecord,
    maxItemsInput?: number,
  ): Promise<{ data: FilesystemDirectoryObservation; truncated: boolean }> {
    const before = await this.safeLstat(record.path);
    if (identityKey(before) !== record.key || !before.isDirectory()) {
      throw new FilesystemAdapterError('filesystem-target-stale', 'directory was replaced before enumeration');
    }
    const maxItems = boundedLimit(maxItemsInput, DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS);
    let names: string[];
    try {
      names = await readdir(record.path);
    } catch (error) {
      mapFsError(error, record.path);
    }
    names.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
    const selected = names.slice(0, maxItems);
    const entries: FilesystemDirectoryEntry[] = [];
    for (const name of selected) {
      const path = resolve(record.path, name);
      if (!withinRoot(this.rootPath, path)) {
        throw new FilesystemAdapterError('filesystem-path-traversal', 'directory entry escaped scoped root');
      }
      const stats = await this.safeLstat(path);
      const type = statKind(stats);
      const mountBoundary = stats.dev.toString() !== this.rootDevice;
      if (type === 'symlink') {
        entries.push({ name, type, mountBoundary: false, symlink: await this.describeSymlink(path) });
        continue;
      }
      const entry: FilesystemDirectoryEntry = {
        name,
        type,
        mountBoundary,
        size: safeNumber(stats.size),
        modifiedMs: safeNumber(stats.mtimeMs),
        linkCount: safeNumber(stats.nlink),
        hardlinked: safeNumber(stats.nlink) > 1,
      };
      if (!mountBoundary && (type === 'file' || type === 'directory')) {
        entry.ref = this.registerIdentity(path, type, stats);
      }
      entries.push(entry);
    }
    const after = await this.safeLstat(record.path);
    if (identityKey(after) !== record.key || !after.isDirectory()) {
      throw new FilesystemAdapterError('filesystem-race-detected', 'directory changed identity during enumeration');
    }
    return {
      data: { kind: 'directory', metadata: this.metadata(record.path, 'directory', after), entries },
      truncated: names.length > selected.length,
    };
  }

  private async describeSymlink(path: string): Promise<NonNullable<FilesystemDirectoryEntry['symlink']>> {
    let target: string;
    try {
      target = await readlink(path);
    } catch (error) {
      mapFsError(error, path);
    }
    const resolvedTarget = resolve(path, '..', target);
    const targetWithinRoot = withinRoot(this.rootPath, resolvedTarget);
    let targetType: Exclude<FilesystemEntryType, 'symlink'> | undefined;
    if (targetWithinRoot) {
      try {
        const targetStats = await lstat(resolvedTarget, { bigint: true }) as unknown as BigStats;
        const kind = statKind(targetStats);
        if (kind !== 'symlink') targetType = kind;
      } catch {
        // A dangling/inaccessible target is represented without following it.
      }
    }
    return { target, targetWithinRoot, targetType };
  }

  private async observeFile(record: IdentityRecord, maxTextBytes?: number): Promise<FilesystemFileObservation> {
    const stats = await this.safeLstat(record.path);
    const observation: FilesystemFileObservation = { kind: 'file', metadata: this.metadata(record.path, 'file', stats) };
    if (maxTextBytes !== undefined) {
      const maxBytes = boundedLimit(maxTextBytes, DEFAULT_MAX_TEXT_BYTES, HARD_MAX_TEXT_BYTES);
      const read = await this.readFile(record, maxBytes);
      observation.content = read.content;
      observation.contentEncoding = 'utf8';
      observation.contentBytes = read.contentBytes;
    }
    return observation;
  }

  private async readFile(record: IdentityRecord, maxBytes: number): Promise<{ content: string; contentBytes: number }> {
    let handle;
    try {
      const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
      handle = await open(record.path, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      mapFsError(error, record.path);
    }
    try {
      const before = await handle.stat({ bigint: true }) as unknown as BigStats;
      if (!before.isFile() || identityKey(before) !== record.key || before.dev.toString() !== this.rootDevice) {
        throw new FilesystemAdapterError('filesystem-target-stale', 'file identity changed before bounded read');
      }
      const buffer = Buffer.allocUnsafe(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      const bytes = buffer.subarray(0, bytesRead);
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new FilesystemAdapterError('filesystem-binary-content', 'bounded file read supports UTF-8 text only');
      }
      const after = await handle.stat({ bigint: true }) as unknown as BigStats;
      if (identityKey(after) !== record.key) {
        throw new FilesystemAdapterError('filesystem-race-detected', 'file identity changed during bounded read');
      }
      return { content, contentBytes: bytesRead };
    } finally {
      await handle.close();
    }
  }
}
