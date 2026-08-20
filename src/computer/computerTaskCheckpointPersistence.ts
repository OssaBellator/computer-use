import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { snapshotComputerTaskProgram, type ComputerTaskProgram } from './computerTask.js';
import {
  computerTaskProgramHash,
  decodeComputerTaskCheckpoint,
  encodeComputerTaskCheckpoint,
  snapshotComputerTaskCheckpoint,
  validateComputerTaskCheckpoint,
  type ComputerTaskCheckpoint,
} from './computerTaskCheckpoint.js';

export const COMPUTER_TASK_PERSISTED_CHECKPOINT_FORMAT = 'browser-automation/computer-task-persisted-checkpoint' as const;
export const COMPUTER_TASK_PERSISTED_CHECKPOINT_VERSION = 1 as const;
export const COMPUTER_TASK_PERSISTED_CHECKPOINT_MAX_BYTES = 96 * 1024;

interface PersistedCheckpointUnsignedEnvelope {
  format: typeof COMPUTER_TASK_PERSISTED_CHECKPOINT_FORMAT;
  version: typeof COMPUTER_TASK_PERSISTED_CHECKPOINT_VERSION;
  generation: number;
  binding: { programId: string; programHash: string; executionId: string };
  checkpoint: string;
}

interface PersistedCheckpointEnvelope extends PersistedCheckpointUnsignedEnvelope {
  authentication: { algorithm: 'hmac-sha256'; tag: string };
}

interface PersistedCheckpointAnchorUnsignedEnvelope {
  format: 'browser-automation/computer-task-checkpoint-anchor';
  version: 1;
  generation: number;
  envelopeDigest: string;
  binding: { programId: string; programHash: string; executionId: string };
}

interface PersistedCheckpointAnchorEnvelope extends PersistedCheckpointAnchorUnsignedEnvelope {
  authentication: { algorithm: 'hmac-sha256'; tag: string };
}

export interface ComputerTaskCheckpointPersistenceBinding {
  program: ComputerTaskProgram;
  executionId: string;
}

/** Storage-neutral durable checkpoint contract. Implementations must preserve atomic replacement semantics. */
export interface ComputerTaskCheckpointPersistence {
  load(binding: ComputerTaskCheckpointPersistenceBinding): Promise<ComputerTaskCheckpoint | undefined>;
  save(checkpoint: ComputerTaskCheckpoint, binding: ComputerTaskCheckpointPersistenceBinding): Promise<void>;
}

export interface LocalFileComputerTaskCheckpointPersistenceOptions {
  filePath: string;
  authenticationKey: string | Uint8Array;
  maxBytes?: number;
}

const SHA256 = /^[0-9a-f]{64}$/;
const EXECUTION_ID = /^[0-9a-f]{32,64}$/;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('persisted computer task checkpoint contains a non-finite number');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new Error('persisted computer task checkpoint contains a non-JSON value');
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Uint8Array, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

function authenticated<T extends object>(key: Uint8Array, unsigned: T): T & { authentication: { algorithm: 'hmac-sha256'; tag: string } } {
  return {
    ...unsigned,
    authentication: { algorithm: 'hmac-sha256', tag: hmac(key, canonicalJson(unsigned)) },
  };
}

