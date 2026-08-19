import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type { CdpSessionLike } from './cdpIdentity.js';
import type { InteractionNode } from '../types.js';

export const DEFAULT_UPLOAD_MAX_FILES = 16;
export const DEFAULT_UPLOAD_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export type BrowserFileUploadStatus =
  | 'uploaded'
  | 'configuration-error'
  | 'policy-blocked'
  | 'invalid-target'
  | 'stale-target'
  | 'protocol-error'
  | 'verification-failed';

export interface BrowserFileUploadControllerOptions {
  /** Absolute directory roots from which local files may be disclosed to a page. */
  allowedRoots: readonly string[];
  maxFiles?: number;
  maxTotalBytes?: number;
}

/** Result metadata intentionally never contains local filesystem paths. */
export interface BrowserFileUploadResult {
  status: BrowserFileUploadStatus;
  targetId: string;
  fileCount: number;
  totalBytes: number;
  policyReason?: string;
  errorText?: string;
}

interface TargetDescription {
  tagName: string;
  type: string;
  disabled: boolean;
  multiple: boolean;
  fileCount: number;
}

interface PreparedFiles {
  files: string[];
  totalBytes: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function containedBy(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' &&
    !rel.startsWith('../') && !rel.startsWith('..\\');
}

/**
 * Local-file disclosure boundary for browser file inputs.
 *
 * The controller canonicalizes both configured roots and requested files before
 * policy checks, which prevents symlink traversal from escaping an allowed root.
 * Browser-supplied content is never accepted as a file path by this layer.
 */
export class CdpFileUploadController {
  private roots?: string[];
  private startPromise?: Promise<void>;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;

  constructor(
    private readonly session: CdpSessionLike,
    readonly options: BrowserFileUploadControllerOptions,
  ) {
    if (!options.allowedRoots.length) {
      throw new Error('File upload requires at least one allowed root');
    }
    for (const root of options.allowedRoots) {
      if (!isAbsolute(root)) throw new Error('File upload allowed roots must be absolute');
    }
    this.maxFiles = positiveInteger(options.maxFiles, DEFAULT_UPLOAD_MAX_FILES);
    this.maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_UPLOAD_MAX_TOTAL_BYTES);
  }

  start(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.initialize();
    return this.startPromise;
  }

  async upload(
    target: InteractionNode,
    paths: readonly string[],
  ): Promise<BrowserFileUploadResult> {
    const base = { targetId: target.id, fileCount: paths.length, totalBytes: 0 };
    try {
      await this.start();
    } catch {
      return {
        ...base,
        status: 'configuration-error',
        errorText: 'File upload configuration is unavailable',
      };
    }

    if (target.disabled || target.backendNodeId === undefined ||
        !target.capabilities.includes('upload')) {
      return { ...base, status: 'invalid-target' };
    }

    const prepared = await this.prepareFiles(paths);
    if ('policyReason' in prepared) {
      return { ...base, status: 'policy-blocked', policyReason: prepared.policyReason };
    }
    const actualBase = { ...base, totalBytes: prepared.totalBytes };

    let before: TargetDescription;
    try {
      before = await this.describeTarget(target.backendNodeId);
    } catch {
      return {
        ...actualBase,
        status: 'stale-target',
        errorText: 'File input could not be inspected',
      };
    }
    if (before.tagName !== 'INPUT' || before.type !== 'file' || before.disabled) {
      return { ...actualBase, status: 'invalid-target' };
    }
    if (paths.length > 1 && !before.multiple) {
      return {
        ...actualBase,
        status: 'policy-blocked',
        policyReason: 'target does not allow multiple files',
      };
    }

    try {
      await this.session.send('DOM.setFileInputFiles', {
        files: prepared.files,
        backendNodeId: target.backendNodeId,
      });
    } catch {
      return {
        ...actualBase,
        status: 'protocol-error',
        errorText: 'Browser rejected file-input assignment',
      };
    }

    try {
      const after = await this.describeTarget(target.backendNodeId);
      if (after.tagName === 'INPUT' && after.type === 'file' &&
          after.fileCount === prepared.files.length) {
        return { ...actualBase, status: 'uploaded' };
      }
      return { ...actualBase, status: 'verification-failed' };
    } catch {
      return {
        ...actualBase,
        status: 'verification-failed',
        errorText: 'File-input verification was unavailable',
      };
    }
  }

  private async initialize(): Promise<void> {
    const canonical: string[] = [];
    for (const root of this.options.allowedRoots) {
      const resolved = await realpath(root);
      const info = await stat(resolved);
      if (!info.isDirectory()) throw new Error('File upload allowed root is not a directory');
      canonical.push(resolved);
    }
    this.roots = [...new Set(canonical)];
  }

  private async prepareFiles(
    paths: readonly string[],
  ): Promise<PreparedFiles | { policyReason: string }> {
    if (paths.length < 1) return { policyReason: 'at least one file is required' };
    if (paths.length > this.maxFiles) {
      return { policyReason: 'file count exceeds configured upload limit' };
    }

    const files: string[] = [];
    let totalBytes = 0;
    for (let index = 0; index < paths.length; index += 1) {
      const candidate = paths[index]!;
      if (!isAbsolute(candidate)) {
        return { policyReason: `file ${index + 1} path must be absolute` };
      }

      let resolved: string;
      try {
        resolved = await realpath(candidate);
        const info = await stat(resolved);
        if (!info.isFile()) {
          return { policyReason: `file ${index + 1} is not a regular file` };
        }
        totalBytes += info.size;
      } catch {
        return { policyReason: `file ${index + 1} is unavailable` };
      }

      if (!this.roots!.some((root) => containedBy(root, resolved))) {
        return { policyReason: `file ${index + 1} is outside allowed roots` };
      }
      if (totalBytes > this.maxTotalBytes) {
        return { policyReason: 'total file bytes exceed configured upload limit' };
      }
      files.push(resolved);
    }
    return { files, totalBytes };
  }

  private async describeTarget(backendNodeId: number): Promise<TargetDescription> {
    const resolved = await this.session.send('DOM.resolveNode', { backendNodeId }) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error('File input object is unavailable');

    try {
      const result = await this.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          return {
            tagName: this.tagName,
            type: this.type,
            disabled: !!this.disabled,
            multiple: !!this.multiple,
            fileCount: this.files ? this.files.length : -1,
          };
        }`,
        returnByValue: true,
        awaitPromise: false,
      }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      if (result.exceptionDetails || !result.result?.value ||
          typeof result.result.value !== 'object') {
        throw new Error('File input inspection failed');
      }
      const raw = result.result.value as Record<string, unknown>;
      if (typeof raw.tagName !== 'string' || typeof raw.type !== 'string' ||
          typeof raw.disabled !== 'boolean' || typeof raw.multiple !== 'boolean' ||
          typeof raw.fileCount !== 'number') {
        throw new Error('File input inspection returned malformed data');
      }
      return {
        tagName: raw.tagName,
        type: raw.type,
        disabled: raw.disabled,
        multiple: raw.multiple,
        fileCount: raw.fileCount,
      };
    } finally {
      try { await this.session.send('Runtime.releaseObject', { objectId }); } catch {}
    }
  }
}
