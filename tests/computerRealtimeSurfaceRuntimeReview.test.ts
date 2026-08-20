import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeSurfaceRuntime, runBoundedRealtimeCalibration, type RealtimeCalibrationPlan, type RealtimeInput, type RealtimeInputDispatchResult, type RealtimeMediaCommand, type RealtimeMediaControlResult, type RealtimeMediaState, type RealtimeSurfaceAdapter, type RealtimeSurfaceState, type RealtimeVisualCapture, type RealtimeVisualCaptureRequest } from '../src/computer/realtimeSurfaceRuntime.js';
import type { ComputerSurfaceRef } from '../src/computer/environmentAdapter.js';

const surface = { adapterId: 'review-fake', environment: 'desktop-ui', surfaceId: 'surface', generation: 1 } as const;
class ReviewAdapter implements RealtimeSurfaceAdapter {
  readonly descriptor = { adapterId: 'review-fake', environment: 'desktop-ui' as const, supportedInputs: ['keyboard','pointer','relative-pointer','wheel'] as const, media: { observePlayback:true, observePosition:true, observeDuration:true, setPlayback:true, fullscreen:true } };
  state: RealtimeSurfaceState = { surface:{...surface}, captureGeneration:1, ownership:{focused:true,inputOwnerId:'input',captureOwnerId:'capture',sessionOwnerId:'session'}, relativePointer:{active:false,generation:1} };
  inputs: RealtimeInput[]=[]; sequence=0; mode:'ok'|'unknown'|'throw'='ok'; captures: Partial<RealtimeVisualCapture>[]=[]; controlCalls=0; onCapture?:()=>void; onInspect?:()=>void;
  captureRequests: RealtimeVisualCaptureRequest[]=[]; mediaCommands: RealtimeMediaCommand[]=[];
  media: RealtimeMediaState = { surface:{...surface}, playback:'paused', positionMs:1, durationMs:10, muted:false, volume:.5, fullscreen:{active:false} };
  async inspectSurface(_s:ComputerSurfaceRef){ this.onInspect?.(); return structuredClone(this.state); }
  async captureVisual(r:RealtimeVisualCaptureRequest){ this.captureRequests.push(structuredClone(r)); this.onCapture?.(); this.sequence++; const base=new Uint8Array(800); return {surface:{...this.state.surface},captureGeneration:1,frameId:`f${this.sequence}`,timestampMs:this.sequence,sequence:this.sequence,width:20,height:10,byteLength:base.byteLength,droppedBefore:0,truncated:false,data:base,...this.captures.shift()} as RealtimeVisualCapture; }
  async dispatchInput(_s:ComputerSurfaceRef,i:RealtimeInput):Promise<RealtimeInputDispatchResult>{ if(this.mode==='throw'){this.inputs.push(structuredClone(i));throw new Error('lost');} if(this.mode==='unknown')return{dispatch:'unknown'}; this.inputs.push(structuredClone(i));return{dispatch:'dispatched-once'}; }
  async observeMedia(){ return this.media; }
  async controlMedia(_s:ComputerSurfaceRef,c:RealtimeMediaCommand):Promise<RealtimeMediaControlResult>{ this.controlCalls++; this.mediaCommands.push(structuredClone(c)); return {localMediaEffect:'applied',externalPublicationEffect:'not-attempted',state:this.media}; }
  async setFullscreen(_s:ComputerSurfaceRef,active:boolean,ownerId:string){ this.media={...this.media,fullscreen:{active,ownerId:active?ownerId:undefined}}; return this.media; }
}

