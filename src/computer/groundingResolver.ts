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

export interface GroundingRoutingSignals {
  /** 0..1. How reliably this embodiment has executed comparable actions. */
  readonly reliability?:number;
  /** 0..1. Strength of post-action verification available to this candidate. */
  readonly verification?:number;
  /** 0..1. Execution/latency/resource burden; lower is better. */
  readonly cost?:number;
  /** 0..1. Degree to which foreground/interactive desktop ownership is required; lower is better. */
  readonly foreground?:number;
  /** 0..1. Operational/consequence risk attributable to this embodiment; lower is better. */
  readonly risk?:number;
}

export interface GroundingCandidate {
  readonly id: string;
  readonly kind: GroundingKind;
  readonly confidence: number;
  readonly target?: ComputerEntityRef;
  readonly frame?: GroundingFrameRef;
  readonly supported: boolean;
  /** Bounded machine-readable reason when current target/provider support is absent. */
  readonly supportReason?: string;
  readonly stale: boolean;
  /** Optional bounded routing evidence. It can rank peers but never create authority. */
  readonly routing?:GroundingRoutingSignals;
  readonly evidence?: readonly string[];
}

export interface GroundingConflict {
  readonly candidateIds:readonly string[];
  readonly reason:'authoritative-target-conflict';
}

export interface GroundingResolution {
  readonly selected?: GroundingCandidate;
  readonly rejected: readonly { readonly id: string; readonly reason: string }[];
  readonly conflicts:readonly GroundingConflict[];
}

export type EmbodimentSelectionReason =
  | 'highest-authority-current-supported'
  | 'authoritative-conflict'
  | 'no-valid-candidate';

export interface EmbodimentCandidateExposure {
  readonly id:string;
  readonly kind:GroundingKind;
  readonly eligible:boolean;
  readonly rejectionReason?:string;
  /** Authority rank is categorical ordering, not a model-controlled score. */
  readonly authorityRank:number;
  readonly semanticStrength:number;
  readonly reliability:number;
  readonly verification:number;
  readonly cost:number;
  readonly foreground:number;
  readonly risk:number;
  readonly availability:number;
  /** 0..1 score used only among candidates with the same authority rank. */
  readonly peerScore:number;
}

export interface EmbodimentRoutingDecision {
  readonly availableEmbodiments:readonly GroundingKind[];
  readonly selectedEmbodiment?:GroundingKind;
  readonly selectedCandidateId?:string;
  readonly selectionReason:EmbodimentSelectionReason;
  readonly fallbackReason?:string;
  /** Complete bounded candidate/selection exposure for evaluation and audits. */
  readonly candidates:readonly EmbodimentCandidateExposure[];
  readonly resolution:GroundingResolution;
}

const PRIORITY: Readonly<Record<GroundingKind, number>> = Object.freeze({
  'native-api': 500,
  'semantic-ui': 400,
  'keyboard-semantic': 300,
  'visual-grounded': 200,
  'raw-coordinate': 100,
});

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SEMANTIC_STRENGTH:Readonly<Record<GroundingKind,number>>=Object.freeze({
  'native-api':1,
  'semantic-ui':0.9,
  'keyboard-semantic':0.6,
  'visual-grounded':0.3,
  'raw-coordinate':0.1,
});
function validSignal(value:number|undefined):boolean{return value===undefined||(Number.isFinite(value)&&value>=0&&value<=1);}
function routingSignalsValid(candidate:GroundingCandidate):boolean{
  const routing=candidate.routing;
  return routing===undefined||(
    validSignal(routing.reliability)&&validSignal(routing.verification)&&validSignal(routing.cost)&&
    validSignal(routing.foreground)&&validSignal(routing.risk)
  );
}
function boundedSignal(value:number|undefined,fallback:number):number{
  return Number.isFinite(value)?Math.max(0,Math.min(1,value!)):fallback;
}
function routingExposure(candidate:GroundingCandidate,rejectionReason?:string):EmbodimentCandidateExposure{
  const reliability=boundedSignal(candidate.routing?.reliability,candidate.confidence);
  const verification=boundedSignal(candidate.routing?.verification,candidate.confidence);
  const cost=boundedSignal(candidate.routing?.cost,0.5);
  const foreground=boundedSignal(candidate.routing?.foreground,0.5);
  const risk=boundedSignal(candidate.routing?.risk,0.5);
  const availability=rejectionReason===undefined?1:0;
  const semanticStrength=SEMANTIC_STRENGTH[candidate.kind];
  const peerScore=Math.max(0,Math.min(1,
    semanticStrength*0.20+reliability*0.25+verification*0.25+(1-cost)*0.10+(1-foreground)*0.05+(1-risk)*0.10+availability*0.05,
  ));
  return Object.freeze({
    id:candidate.id,kind:candidate.kind,eligible:rejectionReason===undefined,
    ...(rejectionReason!==undefined?{rejectionReason}:{}),authorityRank:PRIORITY[candidate.kind],semanticStrength,
    reliability,verification,cost,foreground,risk,availability,peerScore,
  });
}

