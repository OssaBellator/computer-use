import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsGraphicsCaptureRuntime, type WindowsGraphicsCaptureObservation } from '../src/computer/windowsGraphicsCaptureRuntime.js';
import { WindowsRetainedGraphicsCaptureRuntime, WindowsVisualArtifactRetentionManager, windowsVisualSensitivityForSemanticTree } from '../src/computer/windowsVisualArtifactRetention.js';

const window = Object.freeze({
  hwnd:'0x900',desktopSessionId:'interactive:1',process:Object.freeze({processId:900,startIdentity:'p900'}),generation:1,
});
const observation:WindowsGraphicsCaptureObservation = Object.freeze({
  frame:Object.freeze({
    window,captureGeneration:2,frameSequence:10,capturedAtMs:100,contentWidth:400,contentHeight:300,
    geometry:Object.freeze({left:0,top:0,width:400,height:300,dpi:96}),
  }),
  artifact:Object.freeze({token:'artifact-2-10',mediaType:'image/png',byteLength:100_000}),
});

test('semantic password fields automatically escalate visual retention to credential-adjacent',()=>{
  const ordinary={ref:{window,runtimeId:[1],controlType:'Edit',generation:1},patterns:['value'],enabled:true,value:'ordinary'} as const;
  const password={ref:{window,runtimeId:[2],controlType:'Edit',generation:1},patterns:['value'],enabled:true,isPassword:true} as const;
  assert.equal(windowsVisualSensitivityForSemanticTree(undefined),'normal');
  assert.equal(windowsVisualSensitivityForSemanticTree(ordinary),'sensitive-field');
  assert.equal(windowsVisualSensitivityForSemanticTree({...ordinary,children:[password]}),'credential-adjacent');
});

test('sensitive screenshots have shorter enforceable retention windows', () => {
  const manager = new WindowsVisualArtifactRetentionManager({releaseArtifact:async()=>undefined},()=>100);
  assert.throws(()=>manager.acquire(observation,{sensitivity:'credential-adjacent',ttlMs:1_001}),/ttl-invalid/);
  assert.throws(()=>manager.acquire(observation,{sensitivity:'sensitive-field',ttlMs:5_001}),/ttl-invalid/);
  const lease = manager.acquire(observation,{sensitivity:'credential-adjacent',ttlMs:1_000});
  assert.equal(lease.expiresAtMs,1_100);
});

test('release destroys backend artifact authority and accounts bytes once', async () => {
  const released:string[] = [];
  const manager = new WindowsVisualArtifactRetentionManager({releaseArtifact:async(token)=>{released.push(token);}},()=>100);
  const lease = manager.acquire(observation,{sensitivity:'normal',ttlMs:5_000});
  assert.equal(manager.activeCount(),1);
  assert.equal(manager.activeBytes(),100_000);
  await manager.release(lease);
  await manager.release(lease);
  assert.deepEqual(released,['artifact-2-10']);
  assert.equal(manager.activeCount(),0);
  assert.equal(manager.activeBytes(),0);
  assert.deepEqual(manager.validate(lease,observation),{status:'released'});
});

test('expired artifact is invalid before cleanup and releaseExpired destroys it', async () => {
  let now = 100;
  const released:string[] = [];
  const manager = new WindowsVisualArtifactRetentionManager({releaseArtifact:async(token)=>{released.push(token);}},()=>now);
  const lease = manager.acquire(observation,{sensitivity:'normal',ttlMs:10});
  now = 111;
  assert.deepEqual(manager.validate(lease,observation),{status:'expired'});
  assert.equal(await manager.releaseExpired(),1);
  assert.deepEqual(released,['artifact-2-10']);
  assert.equal(manager.activeCount(),0);
});

test('lease cannot authorize a different frame sharing copied metadata', () => {
  const manager = new WindowsVisualArtifactRetentionManager({releaseArtifact:async()=>undefined},()=>100);
  const lease = manager.acquire(observation,{sensitivity:'normal',ttlMs:1_000});
  const different = {
    ...observation,
    frame:{...observation.frame,frameSequence:11},
  };
  assert.deepEqual(manager.validate(lease,different),{status:'frame-mismatch'});
});

