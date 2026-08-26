import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsVisualArtifactRetentionManager } from '../src/computer/windowsVisualArtifactRetention.js';
import type { WindowsGraphicsCaptureObservation } from '../src/computer/windowsGraphicsCaptureRuntime.js';

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