function validCandidate(candidate: GroundingCandidate): string | undefined {
  if (!ID_PATTERN.test(candidate.id)) return 'invalid-candidate-id';
  if (!GROUNDING_KINDS.includes(candidate.kind)) return 'unsupported-grounding-kind';
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) return 'invalid-confidence';
  if (!routingSignalsValid(candidate)) return 'invalid-routing-signal';
  if (candidate.supportReason!==undefined&&!ID_PATTERN.test(candidate.supportReason)) return 'invalid-support-reason';
  if (candidate.stale) return 'stale';
  if (!candidate.supported) return candidate.supportReason ?? 'unsupported';

  if (candidate.kind === 'visual-grounded' || candidate.kind === 'raw-coordinate') {
    if (candidate.target!==undefined) return 'visual-candidate-semantic-target-forbidden';
    if (!candidate.frame) return 'visual-candidate-not-frame-bound';
    if (candidate.frame.surface.generation === undefined) return 'visual-candidate-not-generation-bound';
    if (!Number.isSafeInteger(candidate.frame.frameSequence) || candidate.frame.frameSequence < 0) return 'invalid-frame-sequence';
  }
  return undefined;
}

function compareCandidates(a: GroundingCandidate, b: GroundingCandidate): number {
  const priority = PRIORITY[b.kind] - PRIORITY[a.kind];
  if (priority !== 0) return priority;
  const score=routingExposure(b).peerScore-routingExposure(a).peerScore;
  if(score!==0)return score;
  const confidence = b.confidence - a.confidence;
  if (confidence !== 0) return confidence;
  return a.id.localeCompare(b.id);
}
function sameTarget(a:ComputerEntityRef,b:ComputerEntityRef):boolean {
  return a.adapterId===b.adapterId&&a.environment===b.environment&&a.kind===b.kind&&a.entityId===b.entityId&&
    a.surfaceId===b.surfaceId&&a.generation===b.generation;
}
function authoritative(candidate:GroundingCandidate):boolean {
  return candidate.kind==='native-api'||candidate.kind==='semantic-ui';
}
function authoritativeConflicts(candidates:readonly GroundingCandidate[]):readonly GroundingConflict[]{
  const withTargets=candidates.filter((candidate)=>authoritative(candidate)&&candidate.target!==undefined);
  const conflicting=new Set<string>();
  for(let i=0;i<withTargets.length;i+=1){
    for(let j=i+1;j<withTargets.length;j+=1){
      if(!sameTarget(withTargets[i]!.target!,withTargets[j]!.target!)){
        conflicting.add(withTargets[i]!.id);
        conflicting.add(withTargets[j]!.id);
      }
    }
  }
  return conflicting.size===0?Object.freeze([]):Object.freeze([
    Object.freeze({candidateIds:Object.freeze([...conflicting].sort()),reason:'authoritative-target-conflict' as const}),
  ]);
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
  const conflicts=authoritativeConflicts(accepted);
  return Object.freeze({
    ...(conflicts.length===0&&accepted[0] ? { selected: accepted[0] } : {}),
    rejected: Object.freeze(rejected),
    conflicts,
  });
}

/**
 * Produces a bounded decision exposure for the embodiment router. The planner can
 * inspect what was available and why one embodiment was selected without gaining
 * authority to reinterpret rejected or conflicting candidates.
 */
export function routeGroundingEmbodiment(candidates:readonly GroundingCandidate[]):EmbodimentRoutingDecision {
  const resolution=resolveGrounding(candidates);
  const candidateExposure=Object.freeze(candidates.map((candidate)=>routingExposure(candidate,validCandidate(candidate))));
  const availableEmbodiments=Object.freeze([...new Set(
    candidates
      .filter((candidate)=>!validCandidate(candidate))
      .map((candidate)=>candidate.kind),
  )].sort((a,b)=>PRIORITY[b]-PRIORITY[a]));
  if(resolution.conflicts.length>0){
    return Object.freeze({
      availableEmbodiments,
      selectionReason:'authoritative-conflict',
      fallbackReason:'authoritative-target-conflict',
      candidates:candidateExposure,
      resolution,
    });
  }
  if(!resolution.selected){
    return Object.freeze({
      availableEmbodiments,
      selectionReason:'no-valid-candidate',
      fallbackReason:'no-current-supported-embodiment',
      candidates:candidateExposure,
      resolution,
    });
  }
  return Object.freeze({
    availableEmbodiments,
    selectedEmbodiment:resolution.selected.kind,
    selectedCandidateId:resolution.selected.id,
    selectionReason:'highest-authority-current-supported',
    candidates:candidateExposure,
    resolution,
  });
}
