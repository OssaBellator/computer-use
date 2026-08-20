import { RealtimeInputDispatchError, RealtimeSurfaceError, type RealtimeSurfaceLease, type RealtimeTemporalObservation, type RealtimeTemporalObservationRequest, type RealtimeInput } from './realtimeSurfaceTypes.js';
import { RealtimeSurfaceRuntime, validateRealtimeInput, validateRealtimeVisualBounds } from './realtimeSurfaceCore.js';

const MAX_CAL_CANDIDATES = 16, MAX_CAL_INPUTS = 4, MAX_CAL_SAMPLES = 8, MAX_CAL_MS = 250, MAX_CAL_ACTIONS = 64;
const KEYBOARD_SAFETY = ['not-applicable','ordinary','potentially-consequential'] as const;
function positiveInt(v: number, max: number) { return Number.isSafeInteger(v) && v >= 1 && v <= max; }
function opaque(v: string, field: string) { if (typeof v !== 'string' || !v || /[\r\n\0]/.test(v) || new TextEncoder().encode(v).byteLength > 256) throw new RealtimeSurfaceError('invalid-identity', `${field} must be a bounded opaque identifier`); }

export interface RealtimeCalibrationCandidate { id: string; inputs: readonly RealtimeInput[]; probeDurationMs: number; keyboardSafety: 'not-applicable' | 'ordinary' | 'potentially-consequential' }
export interface RealtimeCalibrationSafetyAttestation { purpose: 'bounded-control-calibration'; consequentialCandidateIds: readonly string[] }
export interface RealtimeCalibrationPlan { candidates: readonly RealtimeCalibrationCandidate[]; samplesPerPhase: number; visual: Omit<RealtimeTemporalObservationRequest,'maxSamples'>; maxActions: number; safetyAttestation?: RealtimeCalibrationSafetyAttestation }
export interface RealtimeCalibrationCandidateResult { id:string; status:'observed'|'rejected'; reason?:string; baseline?:RealtimeTemporalObservation; after?:RealtimeTemporalObservation }
export interface RealtimeCalibrationResult { candidates: readonly RealtimeCalibrationCandidateResult[]; actionsDispatched:number; truncated:boolean }

function snapshotInput(input: RealtimeInput): RealtimeInput {
  if (!input || typeof input !== 'object') return input;
  return { ...input } as RealtimeInput;
}

function snapshotPlan(plan: RealtimeCalibrationPlan): RealtimeCalibrationPlan {
  const candidates = plan.candidates.map((candidate) => ({
    id: candidate.id,
    inputs: candidate.inputs.map(snapshotInput),
    probeDurationMs: candidate.probeDurationMs,
    keyboardSafety: candidate.keyboardSafety,
  }));
  const visual = {
    limits: { maxPixels: plan.visual.limits.maxPixels, maxBytes: plan.visual.limits.maxBytes },
    ...(plan.visual.bounds ? { bounds: { ...plan.visual.bounds } } : {}),
  };
  const safetyAttestation = plan.safetyAttestation ? {
    purpose: plan.safetyAttestation.purpose,
    consequentialCandidateIds: [...plan.safetyAttestation.consequentialCandidateIds],
  } : undefined;
  return {
    candidates,
    samplesPerPhase: plan.samplesPerPhase,
    visual,
    maxActions: plan.maxActions,
    ...(safetyAttestation ? { safetyAttestation } : {}),
  };
}

