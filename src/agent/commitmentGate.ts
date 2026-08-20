import {
  detectBrowserCommitment,
  markBrowserCommitmentContextUnavailable,
  type BrowserCommitmentSummary,
} from '../browser/commitmentDetector.js';
import type { DocumentContentOptions } from '../browser/documentContent.js';
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
      document: observation.document,
    });
  }

  const target = focusedActivationTarget(observation);
  if (!target) return undefined;
  return detectBrowserCommitment({
    action: 'press-key',
    key: step.key,
    target,
    browser: observation.browser,
    document: observation.document,
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
  let summary = initialDetection(step, observation);
  if (!summary || summary.status === 'none') return undefined;

  const shouldReadDocument = observation.document === undefined &&
    engine.documentContent !== undefined &&
    (summary.status === 'detected' || summary.needsDocumentContext);
  if (!shouldReadDocument) return summary;

  try {
    const document = await engine.documentContent(TASK_COMMITMENT_DOCUMENT_OPTIONS);
    if (!document) return markBrowserCommitmentContextUnavailable(summary);
    summary = withDocument(step, observation, document);
    return summary && summary.status !== 'none' ? summary : undefined;
  } catch {
    return markBrowserCommitmentContextUnavailable(summary);
  }
}
