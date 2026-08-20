import {
  detectBrowserCommitment,
  type BrowserCommitmentSummary,
} from '../browser/commitmentDetector.js';
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

async function freshVerificationDocument(
  engine: TaskRuntimeEngine,
  frameId: string,
): Promise<DocumentContentSnapshot | undefined> {
  if (!engine.documentContent) return undefined;
  const document = await engine.documentContent(TASK_COMMITMENT_VERIFICATION_DOCUMENT_OPTIONS);
  return document ? documentForFrame(document, frameId) : undefined;
}

function freshCommitment(
  step: CommitmentCapableTaskStep,
  target: InteractionNode,
  document: DocumentContentSnapshot,
): BrowserCommitmentSummary {
  return detectBrowserCommitment({
    action: step.kind,
    ...(step.kind === 'press-key' ? { key: step.key } : {}),
    target,
    document,
  });
}

function approvedCommitmentStillMatches(
  approved: BrowserCommitmentSummary,
  current: BrowserCommitmentSummary,
): boolean {
  if (current.status !== 'detected' || current.kind !== approved.kind) return false;
  if (approved.commitmentClass !== undefined && current.commitmentClass !== approved.commitmentClass) return false;
  if (approved.amount?.value !== undefined && current.amount?.value !== approved.amount.value) return false;
  if (approved.amount?.currency !== undefined && current.amount?.currency !== approved.amount.currency) return false;
  if (approved.counterparty !== undefined && current.counterparty !== approved.counterparty) return false;
  if (approved.schedule !== undefined && current.schedule !== approved.schedule) return false;
  if (approved.recurrence === 'recurring' && current.recurrence !== 'recurring') return false;
  if (approved.irreversible && !current.irreversible) return false;
  if (approved.securitySensitive && !current.securitySensitive) return false;
  return true;
}

/**
 * Capture a fresh result baseline after approval but before browser input.
 *
 * The target is re-observed and must retain the same stable interaction identity
 * and owning frame as the approved target. The commitment is then re-detected
 * from a fresh bounded document read and must still contain every material term
 * that was present in the approved summary. Finally, the result verifier must be
 * neutral (`unknown`) so a stale receipt/status cannot be attributed to the new
 * action.
 *
 * Any failure returns undefined; TaskRuntime treats that as a pre-dispatch policy
 * block. The earlier TaskObservation's document is never reused because the page
 * may have changed while approval was pending.
 */
export async function captureTaskStepCommitmentVerificationBaseline(
  engine: TaskRuntimeEngine,
  approved: BrowserCommitmentSummary,
  step: CommitmentCapableTaskStep,
  before: TaskObservation,
): Promise<TaskCommitmentVerificationBaseline | undefined> {
  const originalTarget = activationTarget(step, before);
  if (!originalTarget) return undefined;
  const expectedTargetId = approved.target?.id ?? originalTarget.id;

  try {
    const freshNodes = await engine.refresh();
    const freshTarget = activationTarget(step, { ...before, nodes: freshNodes });
    if (!freshTarget || freshTarget.id !== expectedTargetId || freshTarget.frameId !== originalTarget.frameId) {
      return undefined;
    }

    const document = await freshVerificationDocument(engine, freshTarget.frameId);
    if (!document) return undefined;
    const currentCommitment = freshCommitment(step, freshTarget, document);
    if (!approvedCommitmentStillMatches(approved, currentCommitment)) return undefined;

    return {
      frameId: freshTarget.frameId,
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
