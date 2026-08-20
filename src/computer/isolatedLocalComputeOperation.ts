import {
  IsolatedLocalComputeAdapter,
  type IsolatedLocalComputeAdapterOptions,
  type IsolatedLocalComputeOperationDefinition,
} from './isolatedLocalComputeAdapter.js';
import type { LocalComputeJson, LocalComputeResourceLimits } from './localComputeAdapter.js';

export interface IsolatedLocalComputeOperationContext {
  readonly operationId: string;
  readonly deadlineEpochMs: number;
  readonly limits: Readonly<Pick<
    LocalComputeResourceLimits,
    'maxOutputBytes' | 'maxDiagnosticBytes' | 'maxJsonDepth' | 'maxJsonItems' | 'memoryBytesHint'
  >>;
  diagnostic(code: string): void;
}

/**
 * Isolated operations receive parsed immutable JSON but return encoded JSON text.
 * The worker enforces the output byte bound before parsing/canonicalizing that text.
 */
export type IsolatedLocalComputeOperation<I extends LocalComputeJson = LocalComputeJson> =
  (input: I, context: IsolatedLocalComputeOperationContext) => string | Promise<string>;

/**
 * Type helper for file-backed isolated operation modules.
 *
 * This does not create additional sandboxing. The operation still runs with the host
 * authority available to the registered file module inside the isolated child process.
 */
export function defineIsolatedLocalComputeOperation<I extends LocalComputeJson = LocalComputeJson>(
  operation: IsolatedLocalComputeOperation<I>,
): IsolatedLocalComputeOperation<I> {
  return operation;
}

function snapshotRegistration(operation: IsolatedLocalComputeOperationDefinition): Readonly<IsolatedLocalComputeOperationDefinition> {
  let url: URL;
  try { url = new URL(operation.moduleUrl); }
  catch { throw new Error(`invalid isolated local compute module URL: ${operation.id}`); }
  if (url.protocol !== 'file:') throw new Error(`isolated local compute module must use file: URL: ${operation.id}`);
  return Object.freeze({
    id: operation.id,
    effect: operation.effect,
    moduleUrl: url.href,
    exportName: operation.exportName,
  });
}

/**
 * Preferred construction path for isolated local compute.
 *
 * It snapshots every registration and rejects non-file module URLs before the adapter is
 * created. The worker independently repeats the file-scheme check as defense in depth.
 */
export function createIsolatedLocalComputeAdapter(options: IsolatedLocalComputeAdapterOptions): IsolatedLocalComputeAdapter {
  const operations = Object.freeze(options.operations.map(snapshotRegistration));
  return new IsolatedLocalComputeAdapter({ ...options, operations });
}
