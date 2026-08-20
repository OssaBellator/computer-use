import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FilesystemComputerEnvironmentAdapter,
  type FilesystemApprovalVerifier,
  type FilesystemMutationDispatcher,
  type FilesystemPreparedMutation,
} from '../../src/computer/filesystemAdapter.js';

export const approvingFilesystemMutation: FilesystemApprovalVerifier = {
  verify: async () => true,
};

export interface FilesystemMutationFixtureOptions {
  readonly dispatcher?: FilesystemMutationDispatcher;
  readonly approvalVerifier?: FilesystemApprovalVerifier;
  readonly adapterId?: string;
}

export async function filesystemMutationFixture(options: FilesystemMutationFixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'computer-fs-matrix-'));
  const adapterId = options.adapterId ?? 'filesystem-matrix-test';
  const adapter = new FilesystemComputerEnvironmentAdapter({
    adapterId,
    rootPath: root,
    ...(options.dispatcher ? { mutationDispatcher: options.dispatcher } : {}),
    ...(options.approvalVerifier ? { approvalVerifier: options.approvalVerifier } : {}),
  });
  return {
    root,
    adapterId,
    adapter,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function mutationAction(
  adapterId: string,
  prepared: FilesystemPreparedMutation,
  actionId: string,
  approve = prepared.effect === 'local-destructive',
) {
  return {
    adapterId,
    actionId,
    capability: prepared.capability,
    effect: prepared.effect,
    idempotency: prepared.idempotency,
    ...(prepared.target ? { target: prepared.target } : {}),
    payload: {
      ...prepared.payload,
      ...(approve
        ? {
            approval: {
              approved: true as const,
              approvalId: `${actionId}-approval`,
              effect: 'local-destructive' as const,
              planId: prepared.payload.planId,
            },
          }
        : {}),
    },
  };
}
