import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { validateComputerActionRequest } from './environmentAdapter.js';
import type {
  ComputerEffectClass,
  ComputerActionIdempotency,
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
const DEFAULT_MAX_MUTATION_BYTES = 64 * 1024;
export const HARD_MAX_MUTATION_BYTES = 1024 * 1024;

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
  | 'filesystem-limit-invalid'
  | 'filesystem-destination-exists'
  | 'filesystem-approval-required'
  | 'filesystem-plan-stale'
  | 'filesystem-plan-consumed'
  | 'filesystem-hardlink-overwrite-rejected';

export class FilesystemAdapterError extends Error {
  constructor(readonly code: FilesystemErrorCode, message: string) {
    super(message);
    this.name = 'FilesystemAdapterError';
  }
}

export interface FilesystemMutationApproval {
  readonly approved: true;
  readonly approvalId: string;
  readonly effect: 'local-destructive';
  readonly planId: string;
}

export interface FilesystemApprovalVerifier {
  verify(
    request: Readonly<Pick<ComputerActionRequest, 'actionId' | 'capability' | 'effect'>>,
    approval: Readonly<FilesystemMutationApproval>,
    summary: Readonly<FilesystemPreparedMutation['summary']>,
  ): Promise<boolean>;
}

export interface FilesystemComputerEnvironmentAdapterOptions {
  adapterId: string;
  rootPath: string;
  mutationDispatcher?: FilesystemMutationDispatcher;
  approvalVerifier?: FilesystemApprovalVerifier;
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
}

export interface FilesystemReadDetails {
  content: string;
  contentEncoding: 'utf8';
  contentBytes: number;
  totalBytes: number;
  truncated: boolean;
}

export type FilesystemMutationIntent =
  | { operation: 'create-file'; path: string; content: string; maxBytes?: number }
  | { operation: 'write-file'; path: string; expectedTarget: ComputerEntityRef; content: string; maxBytes?: number; overwrite: true }
  | { operation: 'create-directory'; path: string }
  | { operation: 'copy'; sourcePath: string; expectedSource: ComputerEntityRef; destinationPath: string; maxBytes?: number; overwrite?: boolean; expectedDestination?: ComputerEntityRef }
  | { operation: 'move'; sourcePath: string; expectedSource: ComputerEntityRef; destinationPath: string; overwrite?: boolean; expectedDestination?: ComputerEntityRef }
  | { operation: 'delete'; path: string; expectedTarget: ComputerEntityRef; destructive: true }
  | { operation: 'remove-empty-directory'; path: string; expectedTarget: ComputerEntityRef; destructive: true };

export interface FilesystemPreparedMutation {
  readonly capability: string;
  readonly effect: Extract<ComputerEffectClass, 'local-reversible' | 'local-destructive'>;
  readonly idempotency: Extract<ComputerActionIdempotency, 'non-idempotent'>;
  readonly target?: ComputerEntityRef;
  readonly payload: Readonly<{ planId: string }>;
  readonly summary: Readonly<{
    operation: FilesystemMutationIntent['operation'];
    sourcePath?: string;
    destinationPath: string;
    materialBytes?: number;
    materialDigest?: string;
  }>;
}

interface IdentityRecord {
  kind: 'file' | 'directory';
  key: string;
  generation: number;
  fallbackRevision?: string;
  locators: Set<string>;
}

type BigStats = Awaited<ReturnType<typeof lstat>> & {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
  size: bigint;
  mode: bigint;
  nlink: bigint;
  mtimeMs: bigint | number;
};

export interface FilesystemObjectSnapshot {
  readonly kind: 'file' | 'directory';
  readonly key: string;
  readonly generation: number;
  readonly revision: string;
  readonly moveRevision: string;
  readonly linkCount: number;
  readonly fallbackRevision?: string;
}

export interface FilesystemPathSnapshot {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly parentPath: string;
  readonly parent: FilesystemObjectSnapshot;
  readonly leaf?: FilesystemObjectSnapshot;
}

export interface FilesystemMaterialSnapshot {
  readonly bytes: Buffer;
  readonly digest: string;
}

interface PreparedPlan {
  readonly id: string;
  readonly capability: string;
  readonly effect: 'local-reversible' | 'local-destructive';
  readonly idempotency: 'non-idempotent';
  readonly operation: FilesystemMutationIntent['operation'];
  readonly source?: FilesystemPathSnapshot;
  readonly destination: FilesystemPathSnapshot;
  readonly material?: FilesystemMaterialSnapshot;
  readonly expectedSource?: ComputerEntityRef;
  readonly expectedDestination?: ComputerEntityRef;
  state: 'prepared' | 'authorizing' | 'dispatching' | 'done' | 'unknown';
}

export type FilesystemMutationDispatch =
  | { readonly operation: 'create-file'; readonly destination: FilesystemPathSnapshot; readonly material: FilesystemMaterialSnapshot }
  | { readonly operation: 'write-file'; readonly destination: FilesystemPathSnapshot; readonly material: FilesystemMaterialSnapshot }
  | { readonly operation: 'create-directory'; readonly destination: FilesystemPathSnapshot }
  | { readonly operation: 'copy'; readonly source: FilesystemPathSnapshot; readonly destination: FilesystemPathSnapshot; readonly material: FilesystemMaterialSnapshot }
  | { readonly operation: 'move'; readonly source: FilesystemPathSnapshot; readonly destination: FilesystemPathSnapshot }
  | { readonly operation: 'delete'; readonly source: FilesystemPathSnapshot; readonly destination: FilesystemPathSnapshot }
  | { readonly operation: 'remove-empty-directory'; readonly source: FilesystemPathSnapshot; readonly destination: FilesystemPathSnapshot };

export interface FilesystemMutationDispatcher {
  dispatch(mutation: Readonly<FilesystemMutationDispatch>, rootDevice: string): Promise<void>;
}

class MutationNotDispatchedError extends Error {
  constructor(readonly causeCode: FilesystemErrorCode) {
    super(causeCode);
    this.name = 'MutationNotDispatchedError';
  }
}

function safeNumber(value: bigint | number): number {
  const n = typeof value === 'bigint' ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}
function birthtimeReliable(stats: BigStats): boolean { return stats.birthtimeNs > 0n; }
function objectKey(stats: BigStats): string {
  const birth = birthtimeReliable(stats) ? stats.birthtimeNs.toString(36) : 'u';
  return `fs2:${stats.dev.toString(36)}:${stats.ino.toString(36)}:${birth}`;
}
function fallbackRevision(stats: BigStats): string {
  return [stats.ctimeNs.toString(36), stats.mtimeNs.toString(36), stats.size.toString(36), stats.mode.toString(36)].join(':');
}
function snapshotRevision(stats: BigStats): string {
  return [objectKey(stats), stats.size.toString(36), stats.mtimeNs.toString(36), stats.ctimeNs.toString(36), stats.nlink.toString(36)].join(':');
}
function moveRevision(stats: BigStats): string {
  return [objectKey(stats), stats.size.toString(36), stats.mtimeNs.toString(36), stats.mode.toString(36), stats.nlink.toString(36)].join(':');
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
function fsCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
}
function mapFsError(error: unknown, path: string): never {
  const code = fsCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new FilesystemAdapterError('filesystem-target-missing', `filesystem target is missing: ${path}`);
  if (code === 'EACCES' || code === 'EPERM') throw new FilesystemAdapterError('filesystem-target-inaccessible', `filesystem target is inaccessible: ${path}`);
  if (code === 'ELOOP') throw new FilesystemAdapterError('filesystem-symlink-rejected', `symlink traversal rejected: ${path}`);
  throw error;
}
function boundedLimit(value: number | undefined, fallback: number, hardMax: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > hardMax) throw new FilesystemAdapterError('filesystem-limit-invalid', `limit must be between 1 and ${hardMax}`);
  return selected;
}
function withinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
function compareNames(left: string, right: string): number { return Buffer.from(left).compare(Buffer.from(right)); }
function insertBoundedName(names: string[], name: string, capacity: number): void {
  let low = 0; let high = names.length;
  while (low < high) { const mid = (low + high) >>> 1; if (compareNames(names[mid], name) <= 0) low = mid + 1; else high = mid; }
  names.splice(low, 0, name); if (names.length > capacity) names.pop();
}
function utf8Boundary(bytes: Buffer, limit: number): number {
  if (limit <= 0 || bytes.length === 0) return 0;
  const end = Math.min(limit, bytes.length); let start = end - 1;
  while (start >= 0 && (bytes[start] & 0xc0) === 0x80 && end - start <= 4) start -= 1;
  if (start < 0) return end;
  const lead = bytes[start]; let expected = 1;
  if ((lead & 0x80) === 0) expected = 1;
  else if ((lead & 0xe0) === 0xc0) expected = 2;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xf8) === 0xf0) expected = 4;
  else return end;
  return end - start < expected ? start : end;
}
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function ownData(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value); const captured: Record<string, unknown> = {};
    for (const key of keys) { const descriptor = descriptors[key]; if (descriptor && !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined; if (descriptor) captured[key] = descriptor.value; }
    return Object.freeze(captured);
  } catch { return undefined; }
}
function cloneRef(value: unknown): ComputerEntityRef | undefined {
  const captured = ownData(value, ['adapterId', 'environment', 'kind', 'entityId', 'surfaceId', 'generation']);
  if (!captured || typeof captured.adapterId !== 'string' || captured.environment !== 'filesystem' || (captured.kind !== 'file' && captured.kind !== 'directory') || typeof captured.entityId !== 'string' || typeof captured.surfaceId !== 'string' || typeof captured.generation !== 'number' || !Number.isSafeInteger(captured.generation)) return undefined;
  return Object.freeze({ adapterId: captured.adapterId, environment: 'filesystem', kind: captured.kind, entityId: captured.entityId, surfaceId: captured.surfaceId, generation: captured.generation });
}