test('calibration stops after unknown dispatch and never reaches later candidates', async()=>{ const a=new ReviewAdapter();a.mode='unknown';const r=new RealtimeSurfaceRuntime(a);const l=await r.acquire(surface);const x=await runBoundedRealtimeCalibration(r,l,{candidates:[{id:'first',inputs:[{kind:'wheel',deltaX:0,deltaY:1}],probeDurationMs:0,keyboardSafety:'not-applicable'},{id:'later',inputs:[{kind:'pointer',action:'move',x:1,y:1}],probeDurationMs:0,keyboardSafety:'not-applicable'}],samplesPerPhase:1,visual:{limits:{maxPixels:1000,maxBytes:5000}},maxActions:4},{sleep:async()=>{}});assert.equal(x.candidates.length,1);assert.equal(x.candidates[0].reason,'input-dispatch-unknown');assert.equal(a.inputs.length,0); });

test('aggregate observation payload is bounded across samples', async()=>{ const a=new ReviewAdapter();const bytes=new Uint8Array(7*1024*1024);for(let i=0;i<5;i++)a.captures.push({width:1000,height:1000,data:bytes,byteLength:bytes.byteLength});const r=new RealtimeSurfaceRuntime(a);const l=await r.acquire(surface);await assert.rejects(r.observeVisual(l,{maxSamples:5,limits:{maxPixels:1_000_000,maxBytes:8*1024*1024}}),/aggregate pixel\/byte budget/); });

test('malformed media state is rejected and valid backend state is copied', async()=>{ const a=new ReviewAdapter();const r=new RealtimeSurfaceRuntime(a);const l=await r.acquire(surface);a.media={...a.media,playback:'bad' as RealtimeMediaState['playback']};await assert.rejects(r.observeMedia(l),/playback state/);a.media={...a.media,playback:'paused',fullscreen:{active:'yes' as unknown as boolean}};await assert.rejects(r.observeMedia(l),/fullscreen.active/);a.media={...a.media,fullscreen:{active:false},muted:'no' as unknown as boolean};await assert.rejects(r.observeMedia(l),/muted/);a.media={...a.media,muted:false};const shared=Object.freeze({...a.media,fullscreen:Object.freeze({...a.media.fullscreen})}) as RealtimeMediaState;a.media=shared;const observed=await r.observeMedia(l);assert.notStrictEqual(observed,shared);const controlled=await r.controlMedia(l,{kind:'playback',state:'playing'});assert.notStrictEqual(controlled.state,shared); });

test('extreme finite input magnitudes are rejected before dispatch', async()=>{ const a=new ReviewAdapter();const r=new RealtimeSurfaceRuntime(a);const l=await r.acquire(surface);await assert.rejects(r.dispatchInput(l,{kind:'pointer',action:'move',x:1_000_001,y:0}),/absolute pointer/);await assert.rejects(r.dispatchInput(l,{kind:'wheel',deltaX:0,deltaY:100_001}),/wheel delta/);await assert.rejects(r.dispatchInput(l,{kind:'relative-pointer',dx:32_769,dy:0}),/relative pointer/);assert.equal(a.inputs.length,0); });

test('calibration executes an immutable snapshot when caller mutates plan during baseline await', async()=>{
  const a=new ReviewAdapter(); const r=new RealtimeSurfaceRuntime(a); const l=await r.acquire(surface);
  const plan: RealtimeCalibrationPlan = { candidates:[{id:'attested',inputs:[{kind:'keyboard',action:'press',key:'a'}],probeDurationMs:0,keyboardSafety:'ordinary'}], samplesPerPhase:1, visual:{limits:{maxPixels:1000,maxBytes:5000}}, maxActions:2, safetyAttestation:{purpose:'bounded-control-calibration',consequentialCandidateIds:['attested']} };
  let mutated=false;
  a.onCapture=()=>{ if(mutated)return; mutated=true; const mutable=plan as unknown as { candidates:Array<{id:string;inputs:RealtimeInput[]}>; safetyAttestation:{consequentialCandidateIds:string[]} }; mutable.candidates[0].id='changed-after-validation'; mutable.candidates[0].inputs[0]={kind:'keyboard',action:'press',key:'Delete'}; mutable.safetyAttestation.consequentialCandidateIds[0]='changed-after-validation'; };
  const result=await runBoundedRealtimeCalibration(r,l,plan,{sleep:async()=>{}});
  assert.equal(result.candidates[0].id,'attested');
  assert.equal(result.candidates[0].status,'observed');
  assert.deepEqual(a.inputs,[{kind:'keyboard',action:'press',key:'a'}]);
});

