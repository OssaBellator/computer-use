import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsGraphicsCaptureRuntime } from '../src/computer/windowsGraphicsCaptureRuntime.js';
import type { WindowsUiaWindowRef } from '../src/computer/windowsUiaContract.js';

const windowRef:WindowsUiaWindowRef = Object.freeze({
  hwnd:'0x444',desktopSessionId:'interactive:1',process:Object.freeze({processId:444,startIdentity:'start-444'}),generation:3,
});
const limits = Object.freeze({maxPixels:2_000_000,maxBytes:1_000_000});
const geometry = Object.freeze({left:10,top:20,width:800,height:600,dpi:144});

function nativeFrame(sequence:number,captureGeneration=1) {
  return {
    window:windowRef,captureGeneration,frameSequence:sequence,capturedAtMs:100+sequence,
    systemRelativeTime100ns:10_000+sequence,contentWidth:800,contentHeight:600,geometry,
    artifact:{token:`frame-${captureGeneration}-${sequence}`,mediaType:'image/png',byteLength:20_000},
  } as const;
}

test('WGC runtime generation-binds bounded HWND frame metadata', async () => {
  const released:string[] = [];
  const runtime = new WindowsGraphicsCaptureRuntime({
    captureNextFrame:async()=>nativeFrame(1),
    releaseArtifact:async(token)=>{released.push(token);},
  });
  const observation = await runtime.capture(windowRef,limits);
  assert.equal(observation.frame.window.hwnd,'0x444');
  assert.equal(observation.frame.frameSequence,1);
  assert.equal(observation.frame.geometry.dpi,144);
  assert.equal(observation.artifact.byteLength,20_000);
  await runtime.release(observation);
  assert.deepEqual(released,['frame-1-1']);
});

test('WGC runtime rejects frame sequence regression within one capture generation', async () => {
  let call = 0;
  const runtime = new WindowsGraphicsCaptureRuntime({
    captureNextFrame:async()=>nativeFrame(call++ === 0 ? 2 : 2),
    releaseArtifact:async()=>undefined,
  });
  await runtime.capture(windowRef,limits);
  await assert.rejects(()=>runtime.capture(windowRef,limits),/frame-sequence-not-increasing/);
});

test('WGC runtime permits sequence reset only when capture generation increases', async () => {
  let call = 0;
  const runtime = new WindowsGraphicsCaptureRuntime({
    captureNextFrame:async()=>call++ === 0 ? nativeFrame(9,2) : nativeFrame(1,3),
    releaseArtifact:async()=>undefined,
  });
  await runtime.capture(windowRef,limits);
  const next = await runtime.capture(windowRef,limits);
  assert.equal(next.frame.captureGeneration,3);
  assert.equal(next.frame.frameSequence,1);
});

test('WGC runtime rejects window replacement and oversized artifacts before grounding', async () => {
  const replacement = {...windowRef,generation:4};
  const mismatch = new WindowsGraphicsCaptureRuntime({
    captureNextFrame:async()=>({...nativeFrame(1),window:replacement}),
    releaseArtifact:async()=>undefined,
  });
  await assert.rejects(()=>mismatch.capture(windowRef,limits),/window-mismatch/);

  const oversized = new WindowsGraphicsCaptureRuntime({
    captureNextFrame:async()=>({...nativeFrame(1),artifact:{token:'too-big',mediaType:'image/png',byteLength:1_000_001}}),
    releaseArtifact:async()=>undefined,
  });
  await assert.rejects(()=>oversized.capture(windowRef,limits),/artifact-invalid/);
});