type SnapshottedIntent =
  | { operation: 'create-file'; path: string; content: string; maxBytes?: number }
  | { operation: 'write-file'; path: string; expectedTarget: ComputerEntityRef; content: string; maxBytes?: number; overwrite: true }
  | { operation: 'create-directory'; path: string }
  | { operation: 'copy'; sourcePath: string; expectedSource: ComputerEntityRef; destinationPath: string; maxBytes?: number; overwrite: boolean; expectedDestination?: ComputerEntityRef }
  | { operation: 'move'; sourcePath: string; expectedSource: ComputerEntityRef; destinationPath: string; overwrite: boolean; expectedDestination?: ComputerEntityRef }
  | { operation: 'delete'; path: string; expectedTarget: ComputerEntityRef; destructive: true }
  | { operation: 'remove-empty-directory'; path: string; expectedTarget: ComputerEntityRef; destructive: true };

function snapshotMutationIntent(value: unknown): SnapshottedIntent | undefined {
  const base = ownData(value, ['operation','path','content','maxBytes','expectedTarget','sourcePath','expectedSource','destinationPath','overwrite','expectedDestination','destructive']);
  if (!base || typeof base.operation !== 'string') return undefined;
  const maxBytes = base.maxBytes === undefined ? undefined : base.maxBytes;
  if (maxBytes !== undefined && (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes))) return undefined;
  switch (base.operation) {
    case 'create-file':
      if (typeof base.path !== 'string' || typeof base.content !== 'string') return undefined;
      return Object.freeze({ operation: 'create-file', path: base.path, content: base.content, ...(maxBytes === undefined ? {} : { maxBytes }) });
    case 'write-file': {
      const expectedTarget = cloneRef(base.expectedTarget);
      if (typeof base.path !== 'string' || typeof base.content !== 'string' || !expectedTarget || base.overwrite !== true) return undefined;
      return Object.freeze({ operation: 'write-file', path: base.path, expectedTarget, content: base.content, overwrite: true, ...(maxBytes === undefined ? {} : { maxBytes }) });
    }
    case 'create-directory':
      if (typeof base.path !== 'string') return undefined;
      return Object.freeze({ operation: 'create-directory', path: base.path });
    case 'copy':
    case 'move': {
      const expectedSource = cloneRef(base.expectedSource); const expectedDestination = base.expectedDestination === undefined ? undefined : cloneRef(base.expectedDestination);
      if (typeof base.sourcePath !== 'string' || typeof base.destinationPath !== 'string' || !expectedSource || (base.expectedDestination !== undefined && !expectedDestination) || (base.overwrite !== undefined && typeof base.overwrite !== 'boolean')) return undefined;
      if (base.operation === 'copy') return Object.freeze({ operation: 'copy', sourcePath: base.sourcePath, expectedSource, destinationPath: base.destinationPath, overwrite: base.overwrite === true, ...(expectedDestination ? { expectedDestination } : {}), ...(maxBytes === undefined ? {} : { maxBytes }) });
      return Object.freeze({ operation: 'move', sourcePath: base.sourcePath, expectedSource, destinationPath: base.destinationPath, overwrite: base.overwrite === true, ...(expectedDestination ? { expectedDestination } : {}) });
    }
    case 'delete':
    case 'remove-empty-directory': {
      const expectedTarget = cloneRef(base.expectedTarget);
      if (typeof base.path !== 'string' || !expectedTarget || base.destructive !== true) return undefined;
      return Object.freeze({ operation: base.operation, path: base.path, expectedTarget, destructive: true });
    }
    default: return undefined;
  }
}
function snapshotApproval(value: unknown): FilesystemMutationApproval | undefined {
  const captured = ownData(value, ['approved', 'approvalId', 'effect', 'planId']);
  if (!captured || captured.approved !== true || typeof captured.approvalId !== 'string' || captured.approvalId.length < 1 || Buffer.byteLength(captured.approvalId, 'utf8') > 192 || /[\r\n\0]/u.test(captured.approvalId) || captured.effect !== 'local-destructive' || typeof captured.planId !== 'string') return undefined;
  return Object.freeze({ approved: true, approvalId: captured.approvalId, effect: 'local-destructive', planId: captured.planId });
}
function sameRefIdentity(ref: ComputerEntityRef | undefined, snapshot: FilesystemObjectSnapshot | undefined): boolean {
  return !!ref && !!snapshot && ref.kind === snapshot.kind && ref.entityId === snapshot.key && ref.generation === snapshot.generation;
}
async function directLstat(path: string): Promise<BigStats | undefined> {
  try { return await lstat(path, { bigint: true }) as unknown as BigStats; }
  catch (error) { if (fsCode(error) === 'ENOENT' || fsCode(error) === 'ENOTDIR') return undefined; mapFsError(error, path); }
}
function matchesObject(stats: BigStats, expected: FilesystemObjectSnapshot, rootDevice: string): boolean {
  return stats.dev.toString() === rootDevice && statKind(stats) === expected.kind && objectKey(stats) === expected.key && snapshotRevision(stats) === expected.revision && (birthtimeReliable(stats) || fallbackRevision(stats) === expected.fallbackRevision);
}
function matchesMovedObject(stats: BigStats, expected: FilesystemObjectSnapshot, rootDevice: string): boolean {
  return stats.dev.toString() === rootDevice && statKind(stats) === expected.kind && objectKey(stats) === expected.key && moveRevision(stats) === expected.moveRevision;
}
async function dispatchLeafStats(path: string): Promise<BigStats | undefined> {
  const stats = await directLstat(path); if (stats?.isSymbolicLink()) throw new MutationNotDispatchedError('filesystem-symlink-rejected'); return stats;
}