function calibrationOk(p: RealtimeCalibrationPlan) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.candidates) || !positiveInt(p.candidates.length,MAX_CAL_CANDIDATES)||!positiveInt(p.samplesPerPhase,MAX_CAL_SAMPLES)||!positiveInt(p.maxActions,MAX_CAL_ACTIONS)) throw new RealtimeSurfaceError('calibration-bound','calibration plan exceeds bounds');
  validateRealtimeVisualBounds(p.visual.bounds,p.visual.limits);
  const ids=new Set<string>();
  for (const c of p.candidates) {
    if (!c || typeof c !== 'object') throw new RealtimeSurfaceError('calibration-bound','candidate must be an object');
    opaque(c.id,'candidate id');
    if (ids.has(c.id)||!Array.isArray(c.inputs)||!positiveInt(c.inputs.length,MAX_CAL_INPUTS)||!Number.isSafeInteger(c.probeDurationMs)||c.probeDurationMs<0||c.probeDurationMs>MAX_CAL_MS) throw new RealtimeSurfaceError('calibration-bound','candidate exceeds bounds');
    ids.add(c.id);
    if (!KEYBOARD_SAFETY.includes(c.keyboardSafety as typeof KEYBOARD_SAFETY[number])) throw new RealtimeSurfaceError('calibration-safety','keyboardSafety is unsupported');
    c.inputs.forEach(validateRealtimeInput);
    const k=c.inputs.some(i=>i.kind==='keyboard');
    if (k && c.keyboardSafety==='not-applicable') throw new RealtimeSurfaceError('calibration-safety','keyboard candidate must identify safety scope');
    if (!k && c.keyboardSafety!=='not-applicable') throw new RealtimeSurfaceError('calibration-safety','non-keyboard candidate must use not-applicable');
  }
  if (p.safetyAttestation) {
    if (p.safetyAttestation.purpose !== 'bounded-control-calibration' || !Array.isArray(p.safetyAttestation.consequentialCandidateIds)) throw new RealtimeSurfaceError('calibration-safety','invalid safety attestation');
    const attested = new Set<string>();
    for (const id of p.safetyAttestation.consequentialCandidateIds) {
      opaque(id,'attested candidate id');
      if (attested.has(id)) throw new RealtimeSurfaceError('calibration-safety','attested candidate IDs must be unique');
      attested.add(id);
    }
  }
}

export async function runBoundedRealtimeCalibration(runtime:RealtimeSurfaceRuntime,lease:RealtimeSurfaceLease,plan:RealtimeCalibrationPlan,options:{sleep?:(ms:number)=>Promise<void>}={}):Promise<RealtimeCalibrationResult>{
  const snapshot=snapshotPlan(plan);
  calibrationOk(snapshot);
  const sleep=options.sleep??(async ms=>{if(ms>0)await new Promise(r=>setTimeout(r,ms));});
  const results:RealtimeCalibrationCandidateResult[]=[];
  let actions=0,truncated=false;
  for(const c of snapshot.candidates){
    const baseline=await runtime.observeVisual(lease,{...snapshot.visual,maxSamples:snapshot.samplesPerPhase});
    truncated ||= baseline.truncated;
    if(c.inputs.some(i=>i.kind==='keyboard') && !(snapshot.safetyAttestation?.purpose==='bounded-control-calibration' && snapshot.safetyAttestation.consequentialCandidateIds.includes(c.id))){results.push({id:c.id,status:'rejected',reason:'safety-attestation-required',baseline});continue;}
    if(actions+c.inputs.length>snapshot.maxActions){results.push({id:c.id,status:'rejected',reason:'action-budget-exhausted',baseline});truncated=true;continue;}
    let notDispatched=false,terminate=false;
    for(const i of c.inputs){
      try{
        const d=await runtime.dispatchInput(lease,i);
        if(d.dispatch==='dispatched-once')actions++;
        else if(d.dispatch==='unknown'){results.push({id:c.id,status:'rejected',reason:'input-dispatch-unknown',baseline});truncated=true;terminate=true;break;}
        else {notDispatched=true;break;}
      }catch(e){
        if(e instanceof RealtimeInputDispatchError&&e.dispatch==='unknown'){results.push({id:c.id,status:'rejected',reason:'input-dispatch-unknown',baseline});truncated=true;terminate=true;break;}
        throw e;
      }
    }
    if(terminate)break;
    if(notDispatched){results.push({id:c.id,status:'rejected',reason:'input-not-dispatched',baseline});continue;}
    await sleep(c.probeDurationMs);
    const after=await runtime.observeVisual(lease,{...snapshot.visual,maxSamples:snapshot.samplesPerPhase});
    truncated ||= after.truncated;
    results.push({id:c.id,status:'observed',baseline,after});
  }
  return {candidates:results,actionsDispatched:actions,truncated};
}