test('invalid input discriminants and pointer button shapes fail before adapter dispatch', async()=>{
  const a=new ReviewAdapter(); const r=new RealtimeSurfaceRuntime(a); const l=await r.acquire(surface);
  await assert.rejects(r.dispatchInput(l,{kind:'keyboard',action:'launch' as 'press',key:'a'}),/keyboard action/);
  await assert.rejects(r.dispatchInput(l,{kind:'pointer',action:'drag' as 'move',x:1,y:1}),/pointer action/);
  await assert.rejects(r.dispatchInput(l,{kind:'pointer',action:'down',button:'primary' as 'left'}),/supported button/);
  await assert.rejects(r.dispatchInput(l,{kind:'mystery'} as unknown as RealtimeInput),/input kind/);
  assert.equal(a.inputs.length,0);
});

test('invalid media command discriminants and fields fail before adapter control', async()=>{
  const a=new ReviewAdapter(); const r=new RealtimeSurfaceRuntime(a); const l=await r.acquire(surface);
  await assert.rejects(r.controlMedia(l,{kind:'playback',state:'buffering' as 'playing'}),/playback command state/);
  await assert.rejects(r.controlMedia(l,{kind:'mute',muted:'yes' as unknown as boolean}),/mute command/);
  await assert.rejects(r.controlMedia(l,{kind:'publish'} as unknown as RealtimeMediaCommand),/media command kind/);
  assert.equal(a.controlCalls,0);
});

test('dispatchInput snapshots caller input before freshness await', async()=>{
  const a=new ReviewAdapter(); const r=new RealtimeSurfaceRuntime(a); const l=await r.acquire(surface);
  const input: RealtimeInput={kind:'keyboard',action:'press',key:'a'}; let mutated=false;
  a.onInspect=()=>{ if(mutated)return; mutated=true; (input as {action:string;key:string}).action='down'; (input as {action:string;key:string}).key='Delete'; };
  await r.dispatchInput(l,input);
  assert.deepEqual(a.inputs,[{kind:'keyboard',action:'press',key:'a'}]);
});

test('controlMedia snapshots caller command before freshness await', async()=>{
  const a=new ReviewAdapter(); const r=new RealtimeSurfaceRuntime(a); const l=await r.acquire(surface);
  const command: RealtimeMediaCommand={kind:'playback',state:'playing'}; let mutated=false;
  a.onInspect=()=>{ if(mutated)return; mutated=true; (command as {kind:string;state?:string}).kind='publish'; (command as {kind:string;state?:string}).state='stopped'; };
  await r.controlMedia(l,command);
  assert.deepEqual(a.mediaCommands,[{kind:'playback',state:'playing'}]);
});

test('observeVisual snapshots maxSamples bounds and limits before freshness/capture awaits', async()=>{
  const a=new ReviewAdapter(); const r=new RealtimeSurfaceRuntime(a); const l=await r.acquire(surface);
  const request={maxSamples:2,bounds:{x:1,y:2,width:20,height:10},limits:{maxPixels:1000,maxBytes:5000}};
  let mutated=false;
  a.onInspect=()=>{ if(mutated)return; mutated=true; request.maxSamples=120; request.bounds.width=999999; request.limits.maxPixels=4_194_304; request.limits.maxBytes=8*1024*1024; };
  await r.observeVisual(l,request);
  assert.equal(a.captureRequests.length,2);
  for(const captured of a.captureRequests){ assert.deepEqual(captured.bounds,{x:1,y:2,width:20,height:10}); assert.deepEqual(captured.limits,{maxPixels:1000,maxBytes:5000}); }
});