async function overwriteMaterial(destination: FilesystemPathSnapshot, material: FilesystemMaterialSnapshot, rootDevice: string): Promise<void> {
  const expected = destination.leaf; if (!expected) throw new MutationNotDispatchedError('filesystem-race-detected');
  let handle;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(destination.absolutePath, fsConstants.O_WRONLY | noFollow);
    const current = await handle.stat({ bigint: true }) as unknown as BigStats;
    if (!matchesObject(current, expected, rootDevice)) throw new MutationNotDispatchedError('filesystem-race-detected');
    await handle.truncate(0); await handle.writeFile(material.bytes); await handle.sync();
  } finally { await handle?.close(); }
}

export class HostFilesystemMutationDispatcher implements FilesystemMutationDispatcher {
  async dispatch(mutation: Readonly<FilesystemMutationDispatch>, rootDevice: string): Promise<void> {
    const destination = mutation.destination;
    const parentStats = await dispatchLeafStats(destination.parentPath);
    if (!parentStats || !matchesObject(parentStats, destination.parent, rootDevice)) throw new MutationNotDispatchedError('filesystem-race-detected');
    const destinationStats = await dispatchLeafStats(destination.absolutePath);
    if (destination.leaf) { if (!destinationStats || !matchesObject(destinationStats, destination.leaf, rootDevice)) throw new MutationNotDispatchedError('filesystem-race-detected'); }
    else if (destinationStats) throw new MutationNotDispatchedError('filesystem-race-detected');
    if ('source' in mutation) {
      const sourceStats = await dispatchLeafStats(mutation.source.absolutePath);
      if (!sourceStats || !mutation.source.leaf || !matchesObject(sourceStats, mutation.source.leaf, rootDevice)) throw new MutationNotDispatchedError('filesystem-race-detected');
    }
    switch (mutation.operation) {
      case 'create-file':
        try { await writeFile(destination.absolutePath, mutation.material.bytes, { flag: 'wx' }); }
        catch (error) { if (fsCode(error) === 'EEXIST' || fsCode(error) === 'ELOOP') throw new MutationNotDispatchedError('filesystem-race-detected'); throw error; }
        return;
      case 'copy':
        if (destination.leaf) { await overwriteMaterial(destination, mutation.material, rootDevice); return; }
        try { await writeFile(destination.absolutePath, mutation.material.bytes, { flag: 'wx' }); }
        catch (error) { if (fsCode(error) === 'EEXIST' || fsCode(error) === 'ELOOP') throw new MutationNotDispatchedError('filesystem-race-detected'); throw error; }
        return;
      case 'write-file': await overwriteMaterial(destination, mutation.material, rootDevice); return;
      case 'create-directory':
        try { await mkdir(destination.absolutePath); }
        catch (error) { if (fsCode(error) === 'EEXIST' || fsCode(error) === 'ELOOP') throw new MutationNotDispatchedError('filesystem-race-detected'); throw error; }
        return;
      case 'move': await rename(mutation.source.absolutePath, destination.absolutePath); return;
      case 'delete': await unlink(mutation.source.absolutePath); return;
      case 'remove-empty-directory': await rmdir(mutation.source.absolutePath); return;
    }
  }
}

export class FilesystemComputerEnvironmentAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor: ComputerEnvironmentAdapterDescriptor;
  private readonly rootInput: string;
  private readonly mutationDispatcher: FilesystemMutationDispatcher;
  private readonly approvalVerifier?: FilesystemApprovalVerifier;
  private initialized?: Promise<void>;
  private rootPath = '';
  private rootDevice = '';
  private rootIdentity?: IdentityRecord;
  private rootSurface?: ComputerSurfaceRef;
  private sequence = 0;
  private readonly identities = new Map<string, IdentityRecord>();
  private readonly plans = new Map<string, PreparedPlan>();

  constructor(options: FilesystemComputerEnvironmentAdapterOptions) {
    if (!options.adapterId || /[\r\n\0]/.test(options.adapterId)) throw new FilesystemAdapterError('filesystem-invalid-request', 'adapterId must be a bounded opaque identifier');
    this.rootInput = resolve(options.rootPath);
    this.mutationDispatcher = options.mutationDispatcher ?? new HostFilesystemMutationDispatcher();
    this.approvalVerifier = options.approvalVerifier;
    this.descriptor = Object.freeze({ id: options.adapterId, kind: 'filesystem' as const, version: '2', capabilities: Object.freeze(['filesystem.read','filesystem.create-file','filesystem.write-file','filesystem.create-directory','filesystem.copy','filesystem.move','filesystem.delete','filesystem.remove-empty-directory']) });
  }

  async root(): Promise<{ surface: ComputerSurfaceRef; directory: ComputerEntityRef }> {
    await this.ensureInitialized(); return { surface: { ...this.rootSurface! }, directory: this.refFor(this.rootIdentity!) };
  }
  async resolvePath(relativePath: string): Promise<ComputerEntityRef> {
    await this.ensureInitialized(); const candidate = this.scopedAbsolute(relativePath); await this.validatePathSegments(candidate, false);
    const stats = await this.safeLstat(candidate); const kind = statKind(stats);
    if (kind !== 'file' && kind !== 'directory') throw new FilesystemAdapterError('filesystem-target-kind-mismatch', 'only files and directories have resolvable entity refs');
    return this.registerIdentity(candidate, kind, stats);
  }

  async prepareMutation(intentInput: FilesystemMutationIntent): Promise<FilesystemPreparedMutation> {
    const intent = snapshotMutationIntent(intentInput);
    if (!intent) throw new FilesystemAdapterError('filesystem-invalid-request', 'mutation intent must contain plain, narrowly typed data');
    if ('content' in intent) {
      const max = boundedLimit(intent.maxBytes, DEFAULT_MAX_MUTATION_BYTES, HARD_MAX_MUTATION_BYTES);
      if (Buffer.byteLength(intent.content, 'utf8') > max) throw new FilesystemAdapterError('filesystem-limit-invalid', 'write material exceeds the bounded mutation payload limit');
    }
    await this.ensureInitialized();
    let source: FilesystemPathSnapshot | undefined; let destination: FilesystemPathSnapshot; let material: FilesystemMaterialSnapshot | undefined;
    let expectedSource: ComputerEntityRef | undefined; let expectedDestination: ComputerEntityRef | undefined; let target: ComputerEntityRef | undefined;
    let effect: PreparedPlan['effect']; let capability: string;
    switch (intent.operation) {
      case 'create-file': destination = await this.snapshotPath(intent.path, true); this.requireMissingDestination(destination); material = this.materialFromText(intent.content); effect = 'local-reversible'; capability = 'filesystem.create-file'; break;
      case 'write-file':
        destination = await this.snapshotPath(intent.path, false); await this.requireExpected(destination, intent.expectedTarget, 'file'); this.rejectHardlinkOverwrite(destination); material = this.materialFromText(intent.content); expectedDestination = intent.expectedTarget; target = intent.expectedTarget; effect = 'local-destructive'; capability = 'filesystem.write-file'; break;
      case 'create-directory': destination = await this.snapshotPath(intent.path, true); this.requireMissingDestination(destination); effect = 'local-reversible'; capability = 'filesystem.create-directory'; break;
      case 'copy':
        source = await this.snapshotPath(intent.sourcePath, false); await this.requireExpected(source, intent.expectedSource, 'file'); destination = await this.snapshotPath(intent.destinationPath, true);
        if (source.absolutePath === destination.absolutePath) throw new FilesystemAdapterError('filesystem-invalid-request', 'copy source and destination must be distinct paths');
        this.checkOverwrite(destination, intent.overwrite, intent.expectedDestination); if (destination.leaf) this.rejectHardlinkOverwrite(destination); expectedSource = intent.expectedSource; expectedDestination = intent.expectedDestination; target = intent.expectedSource;
        material = await this.acquireCopyMaterial(source, boundedLimit(intent.maxBytes, HARD_MAX_MUTATION_BYTES, HARD_MAX_MUTATION_BYTES)); effect = destination.leaf ? 'local-destructive' : 'local-reversible'; capability = 'filesystem.copy'; break;
      case 'move':
        source = await this.snapshotPath(intent.sourcePath, false); await this.requireExpected(source, intent.expectedSource); if (source.leaf?.kind === 'directory') await this.assertEmptyDirectory(source.absolutePath, source.leaf);
        destination = await this.snapshotPath(intent.destinationPath, true); if (source.absolutePath === destination.absolutePath) throw new FilesystemAdapterError('filesystem-invalid-request', 'move source and destination must be distinct paths');
        this.checkOverwrite(destination, intent.overwrite, intent.expectedDestination); if (destination.leaf?.kind === 'directory') await this.assertEmptyDirectory(destination.absolutePath, destination.leaf);
        expectedSource = intent.expectedSource; expectedDestination = intent.expectedDestination; target = intent.expectedSource; effect = destination.leaf ? 'local-destructive' : 'local-reversible'; capability = 'filesystem.move'; break;
      case 'delete': source = await this.snapshotPath(intent.path, false); await this.requireExpected(source, intent.expectedTarget, 'file'); destination = source; expectedSource = intent.expectedTarget; target = intent.expectedTarget; effect = 'local-destructive'; capability = 'filesystem.delete'; break;
      case 'remove-empty-directory':
        source = await this.snapshotPath(intent.path, false); await this.requireExpected(source, intent.expectedTarget, 'directory'); if (source.absolutePath === this.rootPath) throw new FilesystemAdapterError('filesystem-invalid-request', 'scoped root cannot be removed');
        await this.assertEmptyDirectory(source.absolutePath, source.leaf!); destination = source; expectedSource = intent.expectedTarget; target = intent.expectedTarget; effect = 'local-destructive'; capability = 'filesystem.remove-empty-directory'; break;
    }
    const id = randomUUID();
    const plan: PreparedPlan = { id, capability, effect, idempotency: 'non-idempotent', operation: intent.operation, source, destination, material, expectedSource, expectedDestination, state: 'prepared' };
    this.plans.set(id, plan);
    return Object.freeze({ capability, effect, idempotency: 'non-idempotent' as const, ...(target ? { target: Object.freeze({ ...target }) } : {}), payload: Object.freeze({ planId: id }), summary: this.summaryForPlan(plan) });
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    await this.ensureInitialized(); this.validateObservationRequest(request); const record = request.target ? await this.recordForRef(request.target) : this.rootIdentity!;
    let data: FilesystemDirectoryObservation | FilesystemFileObservation; let truncated = false;
    if (record.kind === 'directory') { const directory = await this.observeDirectory(record, request.limits?.maxItems, request.limits?.maxTextBytes); data = directory.data; truncated = directory.truncated; }
    else data = await this.observeFile(record);
    return { adapterId: this.descriptor.id, environment: 'filesystem', channel: 'filesystem', sequence: this.sequence++, complete: !truncated, truncated, surface: request.surface ? { ...request.surface } : { ...this.rootSurface! }, target: request.target ? { ...request.target } : this.refFor(record), data };
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    if (validateComputerActionRequest(request, this.descriptor).length > 0) return { status: 'rejected', dispatch: 'not-dispatched', verification: 'rejected', evidence: ['filesystem-action-request-rejected'] };
    if (request.capability === 'filesystem.read') return this.actRead(request);
    if (!this.descriptor.capabilities.includes(request.capability)) return { status: 'unsupported', dispatch: 'not-dispatched', verification: 'unverified', evidence: ['filesystem-capability-unsupported'] };
    const payload = ownData(request.payload, ['planId', 'approval']); const planId = payload?.planId; const approval = payload?.approval === undefined ? undefined : snapshotApproval(payload.approval);
    if (typeof planId !== 'string') return { status: 'rejected', dispatch: 'not-dispatched', verification: 'rejected', evidence: ['filesystem-invalid-request'] };
    const plan = this.plans.get(planId);
    if (!plan || plan.capability !== request.capability) return { status: 'rejected', dispatch: 'not-dispatched', verification: 'rejected', evidence: ['filesystem-plan-stale'] };
    if (plan.state !== 'prepared') return { status: 'rejected', dispatch: 'not-dispatched', verification: 'rejected', evidence: ['filesystem-plan-consumed'] };
    if (request.effect !== plan.effect || request.idempotency !== plan.idempotency) return { status: 'rejected', dispatch: 'not-dispatched', verification: 'rejected', evidence: ['filesystem-invalid-request'] };
    plan.state = 'authorizing';
    if (plan.effect === 'local-destructive') {
      if (!approval || approval.planId !== plan.id || !this.approvalVerifier) {
        plan.state = 'prepared';
        return { status: 'rejected', dispatch: 'not-dispatched', verification: 'rejected', evidence: ['filesystem-approval-required'] };
      }
      let approved = false;
      try { approved = await this.approvalVerifier.verify(Object.freeze({ actionId: request.actionId, capability: request.capability, effect: request.effect }), approval, this.summaryForPlan(plan)); } catch { approved = false; }
      if (!approved) {
        plan.state = 'prepared';
        return { status: 'rejected', dispatch: 'not-dispatched', verification: 'rejected', evidence: ['filesystem-approval-required'] };
      }
    } else if (approval !== undefined) {
      plan.state = 'prepared';
      return { status: 'rejected', dispatch: 'not-dispatched', verification: 'rejected', evidence: ['filesystem-invalid-request'] };
    }
    try { await this.ensureInitialized(); await this.revalidatePlan(plan); }
    catch (error) {
      plan.state = 'prepared';
      return { status: 'rejected', dispatch: 'not-dispatched', verification: 'rejected', evidence: [evidenceFor(error)] };
    }
    plan.state = 'dispatching';
    try { await this.mutationDispatcher.dispatch(this.toDispatch(plan), this.rootDevice); }
    catch (error) {
      if (error instanceof MutationNotDispatchedError) { plan.state = 'prepared'; return { status: 'rejected', dispatch: 'not-dispatched', verification: 'rejected', evidence: [error.causeCode] }; }
      plan.state = 'unknown'; return { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: ['filesystem-mutation-dispatch-unknown'] };
    }
    plan.state = 'done';
    try { const details = await this.verifyPlan(plan); return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified', evidence: ['filesystem-mutation-verified'], details }; }
    catch (error) { return { status: 'unknown', dispatch: 'dispatched-once', verification: 'mismatch', evidence: [error instanceof FilesystemAdapterError ? error.code : 'filesystem-race-detected'] }; }
  }

  private async actRead(request: ComputerActionRequest): Promise<ComputerActionResult> {
    if (request.effect !== 'observe-only' || request.idempotency !== 'read-only' || !request.target || request.target.kind !== 'file') return { status: 'rejected', dispatch: 'not-dispatched', verification: 'rejected', evidence: ['filesystem-read-request-rejected'] };
    const payload = ownData(request.payload, ['maxBytes']);
    try {
      await this.ensureInitialized(); const rawMax = payload?.maxBytes; const maxBytes = boundedLimit(typeof rawMax === 'number' ? rawMax : undefined, DEFAULT_MAX_TEXT_BYTES, HARD_MAX_TEXT_BYTES);
      const record = await this.recordForRef(request.target); if (record.kind !== 'file') throw new FilesystemAdapterError('filesystem-target-kind-mismatch', 'read target is not a file');
      const details = await this.readFile(record, maxBytes); return { status: 'completed', dispatch: 'not-dispatched', verification: 'verified', evidence: ['filesystem-read-bounded'], details };
    } catch (error) {
      const code = evidenceFor(error); const rejected = code === 'filesystem-generation-mismatch' || code === 'filesystem-target-stale' || code === 'filesystem-limit-invalid';
      return { status: rejected ? 'rejected' : 'failed', dispatch: 'not-dispatched', verification: 'rejected', evidence: [code] };
    }
  }

  private scopedAbsolute(relativePath: string): string {
    if (relativePath.length === 0 || relativePath.includes('\0') || isAbsolute(relativePath)) throw new FilesystemAdapterError('filesystem-path-traversal', 'paths must be non-empty relative paths inside the scoped root');
    const candidate = resolve(this.rootPath, relativePath); if (!withinRoot(this.rootPath, candidate)) throw new FilesystemAdapterError('filesystem-path-traversal', 'path escapes the scoped filesystem root'); return candidate;
  }
  private async validatePathSegments(candidate: string, allowMissingLeaf: boolean): Promise<void> {
    const rel = relative(this.rootPath, candidate); const segments = rel === '' ? [] : rel.split(sep); let current = this.rootPath;
    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index]); const isLeaf = index === segments.length - 1; const stats = await directLstat(current);
      if (!stats && allowMissingLeaf && isLeaf) return; if (!stats) throw new FilesystemAdapterError('filesystem-target-missing', `filesystem target is missing: ${current}`);
      if (stats.isSymbolicLink()) throw new FilesystemAdapterError('filesystem-symlink-rejected', 'path resolution does not follow symlinks');
      if (stats.dev.toString() !== this.rootDevice) throw new FilesystemAdapterError('filesystem-mount-boundary', 'path resolution crossed a mount/device boundary');
      await this.assertCanonicalPath(current); if (!isLeaf && !stats.isDirectory()) throw new FilesystemAdapterError('filesystem-target-kind-mismatch', 'non-directory encountered during path resolution');
    }
  }
  private async snapshotPath(relativePath: string, allowMissingLeaf: boolean): Promise<FilesystemPathSnapshot> {
    const absolutePath = this.scopedAbsolute(relativePath); if (absolutePath === this.rootPath && allowMissingLeaf) throw new FilesystemAdapterError('filesystem-invalid-request', 'mutation destination cannot be the scoped root');
    await this.validatePathSegments(absolutePath, allowMissingLeaf); const parentPath = dirname(absolutePath);
    if (!withinRoot(this.rootPath, parentPath)) throw new FilesystemAdapterError('filesystem-path-traversal', 'destination parent escapes root');
    const parentStats = await this.safeLstat(parentPath); if (!parentStats.isDirectory() || parentStats.dev.toString() !== this.rootDevice) throw new FilesystemAdapterError('filesystem-mount-boundary', 'mutation parent crossed a device boundary');
    await this.assertCanonicalPath(parentPath); const parentRef = this.registerIdentity(parentPath, 'directory', parentStats); const parent = this.objectSnapshot(this.identities.get(parentRef.entityId)!, parentStats);
    const leafStats = await directLstat(absolutePath); let leaf: FilesystemObjectSnapshot | undefined;
    if (leafStats) {
      if (leafStats.isSymbolicLink()) throw new FilesystemAdapterError('filesystem-symlink-rejected', 'mutation never follows symlink leaves');
      if (leafStats.dev.toString() !== this.rootDevice) throw new FilesystemAdapterError('filesystem-mount-boundary', 'mutation leaf crossed a device boundary');
      const kind = statKind(leafStats); if (kind !== 'file' && kind !== 'directory') throw new FilesystemAdapterError('filesystem-target-kind-mismatch', 'mutation supports only files and directories');
      await this.assertCanonicalPath(absolutePath); const ref = this.registerIdentity(absolutePath, kind, leafStats); leaf = this.objectSnapshot(this.identities.get(ref.entityId)!, leafStats);
    } else if (!allowMissingLeaf) throw new FilesystemAdapterError('filesystem-target-missing', 'mutation source is missing');
    return Object.freeze({ relativePath: relative(this.rootPath, absolutePath), absolutePath, parentPath, parent, ...(leaf ? { leaf } : {}) });
  }
  private objectSnapshot(record: IdentityRecord, stats: BigStats): FilesystemObjectSnapshot {
    return Object.freeze({ kind: record.kind, key: record.key, generation: record.generation, revision: snapshotRevision(stats), moveRevision: moveRevision(stats), linkCount: safeNumber(stats.nlink), ...(record.fallbackRevision === undefined ? {} : { fallbackRevision: record.fallbackRevision }) });
  }
  private requireMissingDestination(destination: FilesystemPathSnapshot): void { if (destination.leaf) throw new FilesystemAdapterError('filesystem-destination-exists', 'destination already exists'); }
  private rejectHardlinkOverwrite(destination: FilesystemPathSnapshot): void {
    if (destination.leaf && destination.leaf.linkCount > 1) throw new FilesystemAdapterError('filesystem-hardlink-overwrite-rejected', 'in-place overwrite of a hardlinked file would mutate unnamed aliases');
  }
  private async requireExpected(snapshot: FilesystemPathSnapshot, ref: ComputerEntityRef, kind?: 'file' | 'directory'): Promise<void> {
    await this.recordForRef(ref); if (!snapshot.leaf || !sameRefIdentity(ref, snapshot.leaf) || (kind && snapshot.leaf.kind !== kind)) throw new FilesystemAdapterError('filesystem-target-stale', 'path no longer names the expected generation-aware object');
  }
  private checkOverwrite(destination: FilesystemPathSnapshot, overwrite: boolean, expected?: ComputerEntityRef): void {
    if (!destination.leaf) { if (expected) throw new FilesystemAdapterError('filesystem-target-stale', 'expected destination is missing'); return; }
    if (!overwrite) throw new FilesystemAdapterError('filesystem-destination-exists', 'destination exists and overwrite was not explicit');
    if (!expected || !sameRefIdentity(expected, destination.leaf)) throw new FilesystemAdapterError('filesystem-target-stale', 'overwrite requires the expected destination identity');
  }
  private materialFromText(content: string): FilesystemMaterialSnapshot { const bytes = Buffer.from(content, 'utf8'); return Object.freeze({ bytes: Buffer.from(bytes), digest: digest(bytes) }); }
  private async acquireCopyMaterial(source: FilesystemPathSnapshot, maxBytes: number): Promise<FilesystemMaterialSnapshot> {
    if (!source.leaf || source.leaf.kind !== 'file') throw new FilesystemAdapterError('filesystem-target-kind-mismatch', 'copy source must be a file');
    let handle;
    try {
      const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0; handle = await open(source.absolutePath, fsConstants.O_RDONLY | noFollow);
      const before = await handle.stat({ bigint: true }) as unknown as BigStats; if (!matchesObject(before, source.leaf, this.rootDevice)) throw new FilesystemAdapterError('filesystem-race-detected', 'copy source changed before acquisition');
      if (before.size > BigInt(maxBytes)) throw new FilesystemAdapterError('filesystem-limit-invalid', 'copy source exceeds bounded material acquisition');
      const capacity = safeNumber(before.size); const bytes = Buffer.allocUnsafe(capacity); let offset = 0;
      while (offset < capacity) { const result = await handle.read(bytes, offset, capacity - offset, offset); if (result.bytesRead === 0) break; offset += result.bytesRead; }
      if (offset !== capacity) throw new FilesystemAdapterError('filesystem-race-detected', 'copy source shortened during acquisition');
      const after = await handle.stat({ bigint: true }) as unknown as BigStats; if (!matchesObject(after, source.leaf, this.rootDevice)) throw new FilesystemAdapterError('filesystem-race-detected', 'copy source changed during acquisition');
      const owned = Buffer.from(bytes); return Object.freeze({ bytes: owned, digest: digest(owned) });
    } catch (error) { if (error instanceof FilesystemAdapterError) throw error; mapFsError(error, source.absolutePath); throw error; }
    finally { await handle?.close(); }
  }
  private async revalidateObjectPath(snapshot: FilesystemPathSnapshot, expectLeaf: boolean): Promise<void> {
    await this.validatePathSegments(snapshot.absolutePath, !expectLeaf); const parentStats = await this.safeLstat(snapshot.parentPath);
    if (!matchesObject(parentStats, snapshot.parent, this.rootDevice)) throw new FilesystemAdapterError('filesystem-race-detected', 'mutation parent identity changed after approval');
    const leafStats = await directLstat(snapshot.absolutePath);
    if (snapshot.leaf) { if (!leafStats || leafStats.isSymbolicLink() || !matchesObject(leafStats, snapshot.leaf, this.rootDevice)) throw new FilesystemAdapterError('filesystem-race-detected', 'mutation leaf identity changed after approval'); }
    else if (leafStats) throw new FilesystemAdapterError('filesystem-race-detected', 'mutation destination appeared after approval');
  }
  private async revalidatePlan(plan: PreparedPlan): Promise<void> {
    if (plan.source) { await this.revalidateObjectPath(plan.source, true); if (plan.expectedSource && !sameRefIdentity(plan.expectedSource, plan.source.leaf)) throw new FilesystemAdapterError('filesystem-target-stale', 'source expected identity changed'); if (plan.source.leaf?.kind === 'directory') await this.assertEmptyDirectory(plan.source.absolutePath, plan.source.leaf); }
    if (!plan.source || plan.destination.absolutePath !== plan.source.absolutePath) await this.revalidateObjectPath(plan.destination, !!plan.destination.leaf);
    if (plan.expectedDestination && !sameRefIdentity(plan.expectedDestination, plan.destination.leaf)) throw new FilesystemAdapterError('filesystem-target-stale', 'destination expected identity changed');
  }
  private summaryForPlan(plan: PreparedPlan): Readonly<FilesystemPreparedMutation['summary']> {
    return Object.freeze({ operation: plan.operation, ...(plan.source ? { sourcePath: plan.source.relativePath } : {}), destinationPath: plan.destination.relativePath, ...(plan.material ? { materialBytes: plan.material.bytes.byteLength, materialDigest: plan.material.digest } : {}) });
  }
  private toDispatch(plan: PreparedPlan): FilesystemMutationDispatch {
    switch (plan.operation) {
      case 'create-file': return { operation: 'create-file', destination: plan.destination, material: plan.material! };
      case 'write-file': return { operation: 'write-file', destination: plan.destination, material: plan.material! };
      case 'create-directory': return { operation: 'create-directory', destination: plan.destination };
      case 'copy': return { operation: 'copy', source: plan.source!, destination: plan.destination, material: plan.material! };
      case 'move': return { operation: 'move', source: plan.source!, destination: plan.destination };
      case 'delete': return { operation: 'delete', source: plan.source!, destination: plan.destination };
      case 'remove-empty-directory': return { operation: 'remove-empty-directory', source: plan.source!, destination: plan.destination };
    }
  }
  private async verifyPlan(plan: PreparedPlan): Promise<Record<string, unknown>> {
    switch (plan.operation) {
      case 'create-file':
      case 'write-file':
      case 'copy': {
        const leaf = await this.verifyMaterialDestination(plan.destination.absolutePath, plan.material!);
        if ((plan.operation === 'write-file' || (plan.operation === 'copy' && plan.destination.leaf)) && (!plan.destination.leaf || leaf.key !== plan.destination.leaf.key)) throw new FilesystemAdapterError('filesystem-race-detected', 'overwrite changed destination identity');
        return { operation: plan.operation, destination: plan.destination.relativePath, entity: this.refFor(this.identities.get(leaf.key)!), bytes: plan.material!.bytes.byteLength, digest: plan.material!.digest };
      }
      case 'create-directory': {
        const stats = await this.safeLstat(plan.destination.absolutePath); if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev.toString() !== this.rootDevice) throw new FilesystemAdapterError('filesystem-race-detected', 'created directory did not verify');
        await this.assertCanonicalPath(plan.destination.absolutePath); const ref = this.registerIdentity(plan.destination.absolutePath, 'directory', stats); return { operation: plan.operation, destination: plan.destination.relativePath, entity: ref };
      }
      case 'move': {
        const old = await directLstat(plan.source!.absolutePath); if (old) throw new FilesystemAdapterError('filesystem-race-detected', 'move source still exists after dispatch');
        const stats = await this.safeLstat(plan.destination.absolutePath); const expected = plan.source!.leaf!; if (!matchesMovedObject(stats, expected, this.rootDevice)) throw new FilesystemAdapterError('filesystem-race-detected', 'move destination is not the expected source object');
        await this.assertCanonicalPath(plan.destination.absolutePath); const record = this.identities.get(expected.key)!; record.locators.delete(plan.source!.absolutePath); record.locators.add(plan.destination.absolutePath);
        return { operation: plan.operation, source: plan.source!.relativePath, destination: plan.destination.relativePath, entity: this.refFor(record) };
      }
      case 'delete':
      case 'remove-empty-directory': {
        const old = await directLstat(plan.source!.absolutePath); if (old) throw new FilesystemAdapterError('filesystem-race-detected', 'deleted path still exists after dispatch');
        const record = this.identities.get(plan.source!.leaf!.key); record?.locators.delete(plan.source!.absolutePath); return { operation: plan.operation, deleted: plan.source!.relativePath };
      }
    }
  }
  private async verifyMaterialDestination(path: string, material: FilesystemMaterialSnapshot): Promise<FilesystemObjectSnapshot> {
    await this.validatePathSegments(path, false); let handle;
    try {
      const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0; handle = await open(path, fsConstants.O_RDONLY | noFollow);
      const before = await handle.stat({ bigint: true }) as unknown as BigStats;
      if (!before.isFile() || before.dev.toString() !== this.rootDevice || before.size !== BigInt(material.bytes.byteLength)) throw new FilesystemAdapterError('filesystem-race-detected', 'destination metadata does not match intended file');
      const bytes = Buffer.allocUnsafe(material.bytes.byteLength); let offset = 0;
      while (offset < bytes.byteLength) { const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset); if (result.bytesRead === 0) break; offset += result.bytesRead; }
      if (offset !== bytes.byteLength || digest(bytes) !== material.digest) throw new FilesystemAdapterError('filesystem-race-detected', 'destination content digest does not match intended material');
      const after = await handle.stat({ bigint: true }) as unknown as BigStats; if (snapshotRevision(after) !== snapshotRevision(before)) throw new FilesystemAdapterError('filesystem-race-detected', 'destination changed during verification');
      const ref = this.registerIdentity(path, 'file', after); return this.objectSnapshot(this.identities.get(ref.entityId)!, after);
    } finally { await handle?.close(); }
  }
  private async assertEmptyDirectory(path: string, expected: FilesystemObjectSnapshot): Promise<void> {
    let dir;
    try { dir = await opendir(path); const first = await dir.read(); if (first) throw new FilesystemAdapterError('filesystem-target-kind-mismatch', 'directory mutation is limited to empty directories'); }
    catch (error) { if (error instanceof FilesystemAdapterError) throw error; mapFsError(error, path); }
    finally { await dir?.close().catch(() => undefined); }
    const stats = await this.safeLstat(path); if (!matchesObject(stats, expected, this.rootDevice)) throw new FilesystemAdapterError('filesystem-race-detected', 'directory changed during emptiness check');
  }

  private async ensureInitialized(): Promise<void> { if (!this.initialized) this.initialized = this.initialize(); await this.initialized; }
  private async initialize(): Promise<void> {
    const inputStats = await this.safeLstat(this.rootInput); if (inputStats.isSymbolicLink()) throw new FilesystemAdapterError('filesystem-symlink-rejected', 'scoped root must not be a symlink'); if (!inputStats.isDirectory()) throw new FilesystemAdapterError('filesystem-target-kind-mismatch', 'scoped root must be a directory');
    const canonical = await realpath(this.rootInput).catch((error) => mapFsError(error, this.rootInput)); const stats = await this.safeLstat(canonical); this.rootPath = canonical; this.rootDevice = stats.dev.toString();
    const ref = this.registerIdentity(canonical, 'directory', stats); this.rootIdentity = this.identities.get(ref.entityId)!; this.rootSurface = Object.freeze({ adapterId: this.descriptor.id, environment: 'filesystem' as const, surfaceId: `mount:${objectKey(stats)}`, generation: this.rootIdentity.generation });
  }
  private validateObservationRequest(request: ComputerObservationRequest): void {
    if (request.adapterId !== this.descriptor.id || request.channel !== 'filesystem') throw new FilesystemAdapterError('filesystem-invalid-request', 'filesystem adapter accepts only its own filesystem observation channel');
    if (request.surface && (request.surface.adapterId !== this.descriptor.id || request.surface.environment !== 'filesystem' || request.surface.surfaceId !== this.rootSurface!.surfaceId || request.surface.generation !== this.rootSurface!.generation)) throw new FilesystemAdapterError('filesystem-target-stale', 'filesystem surface identity is stale or belongs to another adapter');
    if (request.limits?.maxDepth !== undefined && request.limits.maxDepth !== 1) throw new FilesystemAdapterError('filesystem-limit-invalid', 'filesystem directory observation is non-recursive and requires maxDepth=1 when specified');
    if (request.limits?.maxTextBytes !== undefined) boundedLimit(request.limits.maxTextBytes, DEFAULT_MAX_TEXT_BYTES, HARD_MAX_TEXT_BYTES);
  }
  private async safeLstat(path: string): Promise<BigStats> { try { return await lstat(path, { bigint: true }) as unknown as BigStats; } catch (error) { mapFsError(error, path); } }
  private async assertCanonicalPath(path: string): Promise<void> {
    let canonical: string; try { canonical = await realpath(path); } catch (error) { mapFsError(error, path); }
    const samePath = relative(path, canonical) === '' && relative(canonical, path) === ''; if (!samePath || !withinRoot(this.rootPath, canonical)) throw new FilesystemAdapterError('filesystem-symlink-rejected', 'filesystem path changed through a symlink or escaped the scoped root');
  }
  private registerIdentity(path: string, kind: 'file' | 'directory', stats: BigStats): ComputerEntityRef {
    const key = objectKey(stats); let record = this.identities.get(key); const revision = birthtimeReliable(stats) ? undefined : fallbackRevision(stats);
    if (!record) { record = { kind, key, generation: 0, fallbackRevision: revision, locators: new Set([path]) }; this.identities.set(key, record); }
    else { if (record.kind !== kind) { record.generation += 1; record.kind = kind; record.locators.clear(); record.fallbackRevision = revision; } else if (revision !== undefined && record.fallbackRevision !== revision) { record.generation += 1; record.locators.clear(); record.fallbackRevision = revision; } record.locators.add(path); }
    return this.refFor(record);
  }
  private refFor(record: IdentityRecord): ComputerEntityRef { return { adapterId: this.descriptor.id, environment: 'filesystem', kind: record.kind, entityId: record.key, surfaceId: this.rootSurface?.surfaceId, generation: record.generation }; }
  private async validLocator(record: IdentityRecord): Promise<{ path: string; stats: BigStats }> {
    for (const path of [...record.locators]) {
      try {
        await this.assertCanonicalPath(path); const stats = await this.safeLstat(path); await this.assertCanonicalPath(path);
        if (statKind(stats) === record.kind && objectKey(stats) === record.key && stats.dev.toString() === this.rootDevice && (birthtimeReliable(stats) || fallbackRevision(stats) === record.fallbackRevision)) return { path, stats };
        record.locators.delete(path);
      } catch (error) {
        if (error instanceof FilesystemAdapterError && (error.code === 'filesystem-target-missing' || error.code === 'filesystem-symlink-rejected')) { record.locators.delete(path); continue; }
        throw error;
      }
    }
    throw new FilesystemAdapterError('filesystem-target-stale', 'no validated locator remains for filesystem identity');
  }
  private async recordForRef(ref: ComputerEntityRef): Promise<IdentityRecord> {
    if (ref.adapterId !== this.descriptor.id || ref.environment !== 'filesystem' || (ref.kind !== 'file' && ref.kind !== 'directory')) throw new FilesystemAdapterError('filesystem-invalid-request', 'target ref does not belong to this filesystem adapter');
    if (ref.surfaceId !== this.rootSurface!.surfaceId) throw new FilesystemAdapterError('filesystem-target-stale', 'target ref belongs to a stale filesystem surface');
    const record = this.identities.get(ref.entityId); if (!record) throw new FilesystemAdapterError('filesystem-target-stale', 'target identity is unknown or stale');
    if (ref.generation !== record.generation) throw new FilesystemAdapterError('filesystem-generation-mismatch', 'target generation does not match the known filesystem object');
    if (ref.kind !== record.kind) throw new FilesystemAdapterError('filesystem-target-kind-mismatch', 'target kind does not match known identity'); await this.validLocator(record); return record;
  }
  private metadata(path: string, kind: 'file' | 'directory', stats: BigStats): FilesystemObjectMetadata {
    return { name: basename(path), type: kind, size: safeNumber(stats.size), modifiedMs: safeNumber(stats.mtimeMs), mode: safeNumber(stats.mode), linkCount: safeNumber(stats.nlink), hardlinked: safeNumber(stats.nlink) > 1, deviceId: stats.dev.toString(), mountBoundary: stats.dev.toString() !== this.rootDevice };
  }
  private async observeDirectory(record: IdentityRecord, maxItemsInput?: number, maxTextBytesInput?: number): Promise<{ data: FilesystemDirectoryObservation; truncated: boolean }> {
    const locator = await this.validLocator(record); const before = locator.stats; if (!before.isDirectory()) throw new FilesystemAdapterError('filesystem-target-stale', 'directory was replaced before enumeration');
    const maxItems = boundedLimit(maxItemsInput, DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS); const maxTextBytes = boundedLimit(maxTextBytesInput, DEFAULT_MAX_TEXT_BYTES, HARD_MAX_TEXT_BYTES); const candidateCapacity = maxItems + 1; const names: string[] = []; let totalEntries = 0;
    let dir; try { dir = await opendir(locator.path); for await (const dirent of dir) { totalEntries += 1; insertBoundedName(names, dirent.name, candidateCapacity); } } catch (error) { mapFsError(error, locator.path); }
    const candidates = names.slice(0, maxItems); const entries: FilesystemDirectoryEntry[] = []; let textBytes = 0; let textTruncated = false;
    for (const name of candidates) {
      const nameBytes = Buffer.byteLength(name); if (textBytes + nameBytes > maxTextBytes) { textTruncated = true; break; }
      const path = resolve(locator.path, name); if (!withinRoot(this.rootPath, path)) throw new FilesystemAdapterError('filesystem-path-traversal', 'directory entry escaped scoped root');
      let stats: BigStats; try { stats = await this.safeLstat(path); } catch (error) { if (error instanceof FilesystemAdapterError && error.code === 'filesystem-target-missing') throw new FilesystemAdapterError('filesystem-race-detected', 'directory entry changed during enumeration'); throw error; }
      const type = statKind(stats); const mountBoundary = stats.dev.toString() !== this.rootDevice;
      if (type === 'symlink') { const symlink = await this.describeSymlink(path); const symlinkBytes = Buffer.byteLength(symlink.target); if (textBytes + nameBytes + symlinkBytes > maxTextBytes) { textTruncated = true; break; } entries.push({ name, type, mountBoundary: false, symlink }); textBytes += nameBytes + symlinkBytes; continue; }
      const entry: FilesystemDirectoryEntry = { name, type, mountBoundary, size: safeNumber(stats.size), modifiedMs: safeNumber(stats.mtimeMs), linkCount: safeNumber(stats.nlink), hardlinked: safeNumber(stats.nlink) > 1 };
      if (!mountBoundary && (type === 'file' || type === 'directory')) entry.ref = this.registerIdentity(path, type, stats); entries.push(entry); textBytes += nameBytes;
    }
    await this.assertCanonicalPath(locator.path); const after = await this.safeLstat(locator.path);
    if (objectKey(after) !== record.key || !after.isDirectory() || snapshotRevision(after) !== snapshotRevision(before)) throw new FilesystemAdapterError('filesystem-race-detected', 'directory changed during enumeration');
    return { data: { kind: 'directory', metadata: this.metadata(locator.path, 'directory', after), entries }, truncated: totalEntries > entries.length || totalEntries > maxItems || textTruncated };
  }
  private async describeSymlink(path: string): Promise<NonNullable<FilesystemDirectoryEntry['symlink']>> {
    let target: string; try { target = await readlink(path); } catch (error) { mapFsError(error, path); }
    const resolvedTarget = resolve(path, '..', target); const targetWithinRoot = withinRoot(this.rootPath, resolvedTarget); let targetType: Exclude<FilesystemEntryType, 'symlink'> | undefined;
    if (targetWithinRoot) { try { await this.assertCanonicalPath(resolvedTarget); const targetStats = await lstat(resolvedTarget, { bigint: true }) as unknown as BigStats; const kind = statKind(targetStats); if (kind !== 'symlink') targetType = kind; } catch { /* dangling/inaccessible */ } }
    return { target, targetWithinRoot, targetType };
  }
  private async observeFile(record: IdentityRecord): Promise<FilesystemFileObservation> { const locator = await this.validLocator(record); return { kind: 'file', metadata: this.metadata(locator.path, 'file', locator.stats) }; }
  private async readFile(record: IdentityRecord, maxBytes: number): Promise<FilesystemReadDetails> {
    const locator = await this.validLocator(record); let handle;
    try { const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0; handle = await open(locator.path, fsConstants.O_RDONLY | noFollow); } catch (error) { mapFsError(error, locator.path); }
    try {
      await this.assertCanonicalPath(locator.path); const before = await handle.stat({ bigint: true }) as unknown as BigStats;
      if (!before.isFile() || objectKey(before) !== record.key || before.dev.toString() !== this.rootDevice || (!birthtimeReliable(before) && fallbackRevision(before) !== record.fallbackRevision)) throw new FilesystemAdapterError('filesystem-target-stale', 'file identity changed before bounded read');
      const requestedPlusLookahead = BigInt(maxBytes + 3); const readCapacity = Number(before.size < requestedPlusLookahead ? before.size : requestedPlusLookahead); const buffer = Buffer.allocUnsafe(readCapacity); const { bytesRead } = await handle.read(buffer, 0, readCapacity, 0);
      const readBytes = buffer.subarray(0, bytesRead); const prefixLength = utf8Boundary(readBytes, Math.min(maxBytes, bytesRead)); const prefix = readBytes.subarray(0, prefixLength); let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(prefix as unknown as Uint8Array); } catch { throw new FilesystemAdapterError('filesystem-binary-content', 'bounded file read supports UTF-8 text only'); }
      const after = await handle.stat({ bigint: true }) as unknown as BigStats; if (objectKey(after) !== record.key || snapshotRevision(after) !== snapshotRevision(before)) throw new FilesystemAdapterError('filesystem-race-detected', 'file changed during bounded read');
      const totalBytes = safeNumber(after.size); return { content, contentEncoding: 'utf8', contentBytes: prefixLength, totalBytes, truncated: totalBytes > prefixLength };
    } finally { await handle.close(); }
  }
}
