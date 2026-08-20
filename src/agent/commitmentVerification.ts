import type { BrowserStateSnapshot } from '../browser/browserState.js';
import {
  detectBrowserCommitment,
  type BrowserCommitmentSummary,
} from '../browser/commitmentDetector.js';
import {
  evaluateBrowserCommitmentIdentity,
  snapshotBrowserCommitmentIdentity,
  type BrowserCommitmentIdentitySnapshot,
} from '../browser/commitmentIdentity.js';
import {
  verifyBrowserCommitment,
  type BrowserCommitmentResultContext,
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
  /** Bounded operation/result identity captured immediately before dispatch. */
  identity?: BrowserCommitmentIdentitySnapshot;
  /** Root CDP target identity is available only on multi-page engines. */
  pageTargetId?: string;
  pageCount?: number;
  latestPageSequence?: number;
}

interface VerificationPageContext {
  document: DocumentContentSnapshot;
  browserState?: BrowserStateSnapshot;
  resultContext: BrowserCommitmentResultContext;
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

function sameBrowserDocument(
  before: BrowserStateSnapshot | undefined,
  after: BrowserStateSnapshot | undefined,
): boolean {
  if (!before || !after) return true;
  return before.timeOrigin === after.timeOrigin && before.url === after.url && before.origin === after.origin;
}

function pageContext(
  document: DocumentContentSnapshot,
  browserState: BrowserStateSnapshot | undefined,
  resultContext: BrowserCommitmentResultContext,
): VerificationPageContext {
  return {
    document,
    ...(browserState ? { browserState } : {}),
    resultContext,
  };
}

async function activePageContext(
  engine: TaskRuntimeEngine,
  frameId: string,
): Promise<VerificationPageContext | undefined> {
  if (!engine.documentContent) return undefined;
  const stateBefore = await engine.browserState?.();
  const document = await engine.documentContent(TASK_COMMITMENT_VERIFICATION_DOCUMENT_OPTIONS);
  const stateAfter = await engine.browserState?.();
  if (!sameBrowserDocument(stateBefore, stateAfter)) return undefined;
  const scoped = document ? documentForFrame(document, frameId) : undefined;
  // browserState describes the top-level page. Never attribute its origin to a
  // child-frame commitment when no frame-local browser-state channel exists.
  const frameBrowserState = frameId === 'main' ? stateAfter ?? stateBefore : undefined;
  return scoped ? pageContext(scoped, frameBrowserState, 'same-page') : undefined;
}

async function associatedPopupContext(
  engine: TaskRuntimeEngine,
  baseline: TaskCommitmentVerificationBaseline,
): Promise<VerificationPageContext | undefined> {
  if (
    !baseline.pageTargetId || baseline.pageCount === undefined || baseline.latestPageSequence === undefined ||
    !engine.targetState || !engine.documentContentForPage
  ) return undefined;

  const targets = engine.targetState();
  // Exactly one page may have appeared after dispatch. More than one new page is
  // ambiguous, and a pre-existing page is never searched for result text.
  if (!targets || targets.pages !== baseline.pageCount + 1) return undefined;
  const candidate = targets.latestPage;
  if (
    !candidate || candidate.sequence <= baseline.latestPageSequence ||
    candidate.targetId === baseline.pageTargetId || candidate.openerId !== baseline.pageTargetId
  ) return undefined;

  const stateBefore = await engine.browserStateForPage?.(candidate.targetId);
  const document = await engine.documentContentForPage(
    candidate.targetId,
    TASK_COMMITMENT_VERIFICATION_DOCUMENT_OPTIONS,
  );
  const stateAfter = await engine.browserStateForPage?.(candidate.targetId);
  if (!sameBrowserDocument(stateBefore, stateAfter)) return undefined;
  const scoped = document ? documentForFrame(document, 'main') : undefined;
  return scoped ? pageContext(scoped, stateAfter ?? stateBefore, 'bound-popup') : undefined;
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

function verifyPageContext(
  approved: BrowserCommitmentSummary,
  baseline: TaskCommitmentVerificationBaseline,
  context: VerificationPageContext | undefined,
): BrowserCommitmentVerificationSummary {
  if (!context) return verifyBrowserCommitment(approved, undefined);
  if (!baseline.identity) return verifyBrowserCommitment(approved, context.document);
  const currentIdentity = snapshotBrowserCommitmentIdentity(
    approved.kind!,
    context.document,
    context.browserState,
  );
  const identity = evaluateBrowserCommitmentIdentity(baseline.identity, currentIdentity);
  return verifyBrowserCommitment(approved, context.document, {
    identity,
    resultContext: context.resultContext,
  });
}

/**
 * Capture a fresh result baseline after approval but before browser input.
 *
 * The target is re-observed and must retain the same stable interaction identity
 * and owning frame as the approved target. The commitment is then re-detected
 * from a fresh bounded document read and must still contain every material term
 * that was present in the approved summary. Finally, the result verifier must be
 * neutral (`unknown`) so a stale receipt/status cannot be attributed to the new
 * action. A bounded identity snapshot and target topology are retained only for
 * post-dispatch binding; ordinary traces never contain identifier values.
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
  if (!originalTarget || !approved.kind) return undefined;
  const expectedTargetId = approved.target?.id ?? originalTarget.id;

  try {
    const freshNodes = await engine.refresh();
    const freshTarget = activationTarget(step, { ...before, nodes: freshNodes });
    if (!freshTarget || freshTarget.id !== expectedTargetId || freshTarget.frameId !== originalTarget.frameId) {
      return undefined;
    }

    const context = await activePageContext(engine, freshTarget.frameId);
    if (!context) return undefined;
    const currentCommitment = freshCommitment(step, freshTarget, context.document);
    if (!approvedCommitmentStillMatches(approved, currentCommitment)) return undefined;

    const identity = snapshotBrowserCommitmentIdentity(
      approved.kind,
      context.document,
      context.browserState,
    );
    const targets = engine.targetState?.();
    const pageTargetId = engine.activePageTargetId?.();
    return {
      frameId: freshTarget.frameId,
      verification: verifyBrowserCommitment(approved, context.document),
      identity,
      ...(pageTargetId ? { pageTargetId } : {}),
      ...(targets ? { pageCount: targets.pages } : {}),
      ...(targets?.latestPage ? { latestPageSequence: targets.latestPage.sequence } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Poll bounded structured-document channels after an approved commitment.
 * The original page remains the primary channel. A popup is inspected only when
 * exactly one new page exists and CDP reports that the approved page opened it.
 * Cross-origin positive confirmation requires an exact pre-dispatch identifier
 * match, so arbitrary provider/result pages cannot become proof of success.
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
    let samePage: BrowserCommitmentVerificationSummary;
    try {
      samePage = verifyPageContext(
        approved,
        baseline,
        await activePageContext(engine, baseline.frameId),
      );
    } catch {
      samePage = verifyBrowserCommitment(approved, undefined);
    }

    if (
      samePage.status === 'confirmed' || samePage.status === 'declined' ||
      samePage.status === 'canceled' || samePage.status === 'mismatch'
    ) return samePage;
    latest = samePage;

    try {
      const popup = verifyPageContext(
        approved,
        baseline,
        await associatedPopupContext(engine, baseline),
      );
      if (
        popup.status === 'confirmed' || popup.status === 'declined' ||
        popup.status === 'canceled' || popup.status === 'mismatch'
      ) return popup;
      if (popup.status === 'pending' || latest.status === 'unknown') latest = popup;
    } catch {
      // Keep the original-page result. An unreadable popup never broadens success.
    }

    if (poll + 1 < maxPolls) await defaultSleep(pollIntervalMs);
  }

  return latest;
}