test('consume revokes local artifact authority before exposing one bounded payload',async()=>{
  const consumed:string[]=[];
  const manager=new WindowsVisualArtifactRetentionManager({
    releaseArtifact:async()=>undefined,
    consumeArtifact:async(token,maxBytes)=>{
      consumed.push(`${token}:${maxBytes}`);
      return Object.freeze({mediaType:'image/png',bytes:new Uint8Array([1,2,3])});
    },
  },()=>100);
  const lease=manager.acquire(observation,{sensitivity:'normal',ttlMs:5_000});
  const payload=await manager.consume(lease,100_000);
  assert.deepEqual(consumed,['artifact-2-10:100000']);
  assert.equal(payload.mediaType,'image/png');
  assert.deepEqual([...payload.bytes],[1,2,3]);
  assert.equal(manager.activeCount(),0);
  assert.equal(manager.activeBytes(),0);
  assert.deepEqual(manager.validate(lease,observation),{status:'released'});
  await assert.rejects(()=>manager.consume(lease,100_000),/released/);
});

test('releaseAll revokes local artifact authority before reporting backend cleanup uncertainty',async()=>{
  const second:WindowsGraphicsCaptureObservation=Object.freeze({
    ...observation,
    frame:Object.freeze({...observation.frame,frameSequence:11}),
    artifact:Object.freeze({token:'artifact-2-11',mediaType:'image/png',byteLength:50_000}),
  });
  const attempted:string[]=[];
  const manager=new WindowsVisualArtifactRetentionManager({releaseArtifact:async token=>{
    attempted.push(token);
    if(token==='artifact-2-10')throw new Error('destroy failed');
  }},()=>100);
  const firstLease=manager.acquire(observation,{sensitivity:'normal',ttlMs:5_000});
  const secondLease=manager.acquire(second,{sensitivity:'normal',ttlMs:5_000});
  await assert.rejects(()=>manager.releaseAll(),/release-uncertain/);
  assert.deepEqual(attempted,['artifact-2-10','artifact-2-11']);
  assert.equal(manager.activeCount(),0);
  assert.equal(manager.activeBytes(),0);
  assert.deepEqual(manager.validate(firstLease,observation),{status:'released'});
  assert.deepEqual(manager.validate(secondLease,second),{status:'released'});
});

function captureHarness(releaseArtifact:(token:string)=>Promise<void>){
  const bridge={
    captureNextFrame:async()=>({
      window,captureGeneration:1,frameSequence:0,capturedAtMs:100,contentWidth:400,contentHeight:300,
      geometry:{left:0,top:0,width:400,height:300,dpi:96},
      artifact:{token:'atomic-artifact',mediaType:'image/png',byteLength:100_000},
    }),
    releaseArtifact,
  };
  const capture=new WindowsGraphicsCaptureRuntime(bridge);
  const retention=new WindowsVisualArtifactRetentionManager(bridge,()=>100);
  return {capture,retention,atomic:new WindowsRetainedGraphicsCaptureRuntime(capture,retention)};
}

test('retained capture revokes native artifact when lease acquisition fails', async()=>{
  const released:string[]=[];
  const {atomic,retention}=captureHarness(async token=>{released.push(token);});
  await assert.rejects(()=>atomic.captureRetained(
    window,{maxPixels:1_000_000,maxBytes:1_000_000},{sensitivity:'credential-adjacent',ttlMs:1_001},
  ),/ttl-invalid/);
  assert.deepEqual(released,['atomic-artifact']);
  assert.equal(retention.activeCount(),0);
});

test('retained capture surfaces cleanup uncertainty instead of exposing an unleased artifact', async()=>{
  const {atomic,retention}=captureHarness(async()=>{throw new Error('native release failed');});
  await assert.rejects(()=>atomic.captureRetained(
    window,{maxPixels:1_000_000,maxBytes:1_000_000},{sensitivity:'credential-adjacent',ttlMs:1_001},
  ),/acquire-cleanup-uncertain/);
  assert.equal(retention.activeCount(),0);
});

test('successful retained capture returns frame and active lease as one transaction', async()=>{
  const released:string[]=[];
  const {atomic,retention}=captureHarness(async token=>{released.push(token);});
  const result=await atomic.captureRetained(
    window,{maxPixels:1_000_000,maxBytes:1_000_000},{sensitivity:'sensitive-field',ttlMs:5_000},
  );
  assert.equal(result.observation.artifact.token,'atomic-artifact');
  assert.equal(result.lease.token,'atomic-artifact');
  assert.equal(retention.activeCount(),1);
  assert.deepEqual(released,[]);
  await retention.release(result.lease);
  assert.deepEqual(released,['atomic-artifact']);
});
