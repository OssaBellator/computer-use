import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalComputeAdapter, LOCAL_COMPUTE_CAPABILITY, localComputeJobEntity, type LocalComputeJson } from '../src/computer/localComputeAdapter.js';

const operations=[
  {id:'math.add',effect:'pure-read-only' as const,execute:(input:LocalComputeJson)=>{const v=input as {a:number;b:number};return {sum:v.a+v.b}}},
  {id:'stats.mean',effect:'pure-read-only' as const,execute:(input:LocalComputeJson)=>{const v=input as number[];return {mean:v.reduce((a,b)=>a+b,0)/v.length,count:v.length}}},
  {id:'transform.upper',effect:'local-artifact-creation' as const,execute:(input:LocalComputeJson)=>String(input).toUpperCase()},
  {id:'test.timeout',effect:'pure-read-only' as const,execute:(_input:LocalComputeJson,ctx:{signal:AbortSignal})=>new Promise<LocalComputeJson>((resolve,reject)=>{ctx.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});setTimeout(()=>resolve('late'),100)})},
  {id:'test.large',effect:'pure-read-only' as const,execute:()=> 'x'.repeat(2048)},
];
function adapter(ambiguous:string[]=[]){return new LocalComputeAdapter({id:'compute-test',operations,ambiguousDispatchOperationIds:ambiguous})}
function request(jobId:string,generation:number,operation:string,input:LocalComputeJson,effect:'observe-only'|'local-reversible'='observe-only',idempotency:'read-only'|'non-idempotent'='read-only',limits?:object){return {adapterId:'compute-test',actionId:`action-${jobId}-${generation}`,capability:LOCAL_COMPUTE_CAPABILITY,effect,idempotency,payload:{job:{jobId,generation},operation,input,limits}} as const}

test('arithmetic and statistics verify bounded output identity',async()=>{
 const a=adapter();
 const sum=await a.act(request('sum',0,'math.add',{a:2,b:5}));
 assert.equal(sum.status,'completed'); assert.equal(sum.verification,'verified'); assert.deepEqual((sum.details as any).output,{sum:7});
 const mean=await a.act(request('mean',0,'stats.mean',[2,4,6])); assert.deepEqual((mean.details as any).output,{mean:4,count:3});
 assert.match((mean.details as any).job.outputArtifact.contentHash,/^fnv64-/); assert.equal((mean.details as any).job.outputArtifact.shape,'object:2');
});

test('bounded artifact transformation verifies artifact identity and state',async()=>{
 const a=adapter(); const result=await a.act(request('upper',0,'transform.upper','secret text','local-reversible','non-idempotent'));
 assert.equal(result.status,'completed'); assert.deepEqual(result.evidence,['compute-artifact-verified']);
 const ref=(result.details as any).artifact; assert.equal(ref.state,'committed'); assert.equal(a.artifactContent(ref),'SECRET TEXT');
});

test('timeout is deterministic and dispatched once',async()=>{
 const result=await adapter().act(request('timeout',0,'test.timeout',null,'observe-only','read-only',{timeBudgetMs:5}));
 assert.equal(result.status,'failed'); assert.equal(result.dispatch,'dispatched-once'); assert.equal((result.details as any).job.executionState,'timed-out');
});

test('output and input limits are bounded',async()=>{
 const a=adapter();
 const output=await a.act(request('large',0,'test.large',null,'observe-only','read-only',{maxOutputBytes:32})); assert.deepEqual(output.evidence,['compute-output-limit']);
 const input=await a.act(request('input',0,'math.add',{a:1,b:2,pad:'x'.repeat(100)} as any,'observe-only','read-only',{maxInputBytes:16})); assert.equal(input.dispatch,'not-dispatched'); assert.deepEqual(input.evidence,['compute-input-limit']);
});

test('stale identity is rejected before dispatch',async()=>{
 const a=adapter(); await a.act(request('reuse',2,'math.add',{a:1,b:1})); const stale=await a.act(request('reuse',1,'math.add',{a:1,b:1}));
 assert.equal(stale.dispatch,'not-dispatched'); assert.deepEqual(stale.evidence,['compute-job-stale']);
});

test('definite pre-dispatch validation failure is not dispatched',async()=>{
 const bad=await adapter().act({...request('bad',0,'math.add',{a:1,b:2}),payload:{job:{jobId:'bad',generation:0},operation:'math.add',input:{a:1,b:2},command:'sh -c whoami'}} as any);
 assert.equal(bad.dispatch,'not-dispatched'); assert.deepEqual(bad.evidence,['compute-request-invalid']);
});

test('ambiguous dispatch becomes unknown and artifact job is not retried',async()=>{
 const a=adapter(['transform.upper']); const req=request('ambiguous',0,'transform.upper','value','local-reversible','non-idempotent');
 const first=await a.act(req); assert.equal(first.dispatch,'unknown'); assert.equal(first.status,'unknown');
 const second=await a.act(req); assert.equal(second.dispatch,'unknown'); assert.deepEqual(second.evidence,['compute-known-dispatch-unknown']);
 assert.equal((second.details as any).job.executionState,'unknown');
});

test('observation and evidence do not copy sensitive input/output',async()=>{
 const a=adapter(); const secret='MODEL_INPUT_DO_NOT_TRACE'; const result=await a.act(request('privacy',0,'transform.upper',secret,'local-reversible','non-idempotent'));
 assert.ok(!JSON.stringify(result.evidence).includes(secret));
 const observed=await a.observe({adapterId:'compute-test',channel:'compute',target:localComputeJobEntity('compute-test',{jobId:'privacy',generation:0})});
 const trace=JSON.stringify(observed); assert.ok(!trace.includes(secret)); assert.ok(!trace.includes(secret.toUpperCase())); assert.match(trace,/artifact:fnv64-/);
});

test('unsafe operation registrations and shell-like masquerading are rejected',async()=>{
 assert.throws(()=>new LocalComputeAdapter({operations:[{id:'unsafe.shell',effect:'process-execution',execute:()=>null}]}),/unsafe local compute operation effect/);
 const misuse=await adapter().act(request('shell',0,'sh -c id',null)); assert.equal(misuse.dispatch,'not-dispatched'); assert.deepEqual(misuse.evidence,['compute-request-invalid']);
});
