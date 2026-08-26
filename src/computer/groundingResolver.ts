import type { ComputerEntityRef, ComputerSurfaceRef } from './environmentAdapter.js';

export const GROUNDING_KINDS = [
  'native-api',
  'semantic-ui',
  'keyboard-semantic',
  'visual-grounded',
  'raw-coordinate',
] as const;

export type GroundingKind = typeof GROUNDING_KINDS[number];

export interface GroundingFrameRef {
  readonly surface: ComputerSurfaceRef;
  readonly frameSequence: number;
  readonly capturedAtMs: number;
}

export interface GroundingCandidate {
  readonly id: string;
  readonly kind: GroundingKind;
  readonly confidence: number;
  readonly target?: ComputerEntityRef;
  readonly frame?: GroundingFrameRef;
  readonly supported: boolean;
  readonly stale: boolean;
  readonly evidence?: readonly string[];
}

export interface GroundingResolution {
  readonly selected?: GroundingCandidate;
  readonly rejected: readonly { readonly id: string; readonly reason: string }[];
}

const PRIORITY: Readonly<Record<GroundingKind, number>> = Object.freeze({
  'native-api': 500,
  'semantic-ui': 400,
  'keyboard-semantic': 300,
  'visual-grounded': 200,
  'raw-coordinate': 100,
});

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

function validCandidate(candidate: GroundingCandidate): string | undefined {
  if (!ID_PATTERN.test(candidate.id)) return 'invalid-candidate-id';
  if (!GROUNDING_KINDS.includes(candidate.kind)) return 'unsupported-grounding-kind';
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) return 'invalid-confidence';
  if (!candidate.supported) return 'unsupported';
  if (candidate.stale) return 'stale';

  if (candidate.kind === 'visual-grounded' || candidate.kind === 'raw-coordinate') {
    if (!candidate.frame) return 'visual-candidate-not-frame-bound';
    if (candidate.frame.surface.generation === undefined) return 'visual-candidate-not-generation-bound';
    if (!Number.isSafeInteger(candidate.frame.frameSequence) || candidate.frame.frameSequence < 0) return 'invalid-frame-sequence';
  }
  return undefined;
}

function compareCandidates(a: GroundingCandidate, b: GroundingCandidate): number {
  const priority = PRIORITY[b.kind] - PRIORITY[a.kind];
  if (priority !== 0) return priority;
  const confidence = b.confidence - a.confidence;
  if (confidence !== 0) return confidence;
  return a.id.localeCompare(b.id);
}

/**
 * Chooses the strongest currently valid embodiment without pretending visual
 * evidence is authoritative identity. Native/application APIs and semantic UI
 * operations outrank keyboard and pointer fallbacks.
 */
export function resolveGrounding(candidates: readonly GroundingCandidate[]): GroundingResolution {
  const accepted: GroundingCandidate[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];

  for (const candidate of candidates) {
    const reason = validCandidate(candidate);
    if (reason) rejected.push(Object.freeze({ id: candidate.id, reason }));
    else accepted.push(candidate);
  }

  accepted.sort(compareCandidates);
  return Object.freeze({
    ...(accepted[0] ? { selected: accepted[0] } : {}),
    rejected: Object.freeze(rejected),
  });
}
