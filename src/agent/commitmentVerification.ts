import type { BrowserCommitmentSummary } from '../browser/commitmentDetector.js';
import {
  verifyBrowserCommitment,
  type BrowserCommitmentVerificationSummary,
} from '../browser/commitmentVerifier.js';
import type {
  DocumentContentOptions,
  DocumentContentSnapshot,
} from '../browser/documentContent.js';
import { resolveInteractionTargetDetailed } from '../model/targetResolver.js';
import type { InteractionNode } from '../types.js';
import type { CommitmentCapableTaskStep } from './commitmentGate.js';
import type { TaskObservation } from './taskObservation.js';
import type { TaskRuntimeEngine } from './taskRuntimeContracts.js';

export const TASK_COMMITMENT_VERIFICATION_DOCUMENT_OPTIONS: Readonly<DocumentContentOptions> = {
  maxBlocks: 128,
  maxTextBytes: 32 * 1024,
  maxTextBytesPerBlock: 2048,
  maxDepth: 64,
  includeHidden: false,
  viewportOnly: false,
};

export interface TaskCommitmentVerificationOptions {
  maxPolls?: number;
  pollIntervalMs?: number;
}

export interface TaskCommitmentVerificationBaseline {
  frameId: string;
  verification: BrowserCommitmentVerificationSummary;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const positiveInt = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));

function activationTarget(
  step: CommitmentCapableTaskStep,
  observation: TaskObservation,
): InteractionNode | undefined {
  if (step.kind === 'activate') {
    const resolution = resolveInteractionTargetDetailed(observation.nodes, step.target);
    if (resolution.ambiguous) return undefined;
    return resolution.target ?? undefined;
  }
  return observation.nodes.find((node) =>
    node.focused && !node.disabled && (node.clickable || node.capabilities.includes('activate')),
  );
}

/** Scope result evidence to the frame that owned the approved commitment control. */
function documentForFrame(
  document: DocumentContentSnapshot,
  frameId: string | undefined,
): DocumentContentSnapshot | undefined {
  if (!frameId) return undefined;
  const hasFrame = document.frames.some((frame) => frame.frameId === frameId) ||
    document.blocks.some((block) => block.frameId === frameId) ||
    document.frameErrors.some((error) => error.frameId === frameId);
  if (!hasFrame) return undefined;
  return {
    ...document,
    frames: document.frames.filter((frame) => frame.frameId === frameId),
    blocks: document.blocks.filter((block) => block.frameId === frameId),
    frameErrors: document.frameErrors.filter((error) => error.frameId === frameId),
  };
}

async function verificationDocument(
  engine: TaskRuntimeEngine,
  frameId: string,
  existing?: DocumentContentSnapshot,
): Promise<DocumentContentSnapshot | undefined> {
  if (existing) return documentForFrame(existing, frameId);
  if (!engine.documentContent) return undefined;
  const document = await engine.documentContent(TASK_COMMITMENT_VERIFICATION_DOCUMENT_OPTIONS);
  return document ? documentForFrame(document, frameId) : undefined;
}

/**
 * Capture a result baseline after approval but before browser input. The baseline
 * must be result-neutral (`unknown`) before dispatch; a pre-existing confirmation,
 * adverse result, pending state, or material mismatch would make later result
 * attribution ambiguous and therefore blocks dispatch in TaskRuntime.
 */
export async function captureTaskStepCommitmentVerificationBaseline(
  engine: TaskRuntimeEngine,
  approved: BrowserCommitmentSummary,
  step: CommitmentCapableTaskStep,
  before: TaskObservation,
): Promise<TaskCommitmentVerificationBaseline | undefined> {
  const frameId = activationTarget(step, before)?.frameId;
  if (!frameId) return undefined;
  try {
    const document = await verificationDocument(engine, frameId, before.document);
    if (!document) return undefined;
    return {
      frameId,
      verification: verifyBrowserCommitment(approved, document),
    };
  } catch {
    return undefined;
  }
}

/**
 * Poll a bounded structured-document channel after an approved commitment.
 * Terminal outcomes return immediately. Explicit pending state is retained but
 * polling continues briefly in case the page resolves to a terminal outcome.
 */
export async function verifyTaskStepCommitment(
  engine: TaskRuntimeEngine,
  approved: BrowserCommitmentSummary,
  baseline: TaskCommitmentVerificationBaseline,
  options: TaskCommitmentVerificationOptions = {},
): Promise<BrowserCommitmentVerificationSummary> {
  if (!engine.documentContent) return verifyBrowserCommitment(approved, undefined);

  const maxPolls = positiveInt(options.maxPolls, 8);
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 75);
  let latest = verifyBrowserCommitment(approved, undefined);

  for (let poll = 0; poll < maxPolls; poll += 1) {
    try {
      const document = await engine.documentContent(TASK_COMMITMENT_VERIFICATION_DOCUMENT_OPTIONS);
      const scoped = document ? documentForFrame(document, baseline.frameId) : undefined;
      latest = verifyBrowserCommitment(approved, scoped);
    } catch {
      latest = verifyBrowserCommitment(approved, undefined);
    }

    if (
      latest.status === 'confirmed' || latest.status === 'declined' ||
      latest.status === 'canceled' || latest.status === 'mismatch'
    ) {
      return latest;
    }
    if (poll + 1 < maxPolls) await defaultSleep(pollIntervalMs);
  }

  return latest;
}
