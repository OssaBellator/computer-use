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

export type IsolatedLocalComputeOperation<I extends LocalComputeJson = LocalComputeJson, O extends LocalComputeJson = LocalComputeJson> =
  (input: I, context: IsolatedLocalComputeOperationContext) => O | Promise<O>;

/**
 * Type helper for file-backed isolated operation modules.
 *
 * This does not create additional sandboxing. The operation still runs with the host
 * authority available to the registered file module inside the isolated child process.
 */
export function defineIsolatedLocalComputeOperation<
  I extends LocalComputeJson = LocalComputeJson,
  O extends LocalComputeJson = LocalComputeJson,
>(operation: IsolatedLocalComputeOperation<I, O>): IsolatedLocalComputeOperation<I, O> {
  return operation;
}

function snapshotRegistration(operation: IsolatedLocalComputeOperationDefinition): Readonly<IsolatedLocalComputeOperationDefinition> {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new Error('invalid isolated local compute operation registration');
  if (Reflect.ownKeys(operation).some((key) => typeof key !== 'string')) throw new Error('invalid isolated local compute operation registration');
  const descriptors = Object.getOwnPropertyDescriptors(operation);
  const allowed = new Set(['id', 'effect', 'moduleUrl', 'exportName']);
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) throw new Error('invalid isolated local compute operation registration');
  for (const key of allowed) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get || descriptor.set || !('value' in descriptor)) throw new Error('invalid isolated local compute operation registration');
  }
  const id = descriptors.id!.value as string;
  const effect = descriptors.effect!.value as IsolatedLocalComputeOperationDefinition['effect'];
  const moduleUrl = descriptors.moduleUrl!.value as string;
  const exportName = descriptors.exportName!.value as string;
  let url: URL;
  try { url = new URL(moduleUrl); }
  catch { throw new Error(`invalid isolated local compute module URL: ${id}`); }
  if (url.protocol !== 'file:') throw new Error(`isolated local compute module must use file: URL: ${id}`);
  return Object.freeze({ id, effect, moduleUrl: url.href, exportName });
}

/**
 * Preferred construction path for isolated local compute.
 *
 * It snapshots every registration without invoking accessors, rejects hidden/extra
 * authority-bearing fields, and rejects non-file module URLs before the adapter is created.
 * The worker independently repeats the file-scheme check as defense in depth.
 */
export function createIsolatedLocalComputeAdapter(options: IsolatedLocalComputeAdapterOptions): IsolatedLocalComputeAdapter {
  const operations = Object.freeze(options.operations.map(snapshotRegistration));
  return new IsolatedLocalComputeAdapter({ ...options, operations });
}
