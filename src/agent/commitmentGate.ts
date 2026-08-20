import {
  detectBrowserCommitment,
  markBrowserCommitmentContextUnavailable,
  type BrowserCommitmentSummary,
} from '../browser/commitmentDetector.js';
import type {
  DocumentContentOptions,
  DocumentContentSnapshot,
} from '../browser/documentContent.js';
import { resolveInteractionTargetDetailed } from '../model/targetResolver.js';
import type { InteractionNode } from '../types.js';
import type { ActivateTaskStep, PressKeyTaskStep } from './taskProgram.js';
import type { TaskObservation } from './taskObservation.js';
import type { TaskRuntimeEngine } from './taskRuntimeContracts.js';

export type CommitmentCapableTaskStep = ActivateTaskStep | PressKeyTaskStep;

/** Fixed bounded document budget used only immediately before a possible commitment. */
export const TASK_COMMITMENT_DOCUMENT_OPTIONS: Readonly<DocumentContentOptions> = {
  maxBlocks: 128,
  maxTextBytes: 32 * 1024,
  maxTextBytesPerBlock: 2048,
  maxDepth: 64,
  includeHidden: false,
  viewportOnly: false,
};

function activationTarget(
  step: ActivateTaskStep,
  observation: TaskObservation,
): InteractionNode | undefined {
  const resolution = resolveInteractionTargetDetailed(observation.nodes, step.target);
  if (resolution.ambiguous) return undefined;
  return resolution.target ?? undefined;
}

function focusedActivationTarget(observation: TaskObservation): InteractionNode | undefined {
  return observation.nodes.find((node) =>
    node.focused &&
    !node.disabled &&
    (node.clickable || node.capabilities.includes('activate')),
  );
}

/**
 * Commitment context is frame-local. A checkout iframe must not turn an
 * unrelated generic Confirm button in another frame into a financial action.
 * The original truncation flag is retained conservatively because host-level
 * truncation can still mean relevant target-frame content was omitted.
 */
function documentForTarget(
  document: DocumentContentSnapshot | undefined,
  frameId: string,
): DocumentContentSnapshot | undefined {
  if (!document) return undefined;
  return {
    ...document,
    frames: document.frames.filter((frame) => frame.frameId === frameId),
    blocks: document.blocks.filter((block) => block.frameId === frameId),
    frameErrors: document.frameErrors.filter((error) => error.frameId === frameId),
  };
}

function initialDetection(
  step: CommitmentCapableTaskStep,
  observation: TaskObservation,
): BrowserCommitmentSummary | undefined {
  if (step.kind === 'activate') {
    const target = activationTarget(step, observation);
    if (!target) return undefined;
    return detectBrowserCommitment({
      action: 'activate',
      target,
      browser: observation.browser,
      document: documentForTarget(observation.document, target.frameId),
    });
  }

  const target = focusedActivationTarget(observation);
  if (!target) return undefined;
  return detectBrowserCommitment({
    action: 'press-key',
    key: step.key,
    target,
    browser: observation.browser,
    document: documentForTarget(observation.document, target.frameId),
  });
}

function withDocument(
  step: CommitmentCapableTaskStep,
  observation: TaskObservation,
  document: NonNullable<TaskObservation['document']>,
): BrowserCommitmentSummary | undefined {
  const enriched: TaskObservation = { ...observation, document };
  return initialDetection(step, enriched);
}

/**
 * Detect a page-side commitment immediately before an action. Strong target
 * labels can gate without document extraction. Ambiguous target labels request
 * one bounded document snapshot. If that channel exists but fails or is
 * incomplete, the result stays uncertain and fails closed through approval.
 */
export async function detectTaskStepCommitment(
  engine: TaskRuntimeEngine,
  step: CommitmentCapableTaskStep,
  observation: TaskObservation,
): Promise<BrowserCommitmentSummary | undefined> {
  const initial = initialDetection(step, observation);
  if (!initial || initial.status === 'none') return undefined;

  const shouldReadDocument = observation.document === undefined &&
    engine.documentContent !== undefined &&
    (initial.status === 'detected' || initial.needsDocumentContext);
  if (!shouldReadDocument) return initial;

  try {
    const document = await engine.documentContent(TASK_COMMITMENT_DOCUMENT_OPTIONS);
    if (!document) return markBrowserCommitmentContextUnavailable(initial);
    const enriched = withDocument(step, observation, document);
    return enriched && enriched.status !== 'none' ? enriched : undefined;
  } catch {
    return markBrowserCommitmentContextUnavailable(initial);
  }
}