function verifyAuthentication(key: Uint8Array, value: unknown, kind: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${kind} envelope`);
  const envelope = value as Record<string, unknown>;
  const authentication = envelope.authentication as { algorithm?: unknown; tag?: unknown } | undefined;
  if (authentication?.algorithm !== 'hmac-sha256' || typeof authentication.tag !== 'string' || !SHA256.test(authentication.tag)) {
    throw new Error(`invalid ${kind} authentication`);
  }
  const { authentication: _authentication, ...unsigned } = envelope;
  const expected = Buffer.from(hmac(key, canonicalJson(unsigned)), 'hex');
  const actual = Buffer.from(authentication.tag, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error(`${kind} authentication mismatch`);
}

function snapshotPersistenceBinding(binding: ComputerTaskCheckpointPersistenceBinding): ComputerTaskCheckpointPersistenceBinding {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error('invalid computer task checkpoint persistence binding');
  let programDescriptor: PropertyDescriptor | undefined;
  let executionDescriptor: PropertyDescriptor | undefined;
  try {
    programDescriptor = Object.getOwnPropertyDescriptor(binding, 'program');
    executionDescriptor = Object.getOwnPropertyDescriptor(binding, 'executionId');
  } catch {
    throw new Error('invalid computer task checkpoint persistence binding');
  }
  if (!programDescriptor || !('value' in programDescriptor) || !executionDescriptor || !('value' in executionDescriptor)) {
    throw new Error('computer task checkpoint persistence binding must use own data properties');
  }
  if (typeof executionDescriptor.value !== 'string' || !EXECUTION_ID.test(executionDescriptor.value)) {
    throw new Error('computer task execution id is invalid');
  }
  return Object.freeze({
    program: snapshotComputerTaskProgram(programDescriptor.value as ComputerTaskProgram),
    executionId: executionDescriptor.value,
  });
}

function bindingIdentity(binding: ComputerTaskCheckpointPersistenceBinding): PersistedCheckpointUnsignedEnvelope['binding'] {
  if (!EXECUTION_ID.test(binding.executionId)) throw new Error('computer task execution id is invalid');
  return {
    programId: binding.program.id,
    programHash: computerTaskProgramHash(binding.program),
    executionId: binding.executionId,
  };
}

function sameBinding(
  actual: PersistedCheckpointUnsignedEnvelope['binding'],
  expected: PersistedCheckpointUnsignedEnvelope['binding'],
): boolean {
  return actual.programId === expected.programId && actual.programHash === expected.programHash && actual.executionId === expected.executionId;
}

function assertSafeCheckpointProgression(existing: ComputerTaskCheckpoint, next: ComputerTaskCheckpoint): void {
  if (next.cursor.stepsExecuted < existing.cursor.stepsExecuted) {
    throw new Error('persisted computer task checkpoint semantic rollback detected: execution history regressed');
  }
  const nextByStep = new Map(next.actions.map((action) => [action.stepId, action]));
  for (const previous of existing.actions) {
    const candidate = nextByStep.get(previous.stepId);
    if (!candidate) throw new Error('persisted computer task checkpoint semantic rollback detected: action history missing');
    if (previous.state === 'completed' && candidate.state !== 'completed') {
      throw new Error('persisted computer task checkpoint semantic rollback detected: completed action regressed');
    }
    if (
      (previous.state === 'unknown-dispatch' || previous.state === 'dispatched-unverified') &&
      candidate.state === 'not-started'
    ) {
      throw new Error('persisted computer task checkpoint semantic rollback detected: uncertain action became replayable');
    }
    if (
      previous.state === 'dispatched-unverified' &&
      previous.uncertainty !== undefined &&
      candidate.state === 'dispatched-unverified' &&
      candidate.uncertainty !== previous.uncertainty
    ) {
      throw new Error('persisted computer task checkpoint semantic rollback detected: verification uncertainty regressed');
    }
  }
}

async function readBounded(path: string, maxBytes: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maxBytes) throw new Error('persisted computer task checkpoint exceeds size limit');
    return bytes.subarray(0, offset).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') throw error;
  } finally {
    await handle?.close();
  }
}

/** Same-directory temp + fsync + rename gives deterministic atomic replacement for local test storage. */
async function atomicReplace(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = `${path}.tmp`;
  await rm(tempPath, { force: true });
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
  await fsyncDirectory(directory);
}

export class LocalFileComputerTaskCheckpointPersistence implements ComputerTaskCheckpointPersistence {
  readonly filePath: string;
  readonly tempPath: string;
  readonly anchorPath: string;
  readonly lockPath: string;
  private readonly key: Uint8Array;
  private readonly maxBytes: number;

  constructor(options: LocalFileComputerTaskCheckpointPersistenceOptions) {
    if (!options.filePath) throw new Error('checkpoint file path is required');
    const key = typeof options.authenticationKey === 'string'
      ? Buffer.from(options.authenticationKey, 'utf8')
      : Buffer.from(options.authenticationKey);
    if (key.byteLength < 32) throw new Error('checkpoint authentication key must contain at least 32 bytes');
    this.filePath = options.filePath;
    this.tempPath = `${options.filePath}.tmp`;
    this.anchorPath = `${options.filePath}.anchor`;
    this.lockPath = `${options.filePath}.lock`;
    this.key = key;
    this.maxBytes = options.maxBytes ?? COMPUTER_TASK_PERSISTED_CHECKPOINT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1024 || this.maxBytes > 1024 * 1024) {
      throw new Error('invalid persisted checkpoint size limit');
    }
  }

  private parseCheckpoint(encoded: string, expectedBinding: PersistedCheckpointUnsignedEnvelope['binding']): PersistedCheckpointEnvelope {
    let value: unknown;
    try { value = JSON.parse(encoded); } catch { throw new Error('invalid persisted computer task checkpoint JSON'); }
    verifyAuthentication(this.key, value, 'persisted computer task checkpoint');
    const envelope = value as PersistedCheckpointEnvelope;
    if (
      envelope.format !== COMPUTER_TASK_PERSISTED_CHECKPOINT_FORMAT ||
      envelope.version !== COMPUTER_TASK_PERSISTED_CHECKPOINT_VERSION ||
      !Number.isSafeInteger(envelope.generation) || envelope.generation < 1 ||
      !envelope.binding || !sameBinding(envelope.binding, expectedBinding) ||
      typeof envelope.checkpoint !== 'string'
    ) {
      throw new Error('invalid persisted computer task checkpoint envelope or binding');
    }
    return envelope;
  }

  private parseAnchor(encoded: string, expectedBinding: PersistedCheckpointUnsignedEnvelope['binding']): PersistedCheckpointAnchorEnvelope {
    let value: unknown;
    try { value = JSON.parse(encoded); } catch { throw new Error('invalid persisted computer task checkpoint anchor JSON'); }
    verifyAuthentication(this.key, value, 'persisted computer task checkpoint anchor');
    const anchor = value as PersistedCheckpointAnchorEnvelope;
    if (
      anchor.format !== 'browser-automation/computer-task-checkpoint-anchor' || anchor.version !== 1 ||
      !Number.isSafeInteger(anchor.generation) || anchor.generation < 1 || !SHA256.test(anchor.envelopeDigest) ||
      !anchor.binding || !sameBinding(anchor.binding, expectedBinding)
    ) {
      throw new Error('invalid persisted computer task checkpoint anchor or binding');
    }
    return anchor;
  }

  private async writeAnchor(generation: number, envelopeDigest: string, binding: PersistedCheckpointUnsignedEnvelope['binding']): Promise<void> {
    const unsigned: PersistedCheckpointAnchorUnsignedEnvelope = {
      format: 'browser-automation/computer-task-checkpoint-anchor', version: 1, generation, envelopeDigest, binding,
    };
    const encoded = canonicalJson(authenticated(this.key, unsigned));
    if (Buffer.byteLength(encoded, 'utf8') > this.maxBytes) throw new Error('persisted computer task checkpoint anchor exceeds size limit');
    await atomicReplace(this.anchorPath, encoded);
  }

  async load(binding: ComputerTaskCheckpointPersistenceBinding): Promise<ComputerTaskCheckpoint | undefined> {
    const bindingSnapshot = snapshotPersistenceBinding(binding);
    const expectedBinding = bindingIdentity(bindingSnapshot);
    const [encoded, anchorEncoded] = await Promise.all([
      readBounded(this.filePath, this.maxBytes),
      readBounded(this.anchorPath, this.maxBytes),
    ]);
    if (encoded === undefined) {
      if (anchorEncoded !== undefined) {
        this.parseAnchor(anchorEncoded, expectedBinding);
        throw new Error('persisted computer task checkpoint rollback detected: primary checkpoint is missing behind authenticated anchor');
      }
      return undefined;
    }
    const envelope = this.parseCheckpoint(encoded, expectedBinding);
    const envelopeDigest = sha256(encoded);
    if (anchorEncoded !== undefined) {
      const anchor = this.parseAnchor(anchorEncoded, expectedBinding);
      if (anchor.generation > envelope.generation) throw new Error('persisted computer task checkpoint rollback detected');
      if (anchor.generation === envelope.generation && anchor.envelopeDigest !== envelopeDigest) {
        throw new Error('persisted computer task checkpoint stale replacement detected');
      }
      if (anchor.generation < envelope.generation) {
        await this.writeAnchor(envelope.generation, envelopeDigest, expectedBinding);
      }
    } else {
      await this.writeAnchor(envelope.generation, envelopeDigest, expectedBinding);
    }
    const checkpoint = decodeComputerTaskCheckpoint(envelope.checkpoint);
    validateComputerTaskCheckpoint(checkpoint, {
      program: bindingSnapshot.program,
      executionId: bindingSnapshot.executionId,
      requireRuntimeProvenance: true,
    });
    return checkpoint;
  }

  async save(checkpoint: ComputerTaskCheckpoint, binding: ComputerTaskCheckpointPersistenceBinding): Promise<void> {
    const bindingSnapshot = snapshotPersistenceBinding(binding);
    const expectedBinding = bindingIdentity(bindingSnapshot);
    const checkpointSnapshot = snapshotComputerTaskCheckpoint(checkpoint, {
      program: bindingSnapshot.program,
      executionId: bindingSnapshot.executionId,
      requireRuntimeProvenance: true,
    });

    await mkdir(dirname(this.filePath), { recursive: true });
    let lock;
    try {
      lock = await open(this.lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('computer task checkpoint persistence save is busy or a stale lock requires explicit operator recovery');
      }
      throw error;
    }

    try {
      const existing = await readBounded(this.filePath, this.maxBytes);
      const existingEnvelope = existing === undefined ? undefined : this.parseCheckpoint(existing, expectedBinding);
      const anchorEncoded = await readBounded(this.anchorPath, this.maxBytes);
      const anchor = anchorEncoded === undefined ? undefined : this.parseAnchor(anchorEncoded, expectedBinding);
      if (!existingEnvelope && anchor) {
        throw new Error('persisted computer task checkpoint rollback detected: primary checkpoint is missing behind authenticated anchor');
      }
      if (existingEnvelope && anchor && anchor.generation > existingEnvelope.generation) {
        throw new Error('persisted computer task checkpoint rollback detected');
      }
      if (existingEnvelope && anchor && anchor.generation === existingEnvelope.generation && anchor.envelopeDigest !== sha256(existing!)) {
        throw new Error('persisted computer task checkpoint stale replacement detected');
      }
      if (existingEnvelope) {
        const existingCheckpoint = decodeComputerTaskCheckpoint(existingEnvelope.checkpoint);
        validateComputerTaskCheckpoint(existingCheckpoint, {
          program: bindingSnapshot.program,
          executionId: bindingSnapshot.executionId,
          requireRuntimeProvenance: true,
        });
        assertSafeCheckpointProgression(existingCheckpoint, checkpointSnapshot);
      }
      const generation = Math.max(existingEnvelope?.generation ?? 0, anchor?.generation ?? 0) + 1;
      const unsigned: PersistedCheckpointUnsignedEnvelope = {
        format: COMPUTER_TASK_PERSISTED_CHECKPOINT_FORMAT,
        version: COMPUTER_TASK_PERSISTED_CHECKPOINT_VERSION,
        generation,
        binding: expectedBinding,
        checkpoint: encodeComputerTaskCheckpoint(checkpointSnapshot),
      };
      const encoded = canonicalJson(authenticated(this.key, unsigned));
      if (Buffer.byteLength(encoded, 'utf8') > this.maxBytes) throw new Error('persisted computer task checkpoint exceeds size limit');
      await atomicReplace(this.filePath, encoded);
      await this.writeAnchor(generation, sha256(encoded), expectedBinding);
    } finally {
      await lock.close();
      await rm(this.lockPath, { force: true });
    }
  }
}
